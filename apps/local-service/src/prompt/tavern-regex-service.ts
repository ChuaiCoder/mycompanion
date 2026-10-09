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
 * Cancellation/service shutdown terminates the worker, including backtracking.
 *
 * worker 常驻复用：创建一个 worker 约需 30–50ms，而一次发送要对最多 80 条历史逐条
 * 执行正则阶段，逐条新建会付出秒级启动成本。worker 同一时刻只服务一个任务（串行
 * 队列）；取消、崩溃或关闭时终止并丢弃，由下一个任务惰性重建。 */
export class TavernRegexExecutor {
  private tasks = new Set<(reason: Error) => void>();
  private closed = false;
  private worker: Worker | undefined;
  private busy = false;
  private queue: Array<() => void> = [];
  // 串行队列保证同一时刻只有一个任务在使用 worker；pending 带上 worker 标签，
  // 防止被丢弃的旧 worker 的迟到事件误伤新任务的等待。
  private pending: { worker: Worker; resolve: (matches: TavernRegexMatch[]) => void; reject: (error: Error) => void } | undefined;

  private spawn(): Worker {
    const worker = new Worker(new URL("data:text/javascript," + encodeURIComponent(workerSource)));
    // 常驻空闲的 worker 不应拖住进程退出（应用退出走 close()，unref 只是兜底）。
    worker.unref();
    worker.on("message", (message: {matches?: TavernRegexMatch[]; error?: string}) => {
      const waiting = this.pending;
      if (!waiting || waiting.worker !== worker) return;
      this.pending = undefined;
      if (message.error) waiting.reject(new Error(message.error)); else waiting.resolve(message.matches ?? []);
    });
    const drop = (error: Error) => {
      if (this.worker === worker) this.worker = undefined;
      const waiting = this.pending;
      if (waiting?.worker === worker) { this.pending = undefined; waiting.reject(error); }
    };
    worker.once("error", error => drop(error));
    worker.once("exit", () => drop(new Error("Regex worker exited without a result")));
    this.worker = worker;
    return worker;
  }

  /** 终止并丢弃当前 worker：这是中断失控回溯的唯一手段。 */
  private discard(): void {
    const worker = this.worker;
    this.worker = undefined;
    if (worker) void worker.terminate();
  }

  private pump(): void {
    if (this.busy || this.closed) return;
    this.queue.shift()?.();
  }

  run(text: string, placement: number, scripts: TavernRegexScript[], characterName: string,
    options: TavernRegexExecutionOptions = {}, signal?: AbortSignal, userName = "User"): Promise<string> {
    if (this.closed) return Promise.reject(new Error("Regex executor is closed"));
    signal?.throwIfAborted();
    const core = createTavernRegexEngine(options.substitute ?? ((value, escape = value => value, override) => String(value)
      .replace(/{{\s*(char|user)\s*}}/gi, (_match, key: string) => escape(key.toLowerCase() === "char" ? override ?? characterName : userName))));
    if (!text || !scripts.some(script => core.applies(script, placement, options))) return Promise.resolve(text);
    return new Promise((resolve, reject) => {
      let started = false;
      let settled = false;
      const finish = (error?: Error, value?: string) => {
        if (settled) return; settled = true;
        this.tasks.delete(cancel); signal?.removeEventListener("abort", aborted);
        if (started) { this.busy = false; this.pump(); }
        if (error) reject(error); else resolve(value!);
      };
      const cancel = (reason: Error) => {
        if (settled) return;
        // 运行中：终止 worker（连同失控回溯一起杀掉）；排队中：直接出队。
        if (started) this.discard();
        else this.queue = this.queue.filter(item => item !== begin);
        finish(reason);
      };
      const aborted = () => cancel(signal?.reason ?? new Error("Regex execution cancelled"));
      const begin = () => {
        if (settled) return;
        started = true; this.busy = true;
        const worker = this.worker ?? this.spawn();
        const execute = async (): Promise<string> => {
          let value = text;
          for (const script of scripts) {
            signal?.throwIfAborted(); if (this.closed) throw new Error("Regex executor closed");
            if (!value || !core.applies(script, placement, options) || !script.findRegex) continue;
            const source = core.prepareRegexSource(script);
            signal?.throwIfAborted(); if (this.closed) throw new Error("Regex executor closed");
            const matches = await new Promise<TavernRegexMatch[]>((resolveMatch, rejectMatch) => {
              this.pending = { worker, resolve: resolveMatch, reject: rejectMatch };
              worker.postMessage({text: value, source});
            });
            const chunks: string[] = []; let cursor = 0;
            for (const [index, match] of matches.entries()) {
              signal?.throwIfAborted(); if (this.closed) throw new Error("Regex executor closed");
              chunks.push(value.slice(cursor, match.start), core.replaceMatch(script, match, options)); cursor = match.end;
              // Yield without truncating results, so Stop/shutdown can interrupt
              // a long replacement list as well as pathological regex matching.
              if ((index + 1) % 256 === 0) await new Promise<void>(resolveImmediate => setImmediate(resolveImmediate));
            }
            value = chunks.length ? [...chunks, value.slice(cursor)].join("") : value;
          }
          return value;
        };
        void execute().then(value => finish(undefined, value), error => finish(error instanceof Error ? error : new Error(String(error))));
      };
      this.tasks.add(cancel); signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
      else { this.queue.push(begin); this.pump(); }
    });
  }
  close(): void { this.closed = true; for (const cancel of [...this.tasks]) cancel(new Error("Regex executor closed")); this.discard(); }
}
