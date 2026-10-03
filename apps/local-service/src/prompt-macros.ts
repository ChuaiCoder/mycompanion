/**
 * 提示词基础宏（FR-PROMPT-001）。
 *
 * 支持的宏（大小写不敏感）：
 * - {{char}} / {{user}}：角色名与玩家名；
 * - {{date}} / {{time}} / {{weekday}}：本地化日期、时间与星期；
 * - {{isodate}} / {{isotime}}：本地时区的固定数字格式；
 * - {{random a|b|c [种子]}}：受种子控制的随机选择。
 *
 * 确定性（FR-PROMPT-001）：{{random}} 由显式种子或默认种子驱动，
 * 同一输入与种子始终选择同一项；{{date}}/{{time}} 以轮内时间为准。
 * 未知宏保持原文，与正则引擎的宏语义一致（FR-REGEX-004）。
 */

import { expandTavernRandom } from "./tavern-random-core.js";
import { tavernTimeValue } from "./tavern-time-core.js";
import { MacroEngine, MacroEnvironmentBuilder, createMacroEnvironment, createVariableStores, createLegacyVariableMacroRules, type VariableStore } from "@mycompanion/macro-engine";
import { createCharacterMacroFieldsLazy, readCharacterMacroFields, type CharacterMacroFields, type CharacterMacroFieldSources } from "@mycompanion/shared";

export interface NativeCharacterMacroEnvironment {
  characterFieldSources?: CharacterMacroFieldSources;
  collapseNewlines?: boolean;
  replaceCharacterCard?: boolean;
  worldInfoOutlets?: Record<string, string>;
}

export interface MacroDraftSnapshot {
  local: Record<string, unknown>; global: Record<string, unknown>;
  resolved: Map<string, string>; characterFields: Map<string, CharacterMacroFields>;
  environment: NativeCharacterMacroEnvironment;
}

// Retain the project's older pipe syntax for saved cards. Tavern's :: and
// comma forms are handled by the shared native/browser parser below.
const RANDOM_MACRO = /\{\{\s*random\s+([^{}]*?)\s*\}\}/gi;

interface MacroContext {
  macroSession?: MacroEvaluationSession;
  experimentalMacroEngine?: boolean;
  characterName: string;
  userName: string;
  model?: string;
  dynamicMacros?: Record<string, string>;
  locale?: string;
  contextLimitTokens?: number;
  maxResponseTokens?: number;
  now: Date;
  // 默认随机种子；同一角色默认使用固定种子，保证同输入同结果。
  seed?: number;
  localVariables?: Record<string, unknown>;
  globalVariables?: Record<string, unknown>;
}

export interface MacroVariableChange {
  scope: "local" | "global";
  key: string;
  beforeExists: boolean;
  afterExists: boolean;
  before?: unknown;
  after?: unknown;
}

/** One request's mutable draft. Persistence is an explicit caller-owned step. */
export class MacroEvaluationSession {
  readonly now = new Date();
  readonly local: Record<string, unknown>;
  readonly global: Record<string, unknown>;
  readonly stores: {local: VariableStore; global: VariableStore};
  readonly #before: {local: Record<string, unknown>; global: Record<string, unknown>};
  readonly #resolved = new Map<string, string>();
  readonly #characterFields = new Map<string, CharacterMacroFields>();
  #characterEnvironment: NativeCharacterMacroEnvironment = {};
  #effectScope = 0;
  constructor(metadata: Record<string, unknown> = {}, settings: Record<string, unknown> = {}) {
    const values = macroVariableStores(metadata, settings);
    this.local = structuredClone(values.localVariables ?? {});
    this.global = structuredClone(values.globalVariables ?? {});
    this.#before = {local: structuredClone(this.local), global: structuredClone(this.global)};
    this.stores = createVariableStores(() => this.local, () => this.global);
  }
  resolve(field: string, text: string, context: Parameters<typeof resolveMacros>[1]): string {
    const key = JSON.stringify([field,text,context.characterName,context.userName,context.model,context.contextLimitTokens,context.maxResponseTokens,context.experimentalMacroEngine,context.dynamicMacros,this.#characterEnvironment.worldInfoOutlets]);
    if (!this.#resolved.has(key)) this.#resolved.set(key, this.evaluate(text, context));
    return this.#resolved.get(key)!;
  }
  /** Only the native first-card stage is shared with WI and prompt assembly. */
  readCharacterFields(key: string, read: () => CharacterMacroFields): CharacterMacroFields {
    if (!this.#characterFields.has(key)) this.#characterFields.set(key, read());
    return this.#characterFields.get(key)!;
  }
  /** Matching expressions are re-evaluated against the current draft each time. */
  drawRandom(source: () => number = Math.random): number { return source(); }
  evaluate(text: string, context: Parameters<typeof resolveMacros>[1]): string {
    return resolveMacros(text, { ...this.#characterEnvironment, ...context, now: this.now,
      localVariables: this.local, globalVariables: this.global, variableStores: this.stores });
  }
  /** Synchronous phases yield through the optional invocation effect boundary. */
  invokeEffect(_kind: string, _payload: unknown): unknown { return undefined; }
  createEffectScope(): string { return String(this.#effectScope++); }
  /** Sources are shared; each evaluation constructs a new eager/lazy field object. */
  bindCharacterEnvironment(environment: NativeCharacterMacroEnvironment): void {
    this.#characterEnvironment = { ...environment,
      ...(environment.worldInfoOutlets === undefined && this.#characterEnvironment.worldInfoOutlets !== undefined
        ? { worldInfoOutlets: this.#characterEnvironment.worldInfoOutlets } : {}) };
  }
  bindWorldInfoOutlets(outlets: Record<string, string>): void {
    this.#characterEnvironment = { ...this.#characterEnvironment, worldInfoOutlets: structuredClone(outlets) };
  }
  snapshotDraft(): MacroDraftSnapshot {
    return { local: structuredClone(this.local), global: structuredClone(this.global), resolved: new Map(this.#resolved),
      characterFields: new Map(this.#characterFields), environment: this.#characterEnvironment };
  }
  restoreDraft(snapshot: MacroDraftSnapshot): void {
    this.replaceVariables(snapshot.local, snapshot.global);
    this.#resolved.clear(); for (const [key, value] of snapshot.resolved) this.#resolved.set(key, value);
    this.#characterFields.clear(); for (const [key, value] of snapshot.characterFields) this.#characterFields.set(key, value);
    this.#characterEnvironment = snapshot.environment;
  }
  replaceVariables(local: Record<string, unknown>, global: Record<string, unknown>): void {
    for (const [target, source] of [[this.local, local], [this.global, global]] as const) {
      for (const key of Object.keys(target)) delete target[key];
      for (const [key, value] of Object.entries(structuredClone(source))) Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
    }
  }
  getCharacterEnvironment(): NativeCharacterMacroEnvironment { return this.#characterEnvironment; }
  /** After an atomic persistence step, subsequent phases report only new edits. */
  checkpointChanges(): void {
    this.#before.local = structuredClone(this.local);
    this.#before.global = structuredClone(this.global);
  }
  changes(): MacroVariableChange[] {
    return (["local", "global"] as const).flatMap(scope => {
      const before = this.#before[scope], after = JSON.parse(JSON.stringify(this[scope])) as Record<string, unknown>;
      return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(key =>
        Object.hasOwn(before,key) === Object.hasOwn(after,key) && JSON.stringify(before[key]) === JSON.stringify(after[key]) ? []
          : [{scope,key,beforeExists:Object.hasOwn(before,key),afterExists:Object.hasOwn(after,key),
            before:Object.hasOwn(before,key)?before[key]:undefined,after:Object.hasOwn(after,key)?after[key]:undefined}]);
    });
  }
}

export function resolveMacroField(text: string, context: Parameters<typeof resolveMacros>[1] & {macroSession?: MacroEvaluationSession}, field: string): string {
  return context.macroSession ? context.macroSession.resolve(field,text,context) : resolveMacros(text,context);
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function macroVariableStores(
  chatMetadata: Record<string, unknown>,
  extensionSettings: Record<string, unknown>,
): Pick<MacroContext, "localVariables" | "globalVariables" | "experimentalMacroEngine"> {
  return {
    localVariables: record(chatMetadata.variables),
    globalVariables: record(record(extensionSettings.variables).global),
    experimentalMacroEngine: record(extensionSettings.__mycompanion_power_user).experimental_macro_engine === true,
  };
}

/** FNV-1a 32 位哈希，把字符串种子规范化成 32 位整数。 */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32：可种子化的伪随机数，返回 [0, 1)。 */
function nextRandom(seed: number): number {
  let state = seed >>> 0;
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function randomOption(options: string[], seed: number): string {
  const fallback = options.find((option) => option.length > 0);
  if (fallback === undefined) return "";
  return options[Math.floor(nextRandom(seed) * options.length) % options.length] ?? fallback;
}

export function resolveMacros(
  text: string,
  context: NativeCharacterMacroEnvironment & {
    variableStores?: {local: VariableStore; global: VariableStore};
    experimentalMacroEngine?: boolean;
    characterName: string;
    userName?: string;
    model?: string;
    dynamicMacros?: Record<string, string>;
    locale?: string;
    contextLimitTokens?: number;
    maxResponseTokens?: number;
    now?: Date;
    seed?: number;
    original?: string;
    /** Applies to each macro replacement, preserving surrounding regex syntax. */
    postProcessFn?: (value: string) => string;
    localVariables?: Record<string, unknown>;
    globalVariables?: Record<string, unknown>;
  },
): string {
  if (!text) return "";
  const post = context.postProcessFn ?? ((value: string) => value);
  const now = context.now ?? new Date();
  const seed = context.seed ?? 42;
  let local: Record<string, unknown> | undefined, global: Record<string, unknown> | undefined;
  const stores = context.variableStores ?? createVariableStores(
    () => local ??= structuredClone(context.localVariables ?? {}),
    () => global ??= structuredClone(context.globalVariables ?? {}));
  const readFields = () => createCharacterMacroFieldsLazy(context.characterFieldSources ?? {}, value => {
    const { original: _original, postProcessFn: _postProcessFn, ...fieldContext } = context;
    let resolved = resolveMacros(value, { ...fieldContext, variableStores: stores, now, replaceCharacterCard: false });
    if (context.collapseNewlines) resolved = resolved.replace(/\n+/g, "\n");
    return resolved.replace(/\r/g, "");
  });
  // Chat Completion formatting follows pinned script.js parseMesExamples. Other
  // completion/instruct protocols bind their own formatter when implemented.
  const parseExamples = (value: string): string[] => {
    if (!value || value === "<START>") return [];
    const source = value.startsWith("<START>") ? value : "<START>\n" + value.trim();
    return source.split(/<START>/gi).slice(1).map(block => "<START>\n" + block.trim() + "\n");
  };
  if (context.experimentalMacroEngine) {
    const user = context.userName ?? "User", char = context.characterName;
    const read = (key: string, global: boolean) => stores[global ? "global" : "local"].get(key);
    const values = {
      names: { user, char, group: char, groupNotMuted: char, notChar: user },
      ...(context.dynamicMacros === undefined ? {} : { dynamicMacros: context.dynamicMacros }),
      extra: {
        model: context.model, maxContext: context.contextLimitTokens, maxResponse: context.maxResponseTokens,
        maxPrompt: context.contextLimitTokens === undefined || context.maxResponseTokens === undefined ? undefined : context.contextLimitTokens - context.maxResponseTokens,
        ...Object.fromEntries(["date", "time", "weekday", "isodate", "isotime"].map(key => [key, () => tavernTimeValue(key, now, context.locale)])),
        readVariable: read,
        variables: stores,
        parseMesExamples: parseExamples,
        isInstruct: false,
        getOutletPrompt: (key: string) => Object.hasOwn(context.worldInfoOutlets ?? {}, key) ? context.worldInfoOutlets![key] : "",
      },
    };
    if (context.characterFieldSources) {
      const builder = new MacroEnvironmentBuilder(() => ({ name1: user, name2: char,
        getGeneratingModel: () => context.model ?? "",
        getCharacterCardFieldsLazy: () => readFields() as unknown as Record<string, unknown> }));
      const environment = builder.buildFromRawEnv({ content: text, ...(context.original === undefined ? {} : { original: context.original }),
        replaceCharacterCard: context.replaceCharacterCard !== false,
        ...(context.dynamicMacros === undefined ? {} : { dynamicMacros: context.dynamicMacros }),
        ...(context.postProcessFn === undefined ? {} : { postProcessFn: context.postProcessFn }) });
      Object.assign(environment.extra, values.extra);
      return MacroEngine.evaluate(text, environment);
    }
    let originalSubstituted = false;
    return MacroEngine.evaluate(text, createMacroEnvironment(text, { ...values,
      functions: { postProcess: post, ...(context.original === undefined ? {} : { original: () => {
        if (originalSubstituted) return "";
        originalSubstituted = true; return context.original!;
      } }) } }));
  }
  const fields = context.characterFieldSources && context.replaceCharacterCard !== false
    ? readCharacterMacroFields(readFields()) : undefined;
  // Tavern runs variable macros before the ordinary environment macros. A
  // variable value containing {{char}} therefore expands in the same pass.
  let result = text;
  for (const rule of createLegacyVariableMacroRules(stores)) result = result.replace(rule.regex, (...args) => post(String(rule.replace(...args))));
  // Match the read-only formatting passes used by the extension document.
  // Resolve them before names so a saved variable can contain these macros.
  result = result
    .replace(/\{\{newline\}\}/gi, () => post("\n"))
    .replace(/(?:\r?\n)*\{\{trim\}\}(?:\r?\n)*/gi, () => post(""))
    .replace(/\{\{noop\}\}/gi, () => post(""));
  // Preserve the original environment's insertion order. Dynamic values
  // override existing fields in place; newly introduced keys run after names.
  // This phase follows variables/noop, so inserted variable macros never run.
  const environment: Record<string, string | (() => string)> = Object.create(null);
  if (typeof context.original === "string") {
    let originalSubstituted = false;
    environment.original = () => {
      if (originalSubstituted) return "";
      originalSubstituted = true; return context.original!;
    };
  }
  if (fields) {
    const cardValues: Record<string, string | (() => string)> = {
      charPrompt: fields.system, charInstruction: fields.jailbreak, charJailbreak: fields.jailbreak,
      description: fields.description, personality: fields.personality, scenario: fields.scenario,
      persona: fields.persona, mesExamples: () => parseExamples(fields.mesExamples).join(""),
      mesExamplesRaw: fields.mesExamples, charVersion: fields.version, char_version: fields.version,
      charDepthPrompt: fields.charDepthPrompt, creatorNotes: fields.creatorNotes,
    };
    Object.assign(environment, cardValues);
  }
  Object.assign(environment, { user: context.userName ?? "User", char: context.characterName,
    group: context.characterName, charIfNotGroup: context.characterName, groupNotMuted: context.characterName,
    notChar: context.userName ?? "User" }, context.model === undefined ? {} : {model: context.model}, context.dynamicMacros);
  for (const [name, value] of Object.entries(environment)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = name === "user" || name === "char" ? "\\{\\{\\s*" + escaped + "\\s*\\}\\}" : "{{" + escaped + "}}";
    result = result.replace(new RegExp(pattern, "gi"), () => post(typeof value === "function" ? value() : value));
  }
  result = result.replace(/\{\{(maxPrompt(?:Tokens)?|maxContext(?:Tokens)?|maxResponse(?:Tokens)?)\}\}/gi,
    (match, kind: string) => {
      if (context.contextLimitTokens === undefined || context.maxResponseTokens === undefined) return match;
      const key = kind.toLowerCase();
      return post(String(key.startsWith("maxprompt") ? context.contextLimitTokens - context.maxResponseTokens
        : key.startsWith("maxcontext") ? context.contextLimitTokens : context.maxResponseTokens));
    });
  result = result.replace(/\{\{(date|time|weekday|isodate|isotime)\}\}/gi,
    (_match, kind: string) => post(tavernTimeValue(kind, now, context.locale)));
  result = result.replace(/{{outlet::(.+?)}}/gi, (_match, key: string) =>
    post(Object.hasOwn(context.worldInfoOutlets ?? {}, key.trim()) ? context.worldInfoOutlets![key.trim()]! : ""));
  result = result.replace(RANDOM_MACRO, (match, body: string) => {
    const trimmed = body.trim();
    if (!trimmed) return match;
    // 末尾的「空格 + 纯数字」段才是显式种子，否则选项文本就是整个 body。
    const lastSpace = trimmed.lastIndexOf(" ");
    const tail = lastSpace >= 0 ? trimmed.slice(lastSpace + 1) : "";
    const hasExplicitSeed = lastSpace >= 0 && /^\d{1,10}$/.test(tail);
    const optionText = hasExplicitSeed ? trimmed.slice(0, lastSpace) : trimmed;
    const effectiveSeed = hasExplicitSeed ? Number(tail) : seed;
    const options = optionText.split("|").map((option) => option.trim());
    return post(randomOption(options, effectiveSeed));
  });
  return expandTavernRandom(result, Math.random, post);
}
