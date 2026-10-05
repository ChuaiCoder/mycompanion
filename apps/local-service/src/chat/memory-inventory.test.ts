import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryRecord } from "@mycompanion/shared";
import { buildApp } from "../app.js";
import { RuntimeRepository } from "../persistence/runtime-repository.js";
import {
  apps,
  commitCard,
  completionResponse,
  fullV2Card,
  isCompletionRequest,
  sseResponse,
  waitFor,
  type TestApp,
} from "../testing/helpers.js";

// 记忆库接口（GET /api/memories）：跨故事列出记忆，且每条只出现一次。
//
// 造数据走真实路径：提取流程只产出 story 作用域的记忆（见 memory-extractor 的
// scope: "story"），character / user 作用域是用户后续在记忆中心改出来的，所以这里
// 也用真实的 PUT 接口去改，而不是直接写库。

const directories: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const app of apps.splice(0)) await app.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

/** 按来源文本返回不同内容的记忆，用来区分两条故事各自的记忆。 */
function stubExtractor(): void {
  vi.stubGlobal("fetch", vi.fn(async (_url: URL, init?: RequestInit) => {
    if (!isCompletionRequest(init)) return sseResponse(["好的。"]);
    const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content: string }> };
    const system = body.messages?.[0]?.content ?? "";
    if (!system.includes("记忆助手")) return completionResponse("阶段摘要内容。");
    const source = JSON.stringify(body.messages ?? []);
    const content = source.includes("甲线")
      ? "只属于甲线的线索。"
      : source.includes("乙线") ? "只属于乙线的线索。" : "一条普通记忆。";
    return completionResponse(JSON.stringify([{ type: "fact", content, importance: 4 }]));
  }));
}

async function say(app: TestApp, conversationId: string, content: string): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: `/api/conversations/${conversationId}/messages`,
    payload: { content },
  });
  expect(response.statusCode, response.body).toBe(200);
}

const memoriesOf = async (app: TestApp, conversationId: string): Promise<MemoryRecord[]> => {
  const response = await app.inject({ method: "GET", url: `/api/conversations/${conversationId}/memories` });
  expect(response.statusCode, response.body).toBe(200);
  return (response.json() as { items: MemoryRecord[] }).items;
};

const inventory = async (app: TestApp, query = "") => {
  const response = await app.inject({ method: "GET", url: `/api/memories${query}` });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as { items: Array<{ memory: MemoryRecord; conversationId: string; conversationTitle: string }>; total: number };
};

/** 两条故事各一条故事级记忆；再把甲线那条改成「用户全局」。 */
async function seeded() {
  stubExtractor();
  // 用临时库文件，便于同时挂一个仓库实例直接构造作用域边界（沿用 memory-scope 的做法）。
  const directory = mkdtempSync(join(tmpdir(), "memory-inventory-"));
  directories.push(directory);
  const databasePath = join(directory, "profile.sqlite");
  // 与 app 共用同一个库文件：先建连接与仓库，再让 app 打开同一文件
  // （memory-defect-regression 用的就是这个顺序）。
  const database = new DatabaseSync(databasePath);
  databases.push(database);
  const repository = new RuntimeRepository(database);
  const app = buildApp({ databasePath });
  apps.push(app);
  const character = await commitCard(app, fullV2Card, "ccv2-full.json");
  await app.inject({
    method: "PUT",
    url: "/api/settings/provider",
    payload: { kind: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "test-model" },
  });
  const create = async () => (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } })).json();
  const first = await create();
  const second = await create();

  await say(app, first.id, "甲线的开场");
  await say(app, second.id, "乙线的开场");
  // 提取是后台任务：等两条故事各自的记忆都落库再继续，否则后面的断言会抢跑。
  const firstMemory = await waitFor(async () => {
    const items = await memoriesOf(app, first.id);
    const other = await memoriesOf(app, second.id);
    return items.length > 0 && other.length > 0 ? items[0] : undefined;
  }, 5_000);

  // 用户把甲线那条改成全局记忆：这是 character/user 作用域的唯一来源。
  const promoted = await app.inject({
    method: "PUT",
    url: `/api/conversations/${first.id}/memories/${firstMemory.id}`,
    payload: { scope: "user" },
  });
  expect(promoted.statusCode, promoted.body).toBe(200);
  expect(promoted.json().scope).toBe("user");
  // 乙线那条保持故事作用域，用来验证 story 归属。注意此时乙线也能看到上面提成全局
  // 的那条，所以必须按 scope 选出真正属于乙线的那一条。
  const secondMemory = (await memoriesOf(app, second.id)).find(item => item.scope === "story")!;
  expect(secondMemory).toBeDefined();
  return { app, repository, first, second, firstMemory, secondMemory };
}

describe("GET /api/memories（记忆库）", () => {
  it("lists memories from every story with their owning story title", async () => {
    const { app, first, second, firstMemory, secondMemory } = await seeded();
    const all = await inventory(app);

    expect(all.total).toBe(2);
    expect(new Set(all.items.map(item => item.memory.id)).size).toBe(2);
    const byId = new Map(all.items.map(item => [item.memory.id, item]));
    const actual = [...all.items].map(item => ({ id: item.memory.id, scope: item.memory.scope, conversationId: item.conversationId, title: item.conversationTitle }));
    const expected = [
      { id: firstMemory.id, scope: "user", conversationId: first.id, title: first.title },
      { id: secondMemory.id, scope: "story", conversationId: second.id, title: second.title },
    ];
    expect(actual.sort((a, b) => a.id.localeCompare(b.id))).toEqual(expected.sort((a, b) => a.id.localeCompare(b.id)));
  });

  it("keeps a memory that the user promoted to global scope in the inventory", async () => {
    const { app, firstMemory } = await seeded();
    const all = await inventory(app);

    // 提成全局作用域后仍属于原故事，且不会因为"不再属于某个故事"而消失。
    const promoted = all.items.find(item => item.memory.id === firstMemory.id)!;
    expect(promoted.memory.scope).toBe("user");
    expect(promoted.conversationTitle.length).toBeGreaterThan(0);
    // 全局记忆对两条故事都可见，所以它天然会出现在两边的故事视图里。
    expect(all.items.filter(item => item.memory.id === firstMemory.id)).toHaveLength(1);
  });

  it("filters by scope, type and status and rejects an invalid filter", async () => {
    const { app } = await seeded();

    expect((await inventory(app, "?scope=user")).items.map(item => item.memory.scope)).toEqual(["user"]);
    expect((await inventory(app, "?scope=story")).items).toHaveLength(1);
    expect((await inventory(app, "?type=fact")).items).toHaveLength(2);
    expect((await inventory(app, "?type=goal")).items).toHaveLength(0);
    expect((await inventory(app, "?status=active")).items).toHaveLength(2);
    expect((await inventory(app, "?status=disabled")).items).toHaveLength(0);
    // 筛选结果仍带归属故事，前端才能分组。
    for (const item of (await inventory(app, "?scope=story")).items) {
      expect(item.conversationTitle.length).toBeGreaterThan(0);
    }
    expect((await app.inject({ method: "GET", url: "/api/memories?scope=nope" })).statusCode).toBe(400);
  });

  it("has the same reach as the per-story list, so nothing is silently missing", async () => {
    const { app, first, second } = await seeded();
    // 清单条数 == 各故事可见记忆的并集去重后的条数。
    const union = new Set([
      ...(await memoriesOf(app, first.id)).map(item => item.id),
      ...(await memoriesOf(app, second.id)).map(item => item.id),
    ]);
    const all = await inventory(app);
    expect(new Set(all.items.map(item => item.memory.id))).toEqual(union);
  });

  it("keeps a user-scope memory manageable after its source story is deleted, but drops story-scope ones", async () => {
    // 作用域不同，处理也必须不同：
    //  - 故事级记忆：来源故事删了就不可见于任何故事 → 隐藏（否则是改不动的幽灵条目）
    //  - 用户级记忆：描述玩家本人、跨故事共享**且仍在参与检索** → 必须继续可管理
    // 以前两者都被隐藏，用户级记忆就变成"在检索里生效、在记忆库里看不到也改不了"。
    const { app, first, second, firstMemory, secondMemory } = await seeded();
    const before = await inventory(app);
    const storyRow = before.items.find(item => item.memory.id === secondMemory.id)!;
    const userRow = before.items.find(item => item.memory.id === firstMemory.id)!;
    expect(storyRow.memory.scope).toBe("story");
    expect(userRow.memory.scope).toBe("user");

    expect((await app.inject({ method: "DELETE", url: `/api/conversations/${first.id}` })).statusCode).toBe(200);
    const after = await inventory(app);
    const ids = after.items.map(item => item.memory.id);

    // 用户级：仍在清单里，并且归属到该角色仍然存在的那条故事（乙线）。
    expect(ids).toContain(firstMemory.id);
    const keptUser = after.items.find(item => item.memory.id === firstMemory.id)!;
    expect(keptUser.conversationId).toBe(second.id);
    expect(keptUser.conversationTitle.length).toBeGreaterThan(0);

    // 关键：它必须**真的可管理** —— 用清单给出的归属故事去改，不能 404。
    const updated = await app.inject({
      method: "PUT", url: `/api/conversations/${keptUser.conversationId}/memories/${firstMemory.id}`, payload: { pinned: true },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toMatchObject({ pinned: true });

    // 故事级：来源故事删了，就不该再出现在清单里（也不能改挂到乙线）。
    // 注意 firstMemory 已被提成用户级，所以"甲线的故事级记忆"已经不存在；
    // 这里用"清单里的故事级记忆必须都锚定在仍然活跃的故事上"来表达同一条规则。
    const storyScopedAfter = after.items.filter(item => item.memory.scope === "story");
    expect(storyScopedAfter.every(item => item.conversationId === second.id)).toBe(true);
    // 而 secondMemory 本身（锚定在活跃的乙线）必须还在。
    expect(ids).toContain(secondMemory.id);
  });

  it("keeps a user-scope memory editable while rejecting the deleted story's story-scope memory", async () => {
    // 这是这次缺陷的核心对照：同一批"来源故事已删"的记忆，用户级仍然可管，
    // 故事级则必须读不到、也改不了（否则会写进一个已删除的故事）。
    const fixture = await seeded();
    const { app, first, second, firstMemory } = fixture;
    // 造一条锚定在甲线的故事级记忆，用于对照。
    const storyScoped = fixture.repository.addMemory({
      id: randomUUID(), conversationId: first.id, characterId: first.characterId, type: "fact",
      content: "只属于甲线的故事级记忆", scope: "story", importance: 3, status: "active", pinned: false,
      sourceMessageIds: [], supersededBy: null, previousContent: null,
      createdAt: "2026-10-03T00:00:00.000Z", lastUsedAt: null,
    });

    expect((await app.inject({ method: "DELETE", url: `/api/conversations/${first.id}` })).statusCode).toBe(200);

    // 用户级：读得到（用乙线读），也能改。
    const visible = await app.inject({ method: "GET", url: `/api/conversations/${second.id}/memories` });
    const visibleIds = (visible.json() as { items: MemoryRecord[] }).items.map(item => item.id);
    expect(visibleIds).toContain(firstMemory.id);
    const userEdit = await app.inject({
      method: "PUT", url: `/api/conversations/${second.id}/memories/${firstMemory.id}`, payload: { pinned: true },
    });
    expect(userEdit.statusCode, userEdit.body).toBe(200);

    // 故事级：读不到，改也被拒（404），且没有任何变更。
    expect(visibleIds).not.toContain(storyScoped.id);
    const rejected = await app.inject({
      method: "PUT", url: `/api/conversations/${second.id}/memories/${storyScoped.id}`, payload: { pinned: true },
    });
    expect(rejected.statusCode, rejected.body).toBe(404);
    expect(fixture.repository.getMemory(storyScoped.id)?.pinned).toBe(false);
  });

  it("returns an empty inventory rather than failing before anything was extracted", async () => {
    const app = buildApp();
    apps.push(app);
    await expect(inventory(app)).resolves.toEqual({ items: [], total: 0 });
  });

  // 产品定位：AI 角色扮演游戏，一个对话就是一次新的开档。
  // 同一张角色卡开第二局，不该知道第一局发生过什么。
  it("keeps two playthroughs of the same character card from sharing memories", async () => {
    stubExtractor();
    const app = buildApp();
    apps.push(app);
    const character = await commitCard(app, fullV2Card, "same-card.json");
    await app.inject({
      method: "PUT",
      url: "/api/settings/provider",
      payload: { kind: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "test-model" },
    });
    const create = async () => (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } })).json();
    const firstRun = await create();
    const secondRun = await create();
    expect(firstRun.characterId).toBe(secondRun.characterId);

    // 第一局里说一句会被提取成记忆的话。
    await say(app, firstRun.id, "甲线的开场");
    const extracted = await waitFor(async () => (await memoriesOf(app, firstRun.id))[0], 5_000);
    expect(extracted.scope).toBe("story");

    // 第二局完全看不到第一局的记忆 —— 这是本次收窄的核心。
    expect(await memoriesOf(app, secondRun.id)).toEqual([]);
  });
});
