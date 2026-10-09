import { createHash } from "node:crypto";
import type { ChatMessage } from "@mycompanion/shared";

/** 消息内容指纹与摘要资格过滤：记忆可达性（FR-MEM-008）与阶段摘要（FR-MEM-006）共用。 */
export function messageFingerprint(message: ChatMessage): string {
  return createHash("sha256").update(JSON.stringify([message.id, message.role, message.content, message.status,
    message.generationMetadata?.completionOutcome ?? null])).digest("hex");
}

export function sourceFingerprint(messages: ChatMessage[]): string {
  return createHash("sha256").update(JSON.stringify(messages.map(message => messageFingerprint(message)))).digest("hex");
}

export function summaryMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(message => message.status === "complete" && message.content.trim()
    && (!message.generationMetadata?.completionOutcome || message.generationMetadata.completionOutcome === "complete"));
}
