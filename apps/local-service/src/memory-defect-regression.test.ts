import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationDetail, MemoryRecord, MemoryScope } from "@mycompanion/shared";
import { buildApp } from "./app.js";
import { RuntimeRepository } from "./persistence/runtime-repository.js";

// 回归：用户报的 8 个缺陷里属于服务端的 #2（角色级记忆被完全隐藏）、
// #3（模型名为空无法获取模型列表）。#5 的归属回退由 chat/memory-inventory.test.ts 覆盖。

const directories: string[] = [];
const servers: Server[] = [];
const openApps: Array<{ app: ReturnType<typeof buildApp>; database: DatabaseSync }> = [];
afterEach(async () => {
  for (const { app, database } of openApps.splice(0)) { database.close(); await app.close(); }
  for (const server of servers.splice(0)) {
    await new Promise<void>(done => { server.close(() => done()); });
    server.closeAllConnections();
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), "memory-defect-"));
  directories.push(directory);
  const path = join(directory, "profile.sqlite");
  const app = buildApp({ databasePath: path });
  // 与 app 共用同一个库文件，便于精确构造作用域边界（沿用 memory-scope 的做法）。
  const database = new DatabaseSync(path), runtime = new RuntimeRepository(database);
  openApps.push({ app, database });
  const character = (await app.inject({
    method: "POST", url: "/api/characters/import/commit",
    payload: { filename: "card.json", card: { spec: "chara_card_v2", spec_version: "2.0",
      data: { name: "回归角色", description: "fixture", personality: "", scenario: "", first_mes: "你好", mes_example: "",
        creator_notes: "MyCompanion test", system_prompt: "", post_history_instructions: "", alternate_greetings: [],
        tags: [], creator: "MyCompanion", character_version: "1", extensions: {} } } },
  })).json() as { id: string };
  const story = async (): Promise<ConversationDetail> => {
    const response = await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } });
    expect(response.statusCode, response.body).toBe(201);
    return response.json();
  };
  const addMemory = (conversationId: string, scope: MemoryScope, content: string): MemoryRecord => runtime.addMemory({
    id: randomUUID(), conversationId, characterId: character.id, type: "fact", content, scope,
    importance: 3, status: "active", pinned: false, sourceMessageIds: [], supersededBy: null,
    previousContent: "旧内容", createdAt: "2026-10-03T00:00:00.000Z", lastUsedAt: null,
  });
  const list = async (conversationId: string): Promise<MemoryRecord[]> => {
    const response = await app.inject({ method: "GET", url: `/api/conversations/${conversationId}/memories` });
    expect(response.statusCode, response.body).toBe(200);
    return (response.json() as { items: MemoryRecord[] }).items;
  };
  return { app, runtime, story, addMemory, list };
}

describe("服务端缺陷回归", () => {
  // #2：收窄规则之后角色级不再跨对话共享，但**不能**因此变得完全不可见不可改。
  it("#2 角色级遗留记忆仍在原故事可见，并且能编辑、固定、恢复、删除", async () => {
    const fixture = await setup();
    const story = await fixture.story();
    const legacy = fixture.addMemory(story.id, "character", "收窄规则之前的角色级记忆");

    expect((await fixture.list(story.id)).map(item => item.id)).toContain(legacy.id);

    const updated = await fixture.app.inject({
      method: "PUT", url: `/api/conversations/${story.id}/memories/${legacy.id}`, payload: { pinned: true },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toMatchObject({ pinned: true });

    const restored = await fixture.app.inject({ method: "POST", url: `/api/conversations/${story.id}/memories/${legacy.id}/restore` });
    expect(restored.statusCode, restored.body).toBe(200);

    const deleted = await fixture.app.inject({ method: "DELETE", url: `/api/conversations/${story.id}/memories/${legacy.id}` });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(fixture.runtime.getMemory(legacy.id)).toBeUndefined();
  });

  it("#2 另一局（同一张角色卡）仍然看不到这条角色级记忆", async () => {
    const fixture = await setup();
    const owner = await fixture.story(), sibling = await fixture.story();
    const legacy = fixture.addMemory(owner.id, "character", "只属于第一局");
    expect((await fixture.list(sibling.id)).map(item => item.id)).not.toContain(legacy.id);
  });

  it("#3 模型名为空时仍能获取模型列表", async () => {
    const app = buildApp();
    openApps.push({ app, database: new DatabaseSync(join(tmpdir(), `unused-${randomUUID()}.sqlite`)) });
    const provider = createServer((request, response) => {
      if ((request.url ?? "").includes("/models")) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "custom-model-a" }, { id: "custom-model-b" }] }));
        return;
      }
      response.writeHead(404); response.end();
    });
    servers.push(provider);
    await new Promise<void>(done => provider.listen(0, "127.0.0.1", () => done()));
    const port = (provider.address() as { port: number }).port;

    // 自定义服务此时**还不知道**模型名，以前会因复用写入校验直接 400。
    const response = await app.inject({
      method: "POST", url: "/api/settings/provider/models",
      payload: { kind: "openai-compatible", baseUrl: `http://127.0.0.1:${port}/v1`, model: "" },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, models: ["custom-model-a", "custom-model-b"] });

    // 关键：前端发的是**完整草稿**（带生成参数与 clearApiKey）。
    // 只测最小载荷会漏掉"多余字段被判非法"这条真实路径。
    const fullDraft = await app.inject({
      method: "POST", url: "/api/settings/provider/models",
      payload: {
        kind: "openai-compatible", baseUrl: `http://127.0.0.1:${port}/v1`, model: "",
        temperature: 0.8, maxTokens: 1024, contextLimitTokens: 32768, clearApiKey: false,
      },
    });
    expect(fullDraft.statusCode, fullDraft.body).toBe(200);
    expect(fullDraft.json()).toMatchObject({ ok: true, models: ["custom-model-a", "custom-model-b"] });
  });

  it("#3 仍拒绝缺少地址的草稿", async () => {
    const app = buildApp();
    openApps.push({ app, database: new DatabaseSync(join(tmpdir(), `unused-${randomUUID()}.sqlite`)) });
    const response = await app.inject({ method: "POST", url: "/api/settings/provider/models", payload: { kind: "openai-compatible", model: "" } });
    expect(response.statusCode).toBe(400);
  });
});
