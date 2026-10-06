import type { CardVariableMutation, CardVariablesResponse } from "@mycompanion/shared";
import { readApiPayload } from "./core";

// 卡片脚本的变量读写。三级落点由本地服务负责，这里只做传输。

const base = (conversationId: string): string =>
  `/api/conversations/${encodeURIComponent(conversationId)}/variables`;

export async function fetchCardVariables(conversationId: string, signal?: AbortSignal): Promise<CardVariablesResponse> {
  const response = await fetch(base(conversationId), {
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  return readApiPayload(response) as Promise<CardVariablesResponse>;
}

export async function mutateCardVariables(
  conversationId: string,
  mutation: CardVariableMutation,
): Promise<CardVariablesResponse> {
  const response = await fetch(base(conversationId), {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ mutation }),
  });
  return readApiPayload(response) as Promise<CardVariablesResponse>;
}
