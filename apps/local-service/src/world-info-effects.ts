import { createHash } from "node:crypto";
import type { ChatMessage, LorebookReport } from "@mycompanion/shared";
import type { RuntimeRepository } from "./runtime-repository.js";

/** Stored in existing chat metadata, so backup/restore includes every branch. */
export const WORLD_INFO_STATE_KEY = "__mycompanion_world_info_state";
export interface WorldInfoCheckpoint {
  branchId: string;
  sourceCount: number;
  sourceFingerprint: string;
  timedWorldInfo: Record<string, unknown>;
}
interface WorldInfoState { version: 1; revision: number; activeBranchId: string; checkpoints: WorldInfoCheckpoint[] }
export interface WorldInfoEffectsDraft {
  before: string;
  branchId: string;
  sources: string[];
  messageCount: number;
  state: WorldInfoState;
  timedWorldInfo: Record<string, unknown>;
  hadTimedEffects: boolean;
}
const effects = new WeakMap<LorebookReport, WorldInfoEffectsDraft>();
const committed = new WeakMap<LorebookReport, string>();
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hasTimedEffects = (value: unknown): boolean =>
  Object.values(record(value)).some(effect => Object.keys(record(effect)).length > 0);
function prefixFingerprints(sources: string[]): string[] {
  const result = [hash([])];
  for (const source of sources) result.push(hash([result.at(-1), source]));
  return result;
}

export function worldInfoStateRevision(metadata: Record<string, unknown>): string {
  return hash([metadata[WORLD_INFO_STATE_KEY] ?? null, metadata.timedWorldInfo ?? null]);
}
export function worldInfoSourceKeys(messages: ChatMessage[]): string[] {
  return messages.map(message => hash([message.id, message.role, message.content, message.extensionData?.is_system === true]));
}
export function worldInfoSourcesMatch(prefix: string[], messages: ChatMessage[]): boolean {
  const current = worldInfoSourceKeys(messages);
  return prefix.length <= current.length && prefix.every((value, index) => value === current[index]);
}

/** Build a fresh request draft on every replay. A branch inherits only effects
 * accepted against an unchanged prefix, never effects from its edited suffix. */
export function createWorldInfoEffectsDraft(metadata: Record<string, unknown>, branchId: string, messages: ChatMessage[],
  messageCount = messages.length): WorldInfoEffectsDraft {
  const stored = record(metadata[WORLD_INFO_STATE_KEY]);
  const checkpoints: WorldInfoCheckpoint[] = Array.isArray(stored.checkpoints)
    ? stored.checkpoints.filter((item): item is WorldInfoCheckpoint => {
      const value = record(item);
      return typeof value.branchId === "string" && Number.isInteger(value.sourceCount) && Number(value.sourceCount) >= 0
        && typeof value.sourceFingerprint === "string"
        && value.timedWorldInfo !== null && typeof value.timedWorldInfo === "object" && !Array.isArray(value.timedWorldInfo);
    }).map(value => structuredClone(value)) : [];
  const sources = worldInfoSourceKeys(messages);
  const fingerprints = prefixFingerprints(sources);
  const compatible = checkpoints.filter(point => point.sourceCount <= sources.length && point.sourceFingerprint === fingerprints[point.sourceCount]);
  // Prefer the most advanced valid prefix. At equal depth the current branch's
  // latest accepted scan wins; other branch snapshots still allow prefix forks.
  const selected = compatible.sort((a, b) => a.sourceCount - b.sourceCount
    || Number(a.branchId === branchId) - Number(b.branchId === branchId)).at(-1);
  const latestBranchCheckpoint = checkpoints.filter(point => point.branchId === branchId).at(-1);
  const timedWorldInfo = selected && selected === latestBranchCheckpoint && stored.activeBranchId === branchId ? record(metadata.timedWorldInfo)
    : selected ? selected.timedWorldInfo : stored.version === 1 ? {} : record(metadata.timedWorldInfo);
  return { before: worldInfoStateRevision(metadata), branchId, sources, messageCount,
    state: { version: 1, revision: typeof stored.revision === "number" ? stored.revision : 0, activeBranchId: branchId, checkpoints },
    timedWorldInfo: structuredClone(timedWorldInfo),
    hadTimedEffects: hasTimedEffects(metadata.timedWorldInfo) || checkpoints.some(point => hasTimedEffects(point.timedWorldInfo)) };
}
export function attachWorldInfoEffects(report: LorebookReport, draft: WorldInfoEffectsDraft): void {
  // Upstream normalizes empty timer containers while scanning. This has no
  // durable effect until a real timer exists. Keep cleanup/branch checkpoints
  // for existing effects, including the scan that clears their last timer.
  if (draft.hadTimedEffects || hasTimedEffects(draft.timedWorldInfo)) effects.set(report, draft);
}
export function getWorldInfoEffects(report: LorebookReport): WorldInfoEffectsDraft | undefined { return effects.get(report); }
export function transferWorldInfoEffects(from: LorebookReport, to: LorebookReport): void {
  const draft = effects.get(from); if (draft) effects.set(to, draft);
}
export function getCommittedWorldInfoState(runtime: RuntimeRepository, conversationId: string,
  report?: LorebookReport): Record<string, unknown> | undefined {
  const metadata = runtime.getConversation(conversationId)?.chatMetadata;
  if (!metadata || !Object.hasOwn(metadata, WORLD_INFO_STATE_KEY)) return undefined;
  if (report && committed.get(report) !== worldInfoStateRevision(metadata)) return undefined;
  return structuredClone({ timedWorldInfo: metadata.timedWorldInfo, [WORLD_INFO_STATE_KEY]: metadata[WORLD_INFO_STATE_KEY] });
}
/** Caller owns the transaction accepting the request/assistant placeholder. */
export function commitWorldInfoEffects(runtime: RuntimeRepository, conversationId: string, targetBranchId: string, report: LorebookReport): void {
  const draft = effects.get(report); if (!draft) return;
  const state = structuredClone(draft.state);
  const checkpoint: WorldInfoCheckpoint = { branchId: targetBranchId, sourceCount: draft.sources.length,
    sourceFingerprint: prefixFingerprints(draft.sources).at(-1)!, timedWorldInfo: draft.timedWorldInfo };
  const existing = state.checkpoints.findIndex(point => point.branchId === targetBranchId
    && point.sourceCount === checkpoint.sourceCount && point.sourceFingerprint === checkpoint.sourceFingerprint);
  if (existing >= 0) state.checkpoints.splice(existing, 1);
  state.checkpoints.push(checkpoint); state.revision++; state.activeBranchId = targetBranchId;
  runtime.commitWorldInfoState(conversationId, targetBranchId, draft.before,
    { timedWorldInfo: draft.timedWorldInfo, [WORLD_INFO_STATE_KEY]: state }, draft.sources);
  committed.set(report, worldInfoStateRevision({ timedWorldInfo: draft.timedWorldInfo, [WORLD_INFO_STATE_KEY]: state }));
}
