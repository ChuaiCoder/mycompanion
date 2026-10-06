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

/**
 * 显示阶段正则转换：只影响渲染的文本，不落库。
 * 卡把整段界面放在 `markdownOnly` 规则里时，靠它把占位符换成真实界面。
 */
export async function transformDisplayText(
  conversationId: string,
  items: Array<{ messageId: string; text: string }>,
  signal?: AbortSignal,
): Promise<Array<{ messageId: string; text: string }>> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/display-regex`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
    ...(signal ? { signal } : {}),
  });
  const payload = await readApiPayload(response) as { results: Array<{ messageId: string; text: string }> };
  return payload.results;
}
