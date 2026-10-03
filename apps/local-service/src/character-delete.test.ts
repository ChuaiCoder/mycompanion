import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type BackupPayload } from "@mycompanion/shared";
import { buildApp } from "./app.js";
import { backupChecksum } from "./backup.js";
import { createTestCharacter } from "./native-fixtures.js";

type App = ReturnType<typeof buildApp>;
const applications: App[] = [], paths: string[] = [];
const app = (databasePath?: string) => { const instance = buildApp(databasePath ? { databasePath } : {}); applications.push(instance); return instance; };
afterEach(async () => {
  for (const instance of applications.splice(0)) await instance.close();
  for (const path of paths.splice(0)) for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
});
const backup = async (instance: App): Promise<BackupPayload> => (await instance.inject({ method: "GET", url: "/api/backup" })).json();
const restore = (instance: App, data: BackupPayload, strategy: "skip" | "overwrite" = "overwrite") => {
  data.manifest.checksum = backupChecksum(data);
  return instance.inject({ method: "POST", url: "/api/backup/restore", payload: { backup: data, strategy } });
};
async function story(instance: App) {
  const character = await createTestCharacter(instance, { ch_name: "Deleted role", first_mes: "Hello", description: "Card setting" });
  const chat = (await instance.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } })).json();
  const data = await backup(instance), saved = data.conversations.find(item => item.id === chat.id)!;
  const branch = randomUUID(); saved.messages.push({ ...saved.messages[0]!, branchId: branch, content: "Second branch", extensionData: { variables: { score: 8 } }, generationMetadata: { model: "preserved-model", temperature: 0.7, maxTokens: 512 } });
  saved.activeBranchId = branch; saved.chatMetadata = { variables: { chapter: 3 } };
  const timestamp = new Date().toISOString();
  data.memories.push({ id: randomUUID(), conversationId: chat.id, characterId: character.id, type: "fact", scope: "story", content: "Remembered", importance: 3, status: "active", pinned: true, sourceMessageIds: [saved.messages[0]!.id], supersededBy: null, previousContent: null, createdAt: timestamp, lastUsedAt: null });
  data.stageSummaries.push({ conversationId: chat.id, content: "Saved summary", coveredMessageCount: 1, model: "fixture", previousContent: "Earlier summary", createdAt: timestamp });
  data.conversationSettings.push({ conversationId: chat.id, autoSummaryEnabled: false });
  const response = await restore(instance, data); expect(response.statusCode, response.body).toBe(200);
  return { character, chat };
}

describe("character deletion (native)", () => {
  it("soft delete hides the character and its conversations, and restore brings everything back", async () => {
    const instance = app(), { character, chat } = await story(instance);
    const removed = await instance.inject({ method: "DELETE", url: `/api/characters/${character.id}` });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json()).toMatchObject({ characterId: character.id, permanent: false, hiddenConversations: 1, hiddenMemories: 1 });
    // 软删除的角色从库列表隐藏，但详情与故事仍可直接访问（回收站语义）。
    expect((await instance.inject({ method: "GET", url: "/api/characters" })).json().items).toHaveLength(0);
    expect((await instance.inject({ method: "GET", url: `/api/characters/${character.id}` })).json().deletedAt).not.toBeNull();
    expect((await instance.inject({ method: "GET", url: `/api/conversations/${chat.id}` })).statusCode).toBe(200);
    const recycled = (await instance.inject({ method: "GET", url: "/api/characters/deleted" })).json().items;
    expect(recycled).toHaveLength(1);
    expect(recycled[0].id).toBe(character.id);
    const restored = await instance.inject({ method: "POST", url: `/api/characters/${character.id}/restore` });
    expect(restored.statusCode, restored.body).toBe(200);
    expect((await instance.inject({ method: "GET", url: `/api/characters/${character.id}` })).json().deletedAt).toBeNull();
    expect((await instance.inject({ method: "GET", url: "/api/characters" })).json().items).toHaveLength(1);
    const recovered = (await instance.inject({ method: "GET", url: `/api/conversations/${chat.id}` })).json();
    expect(recovered.chatMetadata.variables.chapter).toBe(3);
    expect(recovered.messages.at(-1).content).toBe("Second branch");
    expect((await instance.inject({ method: "GET", url: "/api/characters/deleted" })).json().items).toHaveLength(0);
  });

  it("permanent delete cascades conversations, messages and memories", async () => {
    const instance = app(), { character, chat } = await story(instance);
    const removed = await instance.inject({ method: "DELETE", url: `/api/characters/${character.id}?permanent=true` });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json()).toMatchObject({ characterId: character.id, permanent: true, hiddenConversations: 1, hiddenMemories: 1 });
    const data = await backup(instance);
    expect(data.characters).toHaveLength(0);
    expect(data.conversations).toHaveLength(0);
    expect(data.memories).toHaveLength(0);
    expect((await instance.inject({ method: "POST", url: `/api/characters/${character.id}/restore` })).statusCode).toBe(404);
  });

  it("other roles and their stories remain intact while one role is deleted", async () => {
    const instance = app(), first = await story(instance), second = await story(instance);
    expect((await instance.inject({ method: "DELETE", url: `/api/characters/${first.character.id}` })).statusCode).toBe(200);
    expect((await instance.inject({ method: "GET", url: `/api/conversations/${second.chat.id}` })).statusCode).toBe(200);
    expect((await instance.inject({ method: "GET", url: "/api/characters" })).json().items.map((item: { id: string }) => item.id)).toEqual([second.character.id]);
  });

  it("rejects invalid permanent flags and missing characters", async () => {
    const instance = app(), { character } = await story(instance);
    expect((await instance.inject({ method: "DELETE", url: `/api/characters/${character.id}?permanent=maybe` })).statusCode).toBe(400);
    expect((await instance.inject({ method: "DELETE", url: `/api/characters/${randomUUID()}` })).statusCode).toBe(404);
  });
});

describe("legacy retained-chat archives in backups", () => {
  // 原生应用不再产生 detached（retained）历史——软删除+恢复覆盖了旧的重挂流程——
  // 但旧备份里的 retainedCharacterChats 仍要能恢复，且非法档案要在写入前被拒绝。
  function retainedEntry(data: BackupPayload, avatar: string) {
    const conversation = data.conversations[0]!;
    return {
      avatar, characterId: conversation.characterId, conversations: [conversation],
      memories: data.memories, stageSummaries: data.stageSummaries, conversationSettings: data.conversationSettings,
    };
  }

  it("restores retained archives from legacy backups and honors skip/overwrite", async () => {
    const source = app(), target = app();
    await story(source);
    const original = await backup(source);
    const entry = retainedEntry(original, "legacy-role.png");
    original.conversations = []; original.memories = []; original.stageSummaries = []; original.conversationSettings = [];
    original.retainedCharacterChats = [entry];
    expect((await restore(target, original)).json().applied.retainedCharacterChats).toBe(1);
    const changed = structuredClone(original); changed.retainedCharacterChats![0]!.conversations[0]!.title = "Updated archive title";
    expect((await restore(target, changed, "skip")).json().skipped.retainedCharacterChats).toBe(1);
    expect((await backup(target)).retainedCharacterChats![0]!.conversations[0]!.title).not.toBe("Updated archive title");
    expect((await restore(target, changed)).json().applied.retainedCharacterChats).toBe(1);
    const legacy = await backup(app()); delete legacy.retainedCharacterChats;
    expect((await restore(target, legacy)).statusCode).toBe(200);
  });

  it("rejects cross-owner archives, duplicates and live-target collisions before writing", async () => {
    const source = app(), target = app();
    await story(source);
    const original = await backup(source);
    const entry = retainedEntry(original, "legacy-role.png");
    original.conversations = []; original.memories = []; original.stageSummaries = []; original.conversationSettings = [];
    original.retainedCharacterChats = [entry];
    for (const mutate of [
      (data: BackupPayload) => { data.retainedCharacterChats![0]!.conversations[0]!.characterId = randomUUID(); },
      (data: BackupPayload) => { data.retainedCharacterChats!.push(structuredClone(data.retainedCharacterChats![0]!)); },
    ]) {
      const invalid = structuredClone(original); mutate(invalid);
      const response = await restore(target, invalid); expect([400, 422]).toContain(response.statusCode);
      expect((await backup(target)).retainedCharacterChats).toHaveLength(0);
    }
    const live = await createTestCharacter(target, { ch_name: "Legacy role" });
    const colliding = structuredClone(original);
    colliding.retainedCharacterChats![0]!.avatar = live.avatar!;
    expect((await restore(target, colliding)).statusCode).toBe(422);
    expect((await backup(target)).characters).toHaveLength(1);
  });
});
