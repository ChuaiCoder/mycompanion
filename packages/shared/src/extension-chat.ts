import type { ChatMessage, ConversationDetail } from "./runtime.js";

// Tavern-flavored message projection retained for native features (swipe
// candidates, story export). The extension chat save endpoint and its schemas
// were removed with the compatibility layer.
export type ExtensionChatMessage = {
  id: string;
  mes: string;
  is_user: boolean;
} & Record<string, unknown>;

export function toExtensionMessage(message: ChatMessage, characterName: string): ExtensionChatMessage {
  return {
    name: message.role === "user" ? "User" : characterName,
    is_system: false, send_date: message.createdAt, extra: {},
    ...message.extensionData,
    id: message.id, mes: message.content, is_user: message.role === "user",
    role: message.role, content: message.content, status: message.status,
    ...(message.generationMetadata ? {generationMetadata: structuredClone(message.generationMetadata)} : {}),
  };
}

// Apply only fields changed by the caller. Concurrent untouched fields survive;
// arrays are values (e.g. a swipe's variables array), explicit removal deletes.
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
// can append a reply while an earlier message's variables are being edited.
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
