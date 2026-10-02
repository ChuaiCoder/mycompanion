import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import type { ConversationDetail, MemoryRecord, MemoryScope } from "@mycompanion/shared";
import { buildApp } from "./app.js";
import { RuntimeRepository } from "./runtime-repository.js";

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
].flatMap(test => operations.map(operation => ({ ...test, operation })));
it.each(forbidden)("rejects $operation of $scope memory through $target story without changing the owner", async ({ scope, target, operation }) => {
  const fixture = await setup(), record = fixture.memory(scope), before = fixture.runtime.getMemory(record.id);
  expect((await fixture.list(fixture[target].id)).some(item => item.id === record.id)).toBe(false);
  const response = await mutate(fixture.app, fixture[target].id, record.id, operation);
  expect(response.statusCode, response.body).toBe(404);
  expect(response.json().error.code).toBe("MEMORY_NOT_FOUND");
  expect(fixture.runtime.getMemory(record.id)).toEqual(before);
  expect((await fixture.list(fixture.owner.id)).find(item => item.id === record.id)).toEqual(before);
  expect((await fixture.list(fixture[target].id)).some(item => item.id === record.id)).toBe(false);
});

const allowed = [
  { scope: "story" as const, target: "owner" as const },
  { scope: "character" as const, target: "sibling" as const },
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

it("uses the same scope rules after explicit promotion or narrowing, without transferring ownership", async () => {
  const fixture = await setup(), record = fixture.memory("story");
  const update = async (conversationId: string, scope: MemoryScope) => {
    const response = await fixture.app.inject({ method: "PUT", url: `/api/conversations/${conversationId}/memories/${record.id}`, payload: { scope } });
    expect(response.statusCode, response.body).toBe(200);
  };
  await update(fixture.owner.id, "character");
  expect((await fixture.list(fixture.sibling.id)).some(item => item.id === record.id)).toBe(true);
  expect((await fixture.list(fixture.other.id)).some(item => item.id === record.id)).toBe(false);
  await update(fixture.sibling.id, "user");
  expect((await fixture.list(fixture.other.id)).some(item => item.id === record.id)).toBe(true);
  await update(fixture.other.id, "story");
  expect((await fixture.list(fixture.other.id)).some(item => item.id === record.id)).toBe(false);
  expect((await fixture.list(fixture.owner.id)).some(item => item.id === record.id)).toBe(true);
  expect(fixture.runtime.getMemory(record.id)).toMatchObject({ conversationId: fixture.owner.id, characterId: fixture.owner.characterId });
});
