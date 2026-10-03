import {
  conversationDetailSchema,
  conversationListResponseSchema,
  type ConversationDetail,
  type ConversationListResponse,
} from "@mycompanion/shared";

import { readApiPayload } from "./core";

export async function listConversations(signal?: AbortSignal): Promise<ConversationListResponse> {
  const response = await fetch("/api/conversations", {
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  return conversationListResponseSchema.parse(await readApiPayload(response));
}

export async function createConversation(characterId: string): Promise<ConversationDetail> {
  const response = await fetch("/api/conversations", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ characterId }),
  });
  return conversationDetailSchema.parse(await readApiPayload(response));
}

export async function fetchConversation(id: string, signal?: AbortSignal): Promise<ConversationDetail> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  return conversationDetailSchema.parse(await readApiPayload(response));
}
