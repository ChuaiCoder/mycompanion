import { readFileSync } from "node:fs";

import { afterEach, expect, vi } from "vitest";

import { characterDetailSchema } from "@mycompanion/shared";

import { buildApp } from "./app.js";

export type TestApp = ReturnType<typeof buildApp>;

// Every importing test file gets its own copy of this module (vitest isolates
// modules per test file), so the array and the afterEach registered here apply
// exactly to that file's tests — same cleanup semantics as the old monolith.
const apps: TestApp[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.unstubAllGlobals();
});

export { apps };

export const fullV2Card = JSON.parse(
  readFileSync(
    new URL(
      "../../../packages/character-card/fixtures/ccv2-full.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as unknown;

export const sandboxExtensionZip = Buffer.from(
  "UEsDBBQAAAAIADJmM12XJQ/8jgAAAMYAAAAaAAAAc2FuZGJveC10ZXN0L21hbmlmZXN0Lmpzb249jjEOwjAMRa9SeUZRu3IDBia6IVSFxqKGEkOcVq2q3h07A9v/z9azNwgkn9GvXfRvhGMFFx/DnZeqRclwqGBkHyg+Ok4Bky40yhJ+J0ooWq837U9LQDHg4jQr6aUgyeuIzooyP+WBTQHmLmjGJMTRWONqV5eD1GOU8sv51BoZmF+m28D3mWafy/Cf9/0HUEsDBBQAAAAIADJmM13gBsW+nwAAAN4AAAAVAAAAc2FuZGJveC10ZXN0L2luZGV4LmpzbY0xDsIwEAR7XnHdJRIxD4hoQBSIhi+Y5BKMkrNlb1AQyt8xFKmQVtptZtaNwUfQm5LgNEM0Oa/X6McAWqjLg9iY3ZrURBdgHonrjcw/tpu0QabI5npaSFH+0xWcrLY3P1eQBN7yRSQQ7kKDVUhUGhwMlzW1vplGUZg+Swb5zsPr3BYchql3WkXvwaWBzDj6jCr2vJ5RnFSd9lzTsvkAUEsDBBQAAAAIADJmM12JQ1ISIAAAAB4AAAAWAAAAc2FuZGJveC10ZXN0L3N0eWxlLmNzc1MuyClNz8zTLcrPL6lOzs/JL7IqSk/SMNQx0jHWrAUAUEsBAhQAFAAAAAgAMmYzXZclD/yOAAAAxgAAABoAAAAAAAAAAAAAAIABAAAAAHNhbmRib3gtdGVzdC9tYW5pZmVzdC5qc29uUEsBAhQAFAAAAAgAMmYzXeAGxb6fAAAA3gAAABUAAAAAAAAAAAAAAIABxgAAAHNhbmRib3gtdGVzdC9pbmRleC5qc1BLAQIUABQAAAAIADJmM12JQ1ISIAAAAB4AAAAWAAAAAAAAAAAAAACAAZgBAABzYW5kYm94LXRlc3Qvc3R5bGUuY3NzUEsFBgAAAAADAAMAzwAAAOwBAAAAAA==",
  "base64",
);

export const pathTraversalExtensionZip = Buffer.from(
  "UEsDBBQAAAAIADhoM11Dv6ajBAAAAAIAAAAQAAAALi4vbWFuaWZlc3QuanNvbquuBQBQSwECFAAUAAAACAA4aDNdQ7+mowQAAAACAAAAEAAAAAAAAAAAAAAAgAEAAAAALi4vbWFuaWZlc3QuanNvblBLBQYAAAAAAQABAD4AAAAyAAAAAAA=",
  "base64",
);

/** 构造一个 SSE 流式响应：把每段文本包成 data: {...delta...} 事件。 */
export function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`,
        ));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** 记忆提取/摘要的非流式补全请求（stream:false）统一返回一个空的 JSON 数组补全。 */
export function completionResponse(content = "[]"): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

export function isCompletionRequest(init?: RequestInit): boolean {
  if (typeof init?.body !== "string") return false;
  try {
    return (JSON.parse(init.body) as { stream?: boolean }).stream === false;
  } catch {
    return false;
  }
}

/**
 * 可停止的 SSE 流：先推一段文本，然后 pull 阻塞直到 signal 中止（模拟用户点击“停止”），
 * 中止后关闭流，让已接收文本作为“停止”结果保留。
 */
export function stoppableSseResponse(signal?: AbortSignal | null): Response {
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "你好，" } }] })}\n\n`,
      ));
      if (signal?.aborted) closed = true;
    },
    pull(controller) {
      if (closed) { controller.close(); return; }
      return new Promise<void>((resolve) => {
        const onAbort = (): void => { closed = true; resolve(); };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** 解析注入响应里的 SSE 事件。 */
export function parseSse(body: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try { events.push(JSON.parse(line.slice(5).trim()) as Record<string, unknown>); } catch { /* skip */ }
  }
  return events;
}

/** 轮询一个异步后台任务（记忆提取/摘要）直到探针返回非 undefined。 */
export async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 记忆提取/摘要的补全请求：按 system 提示词区分，返回对应内容。 */
export function completionByKind(init?: RequestInit): Response {
  const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content: string }> };
  const system = body.messages?.[0]?.content ?? "";
  const content = system.includes("记忆助手")
    ? '[{"type":"fact","content":"玩家改名叫远航。","importance":4}]'
    : "阶段摘要内容。";
  return completionResponse(content);
}

export async function commitCard(app: TestApp, card: unknown, filename = "card.json") {
  const response = await app.inject({
    method: "POST",
    url: "/api/characters/import/commit",
    payload: { filename, card },
  });
  expect(response.statusCode).toBe(201);
  return characterDetailSchema.parse(response.json());
}

// 带内嵌世界书的角色卡：一条关键词条目、一条常驻条目。
export const lorebookCard = {
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: {
    name: "世界书测试",
    description: "用于验证世界书运行时的测试角色。",
    personality: "",
    scenario: "",
    first_mes: "你好。",
    mes_example: "",
    creator_notes: "",
    system_prompt: "",
    post_history_instructions: "",
    alternate_greetings: [],
    tags: ["test"],
    creator: "MyCompanion",
    character_version: "1.0",
    extensions: {},
    character_book: {
      name: "测试世界书",
      entries: [
        { keys: ["工作室"], content: "工作室建在废弃天文台内部。", extensions: {}, enabled: true, insertion_order: 100 },
        { keys: ["天文台"], content: "天文台穹顶仍可转动。", extensions: {}, enabled: false, insertion_order: 50 },
        { keys: [], constant: true, content: "固定背景：地图会说话。", extensions: {}, enabled: true, insertion_order: 999 },
      ],
    },
  },
};

export async function setLorebookEntryEnabled(
  app: TestApp,
  id: string,
  index: number,
  enabled: boolean,
) {
  const response = await app.inject({
    method: "PUT",
    url: `/api/characters/${id}/lorebook/${index}`,
    payload: { enabled },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as Array<{ index: number; enabled: boolean }>;
}
