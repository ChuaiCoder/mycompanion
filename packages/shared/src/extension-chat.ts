import { z } from "zod";
import type { ChatMessage, ConversationDetail } from "./runtime.js";

// IDs belong to our data model; extension-owned fields retain their original
// shape, including helper variables, swipes, media and future unknown keys.
export const extensionChatMessageSchema = z.object({
  id: z.string().uuid(), mes: z.string(), is_user: z.boolean(),
}).catchall(z.unknown());
export const extensionChatStateSchema = z.object({
  messages: z.array(extensionChatMessageSchema).refine(messages => new Set(messages.map(message => message.id)).size === messages.length, "消息 ID 不能重复。"),
  metadata: z.record(z.string(), z.unknown()),
});
export const extensionChatSaveSchema = z.object({
  branchId: z.string().uuid(), base: extensionChatStateSchema, next: extensionChatStateSchema,
}).strict();
export type ExtensionChatMessage = z.infer<typeof extensionChatMessageSchema>;
export type ExtensionChatState = z.infer<typeof extensionChatStateSchema>;
export type ExtensionChatSave = z.infer<typeof extensionChatSaveSchema>;

export function toExtensionMessage(message: ChatMessage, characterName: string): ExtensionChatMessage {
  return {
    name: message.role === "user" ? "User" : characterName,
    is_system: false, send_date: message.createdAt, extra: {},
    ...message.extensionData,
    id: message.id, mes: message.content, is_user: message.role === "user",
    role: message.role, content: message.content, status: message.status,
  };
}
export function toExtensionChatState(conversation: ConversationDetail): ExtensionChatState {
  return JSON.parse(JSON.stringify({ metadata: conversation.chatMetadata ?? {}, messages: conversation.messages.map(message => toExtensionMessage(message, conversation.characterName)) })) as ExtensionChatState;
}

// Apply only fields changed by the caller. Concurrent untouched fields survive;
// arrays are values (e.g. a swipe's variables array), explicit removal deletes.
// Self-contained so the exact same implementation can be served to the browser.
export function mergeJsonChanges(base: unknown, next: unknown, current: unknown): unknown {
  if (JSON.stringify(base) === JSON.stringify(next)) return current;
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!record(base) || !record(next)) return next;
  const existing = record(current) ? current : {};
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(next), ...Object.keys(existing)])]
    .flatMap(key => {
      const value = mergeJsonChanges(Object.hasOwn(base, key) ? base[key] : undefined, Object.hasOwn(next, key) ? next[key] : undefined, Object.hasOwn(existing, key) ? existing[key] : undefined);
      return value === undefined ? [] : [[key, value]];
    }));
}

// Message arrays merge by stable identity, not by numeric JSON paths: a model
// can append a reply while an extension edits an earlier message's variables.
export function mergeChatMessages<T extends { id: string }>(
  base: T[], next: T[], current: T[], merge: (base: unknown, next: unknown, current: unknown) => unknown,
): T[] {
  const before = new Map(base.map(message => [message.id, message]));
  const existing = new Map(current.map(message => [message.id, message]));
  const result = next.flatMap(message => {
    const previous = before.get(message.id), stored = existing.get(message.id);
    if (previous && !stored) return []; // A concurrent delete must not resurrect.
    return [merge(previous, message, stored) as T];
  });
  let anchor: string | undefined;
  for (const message of current) {
    const present = result.some(item => item.id === message.id);
    if (present) anchor = message.id;
    else if (!before.has(message.id)) {
      const index = anchor ? result.findIndex(item => item.id === anchor) + 1 : 0;
      result.splice(index, 0, message); anchor = message.id;
    }
  }
  return result;
}
