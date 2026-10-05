import {
  memoryInventoryResponseSchema,
  type MemoryInventoryResponse,
  type MemoryListQuery,
  type MemoryRecord,
  type MemoryRetrievalReport,
  type MemoryUpdateRequest,
  type StageSummary,
} from "@mycompanion/shared";

import { readApiPayload } from "./core";

// 记忆中心（FR-MEM-005/007）：列表筛选、更新、恢复上一版本、删除、检索测试器。
export async function listMemories(
  conversationId: string,
  filters: MemoryListQuery = {},
): Promise<MemoryRecord[]> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined) params.set(key, value);
  }
  const query = params.toString();
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/memories${query ? `?${query}` : ""}`,
    { headers: { Accept: "application/json" } },
  );
  const payload = (await readApiPayload(response)) as { items: MemoryRecord[] };
  return payload.items;
}

/**
 * 记忆库（跨故事清单）：每条记忆只出现一次，附归属故事标题，供「记忆」一级页面使用。
 * 与 listMemories 的区别是不按故事过滤。
 */
export async function listMemoryInventory(
  filters: MemoryListQuery = {},
  signal?: AbortSignal,
): Promise<MemoryInventoryResponse> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined) params.set(key, value);
  }
  const query = params.toString();
  const response = await fetch(`/api/memories${query ? `?${query}` : ""}`, {
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  return memoryInventoryResponseSchema.parse(await readApiPayload(response));
}

export async function updateMemory(
  conversationId: string,
  memoryId: string,
  patch: MemoryUpdateRequest,
): Promise<MemoryRecord> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/memories/${encodeURIComponent(memoryId)}`,
    {
      method: "PUT",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  return readApiPayload(response) as Promise<MemoryRecord>;
}

export async function restoreMemory(
  conversationId: string,
  memoryId: string,
  mode?: "supersession" | "previous_content",
): Promise<MemoryRecord> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/memories/${encodeURIComponent(memoryId)}/restore`,
    { method: "POST", headers: { Accept: "application/json", ...(mode ? { "Content-Type": "application/json" } : {}) }, ...(mode ? { body: JSON.stringify({ mode }) } : {}) },
  );
  return readApiPayload(response) as Promise<MemoryRecord>;
}

export async function deleteMemory(
  conversationId: string,
  memoryId: string,
): Promise<void> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/memories/${encodeURIComponent(memoryId)}`,
    { method: "DELETE", headers: { Accept: "application/json" } },
  );
  if (!response.ok) await readApiPayload(response);
}

export async function testMemory(
  conversationId: string,
  input: string,
): Promise<MemoryRetrievalReport> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/memories/test`,
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ input }),
    },
  );
  return readApiPayload(response) as Promise<MemoryRetrievalReport>;
}

// 阶段摘要（FR-MEM-006）：读取 / 编辑 / 恢复 / 自动摘要开关。
export async function getSummary(conversationId: string): Promise<{
  autoSummaryEnabled: boolean;
  summary: StageSummary | null;
}> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/summary`,
    { headers: { Accept: "application/json" } },
  );
  const payload = (await readApiPayload(response)) as {
    autoSummaryEnabled: boolean;
    summary: StageSummary | null;
  };
  return payload;
}

export async function saveSummary(
  conversationId: string,
  content: string,
): Promise<StageSummary> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/summary`,
    {
      method: "PUT",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    },
  );
  return readApiPayload(response) as Promise<StageSummary>;
}

export async function restoreSummary(conversationId: string): Promise<StageSummary> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/summary/restore`,
    { method: "POST", headers: { Accept: "application/json" } },
  );
  return readApiPayload(response) as Promise<StageSummary>;
}

export async function setAutoSummary(
  conversationId: string,
  enabled: boolean,
): Promise<{ autoSummaryEnabled: boolean }> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/summary/auto`,
    {
      method: "PUT",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    },
  );
  return readApiPayload(response) as Promise<{ autoSummaryEnabled: boolean }>;
}
