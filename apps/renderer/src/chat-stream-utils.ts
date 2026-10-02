import type { ChatMessage, ConversationDetail } from "@mycompanion/shared";

// 流式增量：把 delta 追加到最后一条 assistant 消息。
export function updateLastAssistantContent(
  conversation: ConversationDetail,
  delta: string,
): ConversationDetail {
  const index = [...conversation.messages].reverse().findIndex((message) => message.role === "assistant");
  if (index < 0) return conversation;
  const realIndex = conversation.messages.length - 1 - index;
  const target = conversation.messages[realIndex];
  if (!target) return conversation;
  const updated: ConversationDetail = {
    ...conversation,
    messages: conversation.messages.map((message, i) =>
      i === realIndex ? { ...message, content: message.content + delta } : message,
    ),
  };
  return updated;
}

// 用服务端确认的消息替换同 ID 的消息（done 事件）。
export function replaceMessage(
  conversation: ConversationDetail,
  message: ChatMessage,
): ConversationDetail {
  return {
    ...conversation,
    messages: conversation.messages.map((existing) =>
      existing.id === message.id ? { ...message } : existing,
    ),
  };
}
