import {
  conversationDetailSchema,
  conversationListResponseSchema,
  deleteConversationResponseSchema,
  deleteConversationsResponseSchema,
  type ConversationDetail,
  type ConversationListResponse,
  type DeleteConversationResponse,
  type DeleteConversationsResponse,
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

/** 软删除故事（FR-DATA-004）：服务端只打删除标记，内容保留可恢复。 */
export async function deleteConversation(id: string): Promise<DeleteConversationResponse> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Accept: "application/json" },
  });
  return deleteConversationResponseSchema.parse(await readApiPayload(response));
}

/** 批量软删除：一次请求、一次事务；返回值区分真正删掉的与跳过的。 */
export async function deleteConversations(ids: readonly string[]): Promise<DeleteConversationsResponse> {
  const response = await fetch("/api/conversations/delete-batch", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  return deleteConversationsResponseSchema.parse(await readApiPayload(response));
}
