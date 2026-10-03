import { toExtensionMessage, type ConversationDetail, type StoryExportJson } from "@mycompanion/shared";

export interface ReplyBranch { branchId: string; messageId: string; content: string }
/** Regeneration forks retain their full prefix. A branch that has continued or
 * edited its prefix is a separate story path rather than a same-turn reply. */
export function replyBranches(story: StoryExportJson, active: ConversationDetail): ReplyBranch[] {
  const last = active.messages.at(-1);
  if (story.conversation.id !== active.id || last?.role !== "assistant" || !last.parentMessageId) return [];
  const prefix = active.messages.slice(0, -1), grouped = new Map<string, StoryExportJson["messages"]>();
  for (const message of story.messages) {
    const messages = grouped.get(message.branchId) ?? []; messages.push(message); grouped.set(message.branchId, messages);
  }
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
  const signature = (message: StoryExportJson["messages"][number]) => JSON.stringify(canonical([
    message.parentMessageId,
    // Native prefix clones and persisted extension prefixes differ only in
    // default fields materialized by toExtensionMessage. Normalize those, but
    // retain every meaningful or unknown extension field in the comparison.
    toExtensionMessage({ ...message, conversationId: active.id }, active.characterName),
  ]));
  const signatures = prefix.map(signature), candidates: ReplyBranch[] = [];
  for (const [branchId, messages] of grouped) {
    const reply = messages.at(-1);
    if (messages.length !== active.messages.length || reply?.role !== "assistant" || reply.parentMessageId !== last.parentMessageId || reply.status === "streaming") continue;
    if (prefix.some((_, index) => signature(messages[index]!) !== signatures[index])) continue;
    candidates.push({ branchId, messageId: reply.id, content: reply.content });
  }
  return candidates;
}
