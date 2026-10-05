import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import type { ConversationDetail, MemoryRecord, MemoryScope } from "@mycompanion/shared";
import { buildApp } from "./app.js";
import { RuntimeRepository } from "./persistence/runtime-repository.js";

type App = ReturnType<typeof buildApp>;
const resources: Array<{ app: App; database: DatabaseSync; path: string }> = [];
afterEach(async () => {
  for (const { app, database, path } of resources.splice(0)) {
    database.close();
    await app.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
  }
});

async function setup() {
  const path = join(tmpdir(), `memory-scope-${randomUUID()}.sqlite`);
  const app = buildApp({ databasePath: path });
  const database = new DatabaseSync(path), runtime = new RuntimeRepository(database);
  resources.push({ app, database, path });
  const create = async (name: string) => {
    const character = await app.inject({ method: "POST", url: "/api/characters/import/commit",
      payload: { filename: name + ".json", card: { spec: "chara_card_v2", spec_version: "2.0",
        data: { name, description: "Scope fixture", personality: "", scenario: "", first_mes: "Source greeting", mes_example: "",
          creator_notes: "MyCompanion test", system_prompt: "", post_history_instructions: "", alternate_greetings: [], tags: [],
          creator: "MyCompanion", character_version: "1", extensions: {} } } } });
    expect(character.statusCode, character.body).toBe(201);
    return character.json().id as string;
  };
  const characterId = await create("Scope A"), otherCharacterId = await create("Scope B");
  const story = async (id: string): Promise<ConversationDetail> => {
    const response = await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: id } });
    expect(response.statusCode, response.body).toBe(201);
    return response.json();
  };
  const owner = await story(characterId), sibling = await story(characterId), other = await story(otherCharacterId);
  const memory = (scope: MemoryScope): MemoryRecord => runtime.addMemory({ id: randomUUID(), conversationId: owner.id,
    characterId, type: "fact", content: "Owner memory", scope, importance: 3, status: "active", pinned: false,
    sourceMessageIds: [owner.messages[0]!.id], supersededBy: null, previousContent: "Prior owner content",
    createdAt: "2026-10-02T00:00:00.000Z", lastUsedAt: null });
  const list = async (conversationId: string): Promise<MemoryRecord[]> => {
    const response = await app.inject({ method: "GET", url: `/api/conversations/${conversationId}/memories` });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().items;
  };
  return { app, runtime, owner, sibling, other, memory, list };
}

const operations = ["edit", "restore", "delete"] as const;
function mutate(app: App, conversationId: string, memoryId: string, operation: typeof operations[number]) {
  const url = `/api/conversations/${conversationId}/memories/${memoryId}`;
  if (operation === "edit") return app.inject({ method: "PUT", url, payload: { content: "Updated through this story", scope: "user" } });
  if (operation === "restore") return app.inject({ method: "POST", url: url + "/restore" });
  return app.inject({ method: "DELETE", url });
}

const forbidden = [
  { scope: "story" as const, target: "sibling" as const },
  { scope: "story" as const, target: "other" as const },
  { scope: "character" as const, target: "other" as const },
  // 每次开档独立：同一角色卡的另一局（sibling）也看不到这一局的角色级记忆。
  { scope: "character" as const, target: "sibling" as const },
].flatMap(test => operations.map(operation => ({ ...test, operation })));
it.each(forbidden)("rejects $operation of $scope memory through $target story without changing the owner", async ({ scope, target, operation }) => {
  const fixture = await setup(), record = fixture.memory(scope), before = fixture.runtime.getMemory(record.id);
  // 前提：这条记忆在目标故事里本来就不可见（否则不该出现在 forbidden 里）。
  expect((await fixture.list(fixture[target].id)).some(item => item.id === record.id)).toBe(false);
  const response = await mutate(fixture.app, fixture[target].id, record.id, operation);
  expect(response.statusCode, response.body).toBe(404);
  expect(response.json().error.code).toBe("MEMORY_NOT_FOUND");
  // 记忆本身不变；也不能因为"操作被拒"反而变得可见。
  expect(fixture.runtime.getMemory(record.id)).toEqual(before);
  expect((await fixture.list(fixture[target].id)).some(item => item.id === record.id)).toBe(false);
});

const allowed = [
  { scope: "story" as const, target: "owner" as const },
  { scope: "user" as const, target: "other" as const },
].flatMap(test => operations.map(operation => ({ ...test, operation })));
it.each(allowed)("allows $operation of visible $scope memory through $target story", async ({ scope, target, operation }) => {
  const fixture = await setup(), record = fixture.memory(scope);
  expect((await fixture.list(fixture[target].id)).some(item => item.id === record.id)).toBe(true);
  const response = await mutate(fixture.app, fixture[target].id, record.id, operation);
  expect(response.statusCode, response.body).toBe(200);
  if (operation === "delete") expect(fixture.runtime.getMemory(record.id)).toBeUndefined();
  else {
    const saved = fixture.runtime.getMemory(record.id)!;
    expect(saved.conversationId).toBe(fixture.owner.id);
    expect(saved.characterId).toBe(fixture.owner.characterId);
    expect(saved.content).toBe(operation === "edit" ? "Updated through this story" : "Prior owner content");
    expect(response.json()).toEqual(saved);
  }
});

it("keeps each playthrough independent while leaving legacy character memories manageable in place", async () => {
  const fixture = await setup();
  const story = fixture.memory("story");
  const legacy = fixture.memory("character");
  // 另一局（同一角色卡）看不到这一局的任何记忆。
  for (const record of [story, legacy]) {
    expect((await fixture.list(fixture.sibling.id)).some(item => item.id === record.id)).toBe(false);
    expect((await fixture.list(fixture.other.id)).some(item => item.id === record.id)).toBe(false);
  }
  // 但它对自己所在的那一局可见 —— 收窄规则之前产生的角色级记忆必须还能被管理，
  // 否则用户在记忆面板里既看不到也删不掉。
  expect((await fixture.list(fixture.owner.id)).some(item => item.id === legacy.id)).toBe(true);
  // 只有"用户全局"是跨局共享的，因为它描述的是玩家本人而不是这一局的剧情。
  const shared = fixture.memory("user");
  expect((await fixture.list(fixture.sibling.id)).some(item => item.id === shared.id)).toBe(true);
  expect((await fixture.list(fixture.other.id)).some(item => item.id === shared.id)).toBe(true);
});

it("promotes and narrows scope without letting a memory leak into another playthrough", async () => {
  const fixture = await setup(), record = fixture.memory("story");
  const update = async (conversationId: string, scope: MemoryScope) => {
    const response = await fixture.app.inject({ method: "PUT", url: `/api/conversations/${conversationId}/memories/${record.id}`, payload: { scope } });
    expect(response.statusCode, response.body).toBe(200);
  };
  // 提成全局后两局都能看到。
  await update(fixture.owner.id, "user");
  expect((await fixture.list(fixture.sibling.id)).some(item => item.id === record.id)).toBe(true);
  expect((await fixture.list(fixture.other.id)).some(item => item.id === record.id)).toBe(true);
  // 收回本局后，另一局立刻看不到（不再有任何跨局通道）。
  await update(fixture.owner.id, "story");
  expect((await fixture.list(fixture.sibling.id)).some(item => item.id === record.id)).toBe(false);
  expect((await fixture.list(fixture.other.id)).some(item => item.id === record.id)).toBe(false);
  expect((await fixture.list(fixture.owner.id)).some(item => item.id === record.id)).toBe(true);
  expect(fixture.runtime.getMemory(record.id)).toMatchObject({ conversationId: fixture.owner.id, characterId: fixture.owner.characterId });
});
