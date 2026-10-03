import { worldInfoSettingsSchema, type CharacterLorebookEntry, type LorebookEntryResult, type LorebookReport } from "@mycompanion/shared";
import { MacroEvaluationSession } from "./prompt-macros.js";
import { countTextTokens } from "./tokenizer-service.js";
import { createWorldInfoRuntime } from "./world-info-upstream-runtime.js";
import { attachWorldInfoEffects, type WorldInfoEffectsDraft } from "./world-info-effects.js";
import { attachWorldInfoActivations } from "./world-info-activation.js";
import { encodeWorldInfoGraph, decodeWorldInfoGraph, type WorldInfoGraph } from "./world-info-event-graph.js";
export { parseRegexFromString as parseWorldInfoRegex } from "@mycompanion/shared";

export const LOREBOOK_TOKEN_BUDGET = 500;
export const estimateTokens = countTextTokens;
export interface WorldInfoScanOptions {
  macroSession?: MacroEvaluationSession;
  experimentalMacroEngine?: boolean;
  /** Most recent message first, as in getWorldInfoPrompt. */
  messages?: string[];
  scanDepth?: number;
  recursive?: boolean;
  maxRecursionSteps?: number;
  minActivations?: number;
  minActivationsDepthMax?: number;
  useGroupScoring?: boolean;
  caseSensitive?: boolean;
  matchWholeWords?: boolean;
  preservePriority?: boolean;
  random?: () => number;
  userName?: string;
  globalScanData?: Record<string, string>;
  extensionScanText?: string;
  model?: string;
  contextLimitTokens?: number;
  maxResponseTokens?: number;
  localVariables?: Record<string, unknown>;
  globalVariables?: Record<string, unknown>;
  /** Diagnostic/test calls default to previews without cross-turn effects. */
  dryRun?: boolean;
  trigger?: string;
  characterFilename?: string;
  characterTagIds?: string[];
  effectsDraft?: WorldInfoEffectsDraft;
  forcedEntries?: ScanEntry[];
}
const numeric = (value: unknown, fallback: number): number => typeof value === "number" && Number.isFinite(value) ? value : fallback;
function explainReason(reason: string): string {
  if (reason === "has no keys defined, skipped") return "没有主关键词，条目不会被触发。";
  if (reason === "suppressed by delay") return "尚未达到条目延迟的消息数量。";
  if (reason === "suppressed by cooldown") return "条目仍在冷却期间。";
  if (reason.startsWith("suppressed by delay until recursion")) return "尚未达到条目指定的递归扫描阶段。";
  if (reason === "suppressed by exclude recursion") return "条目排除了递归扫描。";
  if (reason.includes("generation type trigger filter")) return "条目未启用当前生成类型。";
  if (reason === "filtered out by character" || reason === "filtered out by tag") return "条目被角色或标签过滤条件排除。";
  if (reason === "suppressed by @@dont_activate decorator") return "条目由 @@dont_activate 标记停用。";
  if (reason === "skipped. Secondary keywords not satisfied") return "次关键词条件未满足。";
  return reason;
}
export interface ScanEntry extends Record<string, unknown> {
  world: string; uid: string | number; hash: number; content: string; key: string[];
  order: number; disable: boolean; constant: boolean; decorators: string[];
}
export function normalizeWorldInfoEntries(entries: CharacterLorebookEntry[], characterId: string): ScanEntry[] {
  const runtime=createWorldInfoRuntime({settings:{},metadata:{}});
  return entries.map(entry=>{
    const extra=entry.worldInfo??{},[decorators,content]=runtime.parseDecorators(entry.content);
    const raw={...extra,world:typeof extra.world==="string"?extra.world:`__character:${characterId}`,
      uid:typeof extra.uid==="number"||typeof extra.uid==="string"?extra.uid:entry.index,
      key:entry.keys,keysecondary:entry.secondaryKeys,content,decorators,disable:!entry.enabled,constant:entry.constant,selective:entry.selective,order:entry.insertionOrder,
      caseSensitive:typeof extra.caseSensitive==="boolean"?extra.caseSensitive:entry.caseSensitive?true:null,selectiveLogic:numeric(extra.selectiveLogic,0),
      useProbability:extra.useProbability??true,probability:numeric(extra.probability,100),position:numeric(extra.position,1)};
    return {...raw,hash:runtime.getStringHash(JSON.stringify(raw))} as ScanEntry;
  });
}

/** Native boundary around the fixed-upstream scanner. It owns no durable state. */
export function matchLorebookEntries(characterId: string, entries: CharacterLorebookEntry[], characterName: string,
  scanText: string, budgetTokens = LOREBOOK_TOKEN_BUDGET, options: WorldInfoScanOptions = {}): LorebookReport {
  const start = Date.now();
  const session = options.macroSession ?? new MacroEvaluationSession({ variables: options.localVariables ?? {} },
    { variables: { global: options.globalVariables ?? {} } });
  const macroContext = { characterName, userName: options.userName ?? "User", experimentalMacroEngine: options.experimentalMacroEngine ?? false,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.contextLimitTokens === undefined ? {} : { contextLimitTokens: options.contextLimitTokens }),
    ...(options.maxResponseTokens === undefined ? {} : { maxResponseTokens: options.maxResponseTokens }) };
  const priority = options.preservePriority ? entries : [...entries].sort((a, b) => b.insertionOrder - a.insertionOrder);
  const normalized: ScanEntry[] = [], originals = new Map<ScanEntry, CharacterLorebookEntry>();
  const matched = new Map<ScanEntry, string>(), reasons = new Map<ScanEntry, string>();
  const metadata = { timedWorldInfo: structuredClone(options.effectsDraft?.timedWorldInfo ?? {}) };
  const messages = options.messages ?? [scanText];
  const scope = session.createEffectScope(), graphObjects: object[] = [];
  const settings = worldInfoSettingsSchema.parse({ world_info_depth: options.scanDepth ?? 2,
    world_info_recursive: options.recursive ?? false, world_info_max_recursion_steps: options.maxRecursionSteps ?? 0,
    world_info_min_activations: options.minActivations ?? 0, world_info_min_activations_depth_max: options.minActivationsDepthMax ?? 0,
    world_info_use_group_scoring: options.useGroupScoring ?? false,
    world_info_case_sensitive: options.caseSensitive ?? false, world_info_match_whole_words: options.matchWholeWords ?? false });
  const runtime = createWorldInfoRuntime({
    entries: normalized, metadata, budget: budgetTokens,
    settings,
    context: { extensionPrompts: options.extensionScanText ? { native: { scan: true, value: options.extensionScanText } } : {},
      tagMap: options.characterTagIds === undefined ? {} : { character: options.characterTagIds } },
    characterFilename: options.characterFilename ?? characterId, characterTagKey: options.characterTagIds === undefined ? undefined : "character",
    ...(options.effectsDraft ? { timedChat: Array(options.effectsDraft.messageCount).fill("") } : {}),
    random: () => session.drawRandom(options.random),
    countTokens: (value: string) => estimateTokens(value, options.model),
    substitute: (value: string) => session.evaluate(value, macroContext),
    onMatched: (entry: ScanEntry, key: string) => matched.set(entry, key),
    onDecision: (entry: ScanEntry, reason: string) => reasons.set(entry, reason),
    onGroupRemoved: (entry: ScanEntry) => reasons.set(entry, "未被互斥分组选中。"),
    onScan: (args: Record<string, any>) => {
      const { timedEffects, ...eventArgs } = args;
      const response = session.invokeEffect("world-info-scan", { scope, settings, context: macroContext,
        graph: encodeWorldInfoGraph({ args: eventArgs, metadata, timedState: timedEffects.__snapshotForBridge(),
          externalActivations: runtime.WorldInfoBuffer.externalActivations }, graphObjects) }) as { graph?: WorldInfoGraph } | undefined;
      if (response?.graph) {
        const changed = decodeWorldInfoGraph(response.graph, graphObjects);
        Object.assign(args, changed.args); timedEffects.__restoreForBridge(changed.timedState);
        runtime.WorldInfoBuffer.externalActivations = changed.externalActivations;
      }
    },
  });
  normalizeWorldInfoEntries(priority,characterId).forEach((scanEntry,index)=>{normalized.push(scanEntry);originals.set(scanEntry,priority[index]!);});
  const initialNormalized = [...normalized];
  for(const raw of options.forcedEntries??[])runtime.WorldInfoBuffer.externalActivations.set(`${raw.world}.${raw.uid}`,raw);
  const forced = session.invokeEffect("world-info-start", { scope }) as { graph?: WorldInfoGraph } | undefined;
  if (forced?.graph) for(const [key,value] of decodeWorldInfoGraph(forced.graph, graphObjects).externalActivations)runtime.WorldInfoBuffer.externalActivations.set(key,value);
  const scanned = runtime.scan(messages, options.contextLimitTokens ?? 2048, options.dryRun !== false,
    { ...(options.globalScanData ?? (options.trigger === undefined ? { trigger: "normal" } : {})),
      ...(options.trigger === undefined ? {} : { trigger: options.trigger }) });
  // The upstream empty-book fast path does not reset force activation state.
  if (initialNormalized.length) session.invokeEffect("world-info-end", { scope });
  const accepted = new Set<ScanEntry>(scanned.activated.values());
  const originalsByKey = new Map(initialNormalized.map(entry => [`${entry.world}.${entry.uid}`, originals.get(entry)!]));
  const resultIndices = new Map<ScanEntry, number>();
  const projected = new Map<number, ScanEntry>();
  for (const raw of initialNormalized) { const index = originals.get(raw)!.index; projected.set(index, raw); resultIndices.set(raw, index); }
  let nextIndex = entries.reduce((maximum, entry) => Math.max(maximum, entry.index + 1), 0);
  for (const raw of accepted) {
    const original = originals.get(raw) ?? originalsByKey.get(`${raw.world}.${raw.uid}`);
    const index = original?.index ?? nextIndex++;
    if (original) originals.set(raw, original);
    projected.set(index, raw); resultIndices.set(raw, index);
  }
  const results = new Map<number, LorebookEntryResult>();
  for (const [index, scanEntry] of projected) {
    const entry = originals.get(scanEntry);
    const enabled = scanEntry.disable !== true, constant = scanEntry.constant === true;
    const injected = accepted.has(scanEntry), dropped = scanned.budgetDropped.has(scanEntry);
    const diagnostics: string[] = !enabled ? ["运行时未启用。"] : dropped ? [`超出 ${budgetTokens} token 世界书预算。`]
      : scanned.failedProbabilityChecks.has(scanEntry) ? ["概率检查未通过。"]
      : !injected && reasons.has(scanEntry) ? [explainReason(reasons.get(scanEntry)!)]
      : !injected && !constant && !scanEntry.key?.length ? ["没有主关键词，条目不会被触发。"] : [];
    results.set(index, { index, name: entry?.name ?? String(scanEntry.comment ?? `${scanEntry.world} #${scanEntry.uid}`),
      status: !enabled ? "disabled" : injected ? "injected" : dropped ? "budget_dropped" : "no_match",
      matchedKey: injected ? matched.get(scanEntry) ?? null : null,
      tokens: estimateTokens(scanEntry.content, options.model),
      content: injected ? scanEntry.content : "", diagnostics, constant,
      insertionOrder: numeric(scanEntry.order, 100), position: numeric(scanEntry.position, 1), depth: numeric(scanEntry.depth, 4), role: numeric(scanEntry.role, 0),
      world: scanEntry.world, uid: scanEntry.uid,
      ...(typeof scanEntry.outletName === "string" ? { outletName: scanEntry.outletName } : {}) });
  }
  const kept = [...results.values()].filter(result => result.status === "injected")
    .sort((a, b) => (a.insertionOrder ?? 0) - (b.insertionOrder ?? 0));
  const sourceIndices = new Set(entries.map(entry => entry.index));
  const report: LorebookReport = { characterId, results: [...entries.map(entry => results.get(entry.index)!),
    ...[...results.values()].filter(entry => !sourceIndices.has(entry.index))],
    block: kept.map(result => result.content).filter(Boolean).join("\n\n"),
    constantBlock: kept.filter(result => result.constant).map(result => result.content).filter(Boolean).join("\n\n"),
    position: "after_character_core", budgetTokens, injectedCount: kept.length, durationMs: Date.now() - start };
  if (options.effectsDraft && options.dryRun === false) attachWorldInfoEffects(report, { ...options.effectsDraft,
    timedWorldInfo: metadata.timedWorldInfo });
  attachWorldInfoActivations(report, [...scanned.activated.values()].map((entry: ScanEntry) => ({ resultIndex: resultIndices.get(entry)!, entry })));
  return report;
}
