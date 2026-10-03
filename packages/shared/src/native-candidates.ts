import { nativeCandidateInfoSchema, type ChatMessage, type NativeCandidateInfo } from "./runtime.js";

export const NATIVE_CANDIDATE_INFO_KEY = "__mycompanion_native_candidate";
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
export function hasNativeCandidateHistory(extensionData: Record<string, unknown> | undefined): boolean {
  return Object.hasOwn(record(extensionData?.extra), NATIVE_CANDIDATE_INFO_KEY)
    || Array.isArray(extensionData?.swipe_info) && extensionData.swipe_info.some(info =>
      Object.hasOwn(record(record(info).extra), NATIVE_CANDIDATE_INFO_KEY));
}
/** The public swipe slot is not the provider's possibly sparse choice index. */
export function readNativeCandidateInfo(extensionData: Record<string, unknown> | undefined): NativeCandidateInfo | undefined {
  const selected = extensionData?.swipe_id;
  if (typeof selected !== "number" || !Number.isSafeInteger(selected) || selected < 0 || !Array.isArray(extensionData?.swipe_info)) return undefined;
  const raw = record(record(extensionData.swipe_info[selected]).extra)[NATIVE_CANDIDATE_INFO_KEY];
  const parsed = nativeCandidateInfoSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
type Projection = Pick<ChatMessage, "content" | "status" | "generationMetadata" | "extensionData">;
/** Request billing/tool audit stays host-owned. Only the selected candidate's
 * validated display state is projected; edits cannot replay its old signatures. */
export function projectNativeCandidateMessage<T extends Projection>(message: T): T {
  if (!message.generationMetadata || !message.generationMetadata.nativeCandidates && !hasNativeCandidateHistory(message.extensionData)) return message;
  const generation = { ...message.generationMetadata };
  delete generation.responseState; delete generation.finishReason; delete generation.completionOutcome;
  const info = readNativeCandidateInfo(message.extensionData);
  if (!info || info.originalContent !== message.content) return { ...message, generationMetadata: generation };
  generation.responseState = structuredClone(info.responseState);
  if (info.finishReason !== undefined) generation.finishReason = info.finishReason;
  if (info.completionOutcome !== undefined) generation.completionOutcome = info.completionOutcome;
  return { ...message, status: info.status, generationMetadata: generation };
}
export function canReplayNativeCandidateTools(message: Projection): boolean {
  if (!message.generationMetadata?.nativeCandidates && !hasNativeCandidateHistory(message.extensionData)) return true;
  const info = readNativeCandidateInfo(message.extensionData);
  return !!info && info.index === 0 && info.originalContent === message.content;
}
