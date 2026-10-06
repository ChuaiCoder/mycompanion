import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { CardVariablesResponse } from "@mycompanion/shared";
import { buildApp } from "../app.js";
import { apps, commitCard, completionResponse, fullV2Card, isCompletionRequest, sseResponse, type TestApp } from "../testing/helpers.js";

// 卡片脚本的变量接口：三级落点、合并优先级、以及 insert 与 replace 的语义差异。
// 这些断言都走真实 HTTP，不直接读库，确保契约就是渲染端看到的那一份。

const directories: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function stubExtractor(): void {
  vi.stubGlobal("fetch", vi.fn(async (_url: URL, init?: RequestInit) => {
    if (!isCompletionRequest(init)) return sseResponse(["好的。"]);
    const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content: string }> };
    if (!(body.messages?.[0]?.content ?? "").includes("记忆助手")) return completionResponse("阶段摘要内容。");
    return completionResponse(JSON.stringify([{ type: "fact", content: "一条记忆。", importance: 3 }]));
  }));
}

async function seeded(): Promise<{ app: TestApp; storyId: string; messageId: string }> {
  stubExtractor();
  const directory = mkdtempSync(join(tmpdir(), "card-variables-"));
  directories.push(directory);
  const app = buildApp({ databasePath: join(directory, "profile.sqlite") });
  apps.push(app);
  const character = await commitCard(app, fullV2Card, "ccv2-full.json");
  await app.inject({
    method: "PUT", url: "/api/settings/provider",
    payload: { kind: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "test-model" },
  });
  const story = (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } })).json();
  const detail = (await app.inject({ method: "GET", url: `/api/conversations/${story.id}` })).json();
  return { app, storyId: story.id, messageId: detail.messages[0].id };
}

const readVariables = async (app: TestApp, storyId: string): Promise<CardVariablesResponse> => {
  const response = await app.inject({ method: "GET", url: `/api/conversations/${storyId}/variables` });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as CardVariablesResponse;
};

const mutate = async (app: TestApp, storyId: string, mutation: Record<string, unknown>) => {
  const response = await app.inject({ method: "POST", url: `/api/conversations/${storyId}/variables`, payload: { mutation } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as CardVariablesResponse;
};

it("starts empty and rejects unknown stories", async () => {
  const { app, storyId } = await seeded();
  const empty = await readVariables(app, storyId);
  expect(empty.variables).toEqual({});
  expect(empty.scopes).toEqual({ global: {}, chat: {}, character: {}, preset: {}, message: {} });

  const missing = await app.inject({ method: "GET", url: "/api/conversations/11111111-1111-4111-8111-111111111111/variables" });
  expect(missing.statusCode).toBe(404);
});

it("keeps global and story scopes in separate stores and merges story over global", async () => {
  const { app, storyId } = await seeded();
  await mutate(app, storyId, { action: "set", type: "global", key: "place", value: "全局仙境", remove: false });
  await mutate(app, storyId, { action: "set", type: "chat", key: "place", value: "当前洞府", remove: false });
  await mutate(app, storyId, { action: "set", type: "chat", key: "onlyChat", value: 7, remove: false });

  const state = await readVariables(app, storyId);
  // 各级原始视图保持分开
  expect(state.scopes.global).toEqual({ place: "全局仙境" });
  expect(state.scopes.chat).toEqual({ place: "当前洞府", onlyChat: 7 });
  // 合并视图里故事级覆盖全局（消息级 > 故事级 > 全局）
  expect(state.variables).toEqual({ place: "当前洞府", onlyChat: 7 });
});

it("treats character scope as story level so a new playthrough does not inherit it", async () => {
  const { app, storyId } = await seeded();
  await mutate(app, storyId, { action: "set", type: "character", key: "affinity", value: 5, remove: false });
  const state = await readVariables(app, storyId);
  // character 与 chat 同落点（本应用把每个对话视为一次独立开档）。
  expect(state.scopes.character).toEqual({ affinity: 5 });
  expect(state.scopes.chat).toEqual({ affinity: 5 });

  // 另一个故事不应看到它——这正是"每局独立"的保证。
  const character = (await app.inject({ method: "GET", url: "/api/characters" })).json().items[0];
  const second = (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } })).json();
  const other = await readVariables(app, second.id);
  expect(other.scopes.chat).toEqual({});
  expect(other.variables).toEqual({});
});

it("distinguishes insert (only missing keys) from replace (whole map)", async () => {
  const { app, storyId } = await seeded();
  await mutate(app, storyId, { action: "set", type: "chat", key: "keep", value: "原值", remove: false });

  // insert 不能覆盖已有键
  const inserted = await mutate(app, storyId, { action: "insert", type: "chat", values: { keep: "被覆盖?", added: 1 } });
  expect(inserted.scopes.chat).toEqual({ keep: "原值", added: 1 });

  // replace 整体替换
  const replaced = await mutate(app, storyId, { action: "replace", type: "chat", values: { fresh: true } });
  expect(replaced.scopes.chat).toEqual({ fresh: true });
});

it("deletes by key and by value, and supports removal through set", async () => {
  const { app, storyId } = await seeded();
  await mutate(app, storyId, { action: "replace", type: "chat", values: { a: 1, b: 2, c: 1 } });

  const byKey = await mutate(app, storyId, { action: "delete", type: "chat", subject: "key", target: "b" });
  expect(byKey.scopes.chat).toEqual({ a: 1, c: 1 });

  const byValue = await mutate(app, storyId, { action: "delete", type: "chat", subject: "value", target: 1 });
  expect(byValue.scopes.chat).toEqual({});

  await mutate(app, storyId, { action: "set", type: "chat", key: "gone", value: "x", remove: false });
  const removed = await mutate(app, storyId, { action: "set", type: "chat", key: "gone", value: null, remove: true });
  expect(removed.scopes.chat).toEqual({});
});

it("writes message scope onto that message and merges it above story and global", async () => {
  const { app, storyId, messageId } = await seeded();
  await mutate(app, storyId, { action: "set", type: "global", key: "k", value: "G", remove: false });
  await mutate(app, storyId, { action: "set", type: "chat", key: "k", value: "C", remove: false });

  // 省略 messageId → 当前激活分支的最后一条消息
  const written = await mutate(app, storyId, { action: "set", type: "message", key: "k", value: "M", remove: false });
  expect(written.scopes.message).toEqual({ k: "M" });
  // 消息级优先
  expect(written.variables).toEqual({ k: "M" });

  // 落点确实写在该消息的扩展数据上，而不是故事元数据
  const detail = (await app.inject({ method: "GET", url: `/api/conversations/${storyId}` })).json();
  expect(detail.messages[0].extensionData.extra.variables).toEqual({ k: "M" });
  expect(detail.chatMetadata.variables).toEqual({ k: "C" });
  expect(messageId).toBe(detail.messages[0].id);
});

it("rejects malformed mutations instead of silently writing nothing", async () => {
  const { app, storyId } = await seeded();
  const badScope = await app.inject({
    method: "POST", url: `/api/conversations/${storyId}/variables`,
    payload: { mutation: { action: "set", type: "nope", key: "a", value: 1 } },
  });
  expect(badScope.statusCode).toBe(400);

  const unknownAction = await app.inject({
    method: "POST", url: `/api/conversations/${storyId}/variables`,
    payload: { mutation: { action: "obliterate", type: "chat" } },
  });
  expect(unknownAction.statusCode).toBe(400);

  // 缺少 key 的 set 必须被拒绝，否则会写入 undefined 键。
  const missingKey = await app.inject({
    method: "POST", url: `/api/conversations/${storyId}/variables`,
    payload: { mutation: { action: "set", type: "chat", value: 1 } },
  });
  expect(missingKey.statusCode).toBe(400);
});
