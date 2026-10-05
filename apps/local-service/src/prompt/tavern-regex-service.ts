import { Worker } from "node:worker_threads";
import type { CharacterDetail } from "@mycompanion/shared";
import { createTavernRegexEngine, type TavernRegexMatch, type TavernRegexOptions, type TavernRegexScript, type TavernRegexSubstitute } from "./tavern-regex-core.js";

export interface TavernRegexExecutionOptions extends TavernRegexOptions {
  /** The caller's macro session owns variables and environment for this invocation. */
  substitute?: TavernRegexSubstitute;
}

export function collectNativeRegexScripts(settings: Record<string, unknown>, character: CharacterDetail): TavernRegexScript[] {
  if (Array.isArray(settings.disabledExtensions) && settings.disabledExtensions.includes("regex")) return [];
  const global = Array.isArray(settings.regex) ? settings.regex : [];
  const stored = settings.__mycompanion_openai as {settings?: {preset_settings_openai?: string; extensions?: {regex_scripts?: unknown}}} | undefined;
  const presetNames = settings.preset_allowed_regex as Record<string, string[]> | undefined;
  const preset = presetNames?.openai?.includes(stored?.settings?.preset_settings_openai ?? "") && stored?.settings?.extensions?.regex_scripts;
  // Existing local per-rule switches remain valid until the scope switch is
  // explicitly set. Extension-selected scopes use the same avatar allowlist.
  const scoped = !Array.isArray(settings.character_allowed_regex) || settings.character_allowed_regex.includes(character.avatar ?? `${character.id}.png`);
  return [...global, ...(Array.isArray(preset) ? preset : []), ...(scoped ? character.regexEnabled : [])].filter(value => value && typeof value === "object");
}

const workerSource = `import {parentPort} from 'node:worker_threads';
const createEngine=${createTavernRegexEngine.toString()};
const engine=createEngine(value=>value);
parentPort.on('message',({text,source})=>{
 try{
  parentPort.postMessage({matches:engine.planMatches(text,source)});
 }catch(error){parentPort.postMessage({error:String(error.message||error)});}
});`;

/** Keep arbitrary JS regex work off the service event loop. Unlike the legacy
 * diagnostic tester, actual execution has no fixed time/size skip thresholds.
 * Cancellation/service shutdown terminates the worker, including backtracking. */
export class TavernRegexExecutor {
  private tasks = new Set<(reason: Error) => void>();
  private closed = false;
  run(text: string, placement: number, scripts: TavernRegexScript[], characterName: string,
    options: TavernRegexExecutionOptions = {}, signal?: AbortSignal, userName = "User"): Promise<string> {
    if (this.closed) return Promise.reject(new Error("Regex executor is closed"));
    signal?.throwIfAborted();
    const core = createTavernRegexEngine(options.substitute ?? ((value, escape = value => value, override) => String(value)
      .replace(/{{\s*(char|user)\s*}}/gi, (_match, key: string) => escape(key.toLowerCase() === "char" ? override ?? characterName : userName))));
    if (!text || !scripts.some(script => core.applies(script, placement, options))) return Promise.resolve(text);
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL("data:text/javascript," + encodeURIComponent(workerSource)));
      let settled = false;
      let pending: { resolve: (matches: TavernRegexMatch[]) => void; reject: (error: Error) => void } | undefined;
      const finish = (error?: Error, value?: string) => {
        if (settled) return; settled = true;
        this.tasks.delete(cancel); signal?.removeEventListener("abort", aborted);
        if (error) { pending?.reject(error); pending = undefined; }
        void worker.terminate(); if (error) reject(error); else resolve(value!);
      };
      const cancel = (reason: Error) => finish(reason);
      const aborted = () => cancel(signal?.reason ?? new Error("Regex execution cancelled"));
      this.tasks.add(cancel); signal?.addEventListener("abort", aborted, { once: true });
      worker.on("message", (message: {matches?: TavernRegexMatch[]; error?: string}) => {
        if (message.error) { finish(new Error(message.error)); return; }
        const waiting = pending; pending = undefined; waiting?.resolve(message.matches ?? []);
      });
      worker.once("error", error => finish(error));
      worker.once("exit", () => { if (!settled) finish(new Error("Regex worker exited without a result")); });
      const execute = async (): Promise<string> => {
        let value = text;
        for (const script of scripts) {
          signal?.throwIfAborted(); if (this.closed) throw new Error("Regex executor closed");
          if (!value || !core.applies(script, placement, options) || !script.findRegex) continue;
          const source = core.prepareRegexSource(script);
          signal?.throwIfAborted(); if (this.closed) throw new Error("Regex executor closed");
          const matches = await new Promise<TavernRegexMatch[]>((resolve, reject) => {
            pending = { resolve, reject }; worker.postMessage({text: value, source});
          });
          const chunks: string[] = []; let cursor = 0;
          for (const [index, match] of matches.entries()) {
            signal?.throwIfAborted(); if (this.closed) throw new Error("Regex executor closed");
            chunks.push(value.slice(cursor, match.start), core.replaceMatch(script, match, options)); cursor = match.end;
            // Yield without truncating results, so Stop/shutdown can interrupt
            // a long replacement list as well as pathological regex matching.
            if ((index + 1) % 256 === 0) await new Promise<void>(resolve => setImmediate(resolve));
          }
          value = chunks.length ? [...chunks, value.slice(cursor)].join("") : value;
        }
        return value;
      };
      if (signal?.aborted) aborted(); else void execute().then(value => finish(undefined, value), error => finish(error instanceof Error ? error : new Error(String(error))));
    });
  }
  close(): void { this.closed = true; for (const cancel of [...this.tasks]) cancel(new Error("Regex executor closed")); }
}
