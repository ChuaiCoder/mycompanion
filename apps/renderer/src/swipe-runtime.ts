import { chatMessageSchema, type ChatMessage } from "@mycompanion/shared";
import { readApiPayload } from "./api";

export interface SwipeTarget { conversationId: string; messageId: string }

// 候选回复切换（FR-CHAT）：原生端点原子完成 swipe_id/内容/扩展数据/投影更新。
export async function selectMessageSwipe(target: SwipeTarget, selected: number): Promise<ChatMessage> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(target.conversationId)}/messages/${encodeURIComponent(target.messageId)}/swipe`,
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ swipeId: selected }),
    },
  );
  return chatMessageSchema.parse(await readApiPayload(response));
}
