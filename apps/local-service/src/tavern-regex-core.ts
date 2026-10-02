export interface TavernRegexScript {
  findRegex?: string; replaceString?: string; trimStrings?: string[]; placement?: unknown[];
  disabled?: boolean; markdownOnly?: boolean; promptOnly?: boolean; runOnEdit?: boolean;
  minDepth?: number | null; maxDepth?: number | null; substituteRegex?: number;
  [key: string]: unknown;
}
export interface TavernRegexOptions {
  isMarkdown?: boolean; isPrompt?: boolean; isEdit?: boolean; depth?: number; characterOverride?: string;
}
export type TavernRegexSubstitute = (text: string, escape?: (value: string) => string, characterOverride?: string) => string;
export interface TavernRegexMatch {
  start: number; end: number; captures: Array<string | undefined>; named?: Record<string, string | undefined>;
}

// Self-contained factory: exactly this implementation runs in the browser and
// the native service worker. No upstream engine or extension source is loaded.
export function createTavernRegexEngine(substitute: TavernRegexSubstitute) {
  const regex_placement = { MD_DISPLAY: 0, USER_INPUT: 1, AI_OUTPUT: 2, SLASH_COMMAND: 3, WORLD_INFO: 5, REASONING: 6 };
  const substitute_find_regex = { NONE: 0, RAW: 1, ESCAPED: 2 };
  class RegexProvider {
    static instance = new RegexProvider();
    private cache = new Map<string, RegExp>();
    get(value: string): RegExp | null {
      let regex = this.cache.get(value);
      if (!regex) {
        if (typeof value !== "string" || !value) return null;
        const literal = value.match(/^\/([\s\S]*)\/([a-z]*)$/i);
        try { regex = literal ? new RegExp(literal[1]!, literal[2]) : new RegExp(value); }
        catch { return null; }
      }
      this.cache.delete(value); this.cache.set(value, regex);
      if (this.cache.size > 1000) this.cache.delete(this.cache.keys().next().value!);
      regex.lastIndex = 0;
      return regex;
    }
    clear(): void { this.cache.clear(); }
  }
  const escapeMacro = (value: string) => value.replace(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/g, token => {
    const controls: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t", "\v": "\\v", "\f": "\\f", "\0": "\\0" };
    return controls[token] ?? "\\" + token;
  });
  function prepareRegexSource(script: TavernRegexScript): string {
    const mode = Number(script.substituteRegex);
    return mode === 1 || mode === 2 ? substitute(script.findRegex!, mode === 2 ? escapeMacro : undefined) : script.findRegex!;
  }
  function captureMatch(args: unknown[]): TavernRegexMatch {
    const last = args.at(-1), named = last && typeof last === "object" ? last as Record<string, string | undefined> : undefined;
    const start = args[args.length - (named ? 3 : 2)] as number;
    const captures = args.slice(0, args.length - (named ? 3 : 2)).map(value => typeof value === "string" ? value : undefined);
    return { start, end: start + captures[0]!.length, captures, ...(named ? { named } : {}) };
  }
  /** Only matching belongs in the worker; each actual replacement owns its macro calls. */
  function planMatches(text: string, source: string): TavernRegexMatch[] {
    const regex = RegexProvider.instance.get(source), matches: TavernRegexMatch[] = [];
    if (regex) text.replace(regex, (...args: unknown[]) => { matches.push(captureMatch(args)); return args[0] as string; });
    return matches;
  }
  function replaceMatch(script: TavernRegexScript, match: TavernRegexMatch, options: TavernRegexOptions = {}): string {
    const replacement = String(script.replaceString ?? "").replace(/{{match}}/gi, "$0").replace(/\$(\d+)|\$<([^>]+)>/g, (_token, index: string, name: string) => {
      const value = index !== undefined ? match.captures[Number(index)] : match.named?.[name];
      let capture = typeof value === "string" ? value : "";
      if (!capture) return "";
      for (const trim of script.trimStrings ?? []) capture = capture.replaceAll(substitute(trim, undefined, options.characterOverride), "");
      return capture;
    });
    return substitute(replacement);
  }
  function runRegexScript(script: TavernRegexScript, text: string, options: TavernRegexOptions = {}): string {
    if (!script || script.disabled || !script.findRegex || !text) return text;
    const regex = RegexProvider.instance.get(prepareRegexSource(script));
    if (!regex) return text;
    return text.replace(regex, (...args: unknown[]) => replaceMatch(script, captureMatch(args), options));
  }
  function applies(script: TavernRegexScript, placement: number, options: TavernRegexOptions): boolean {
    if (!script || script.disabled || !Array.isArray(script.placement) || !script.placement.includes(placement)) return false;
    if (options.isEdit && !script.runOnEdit) return false;
    if (!(script.markdownOnly && options.isMarkdown) && !(script.promptOnly && options.isPrompt)
      && (script.markdownOnly || script.promptOnly || options.isMarkdown || options.isPrompt)) return false;
    if (typeof options.depth === "number") {
      if (script.minDepth != null && script.minDepth >= -1 && options.depth < script.minDepth) return false;
      if (script.maxDepth != null && script.maxDepth >= 0 && options.depth > script.maxDepth) return false;
    }
    return true;
  }
  function getRegexedString(text: unknown, placement: number, scripts: TavernRegexScript[], options: TavernRegexOptions = {}): string {
    if (typeof text !== "string") return "";
    return scripts.reduce((value, script) => applies(script, placement, options) ? runRegexScript(script, value, options) : value, text);
  }
  return { regex_placement, substitute_find_regex, RegexProvider, runRegexScript, getRegexedString, applies,
    prepareRegexSource, planMatches, replaceMatch };
}
