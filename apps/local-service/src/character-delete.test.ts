import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { type BackupPayload } from "@mycompanion/shared";
import { buildApp } from "./app.js";
import { backupChecksum } from "./backup.js";

type App = ReturnType<typeof buildApp>;
const applications: App[] = [], paths: string[] = [];
const app = (databasePath?: string) => { const instance = buildApp(databasePath ? { databasePath } : {}); applications.push(instance); return instance; };
afterEach(async () => {
  for (const instance of applications.splice(0)) await instance.close();
  for (const path of paths.splice(0)) for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
});
async function create(instance: App, name = "Retained", file_name?: string) {
  const response = await instance.inject({ method: "POST", url: "/api/characters/create", payload: { ch_name: name, first_mes: "Hello", description: "Removed card setting", ...(file_name ? { file_name } : {}) } });
  expect(response.statusCode, response.body).toBe(200);
  return response.body;
}
const read = async (instance: App, avatar: string) => (await instance.inject({ method: "POST", url: "/api/characters/get", payload: { avatar_url: avatar } })).json();
const backup = async (instance: App): Promise<BackupPayload> => (await instance.inject({ method: "GET", url: "/api/backup" })).json();
const remove = (instance: App, avatar: string, delete_chats?: boolean) => instance.inject({ method: "POST", url: "/api/characters/delete", payload: { avatar_url: avatar, ...(delete_chats === undefined ? {} : { delete_chats }) } });
const restore = (instance: App, data: BackupPayload, strategy: "skip" | "overwrite" = "overwrite") => {
  data.manifest.checksum = backupChecksum(data);
  return instance.inject({ method: "POST", url: "/api/backup/restore", payload: { backup: data, strategy } });
};
async function story(instance: App, avatar: string) {
  const character = await read(instance, avatar);
  const chat = (await instance.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } })).json();
  const data = await backup(instance), saved = data.conversations.find(item => item.id === chat.id)!;
  const branch = randomUUID(); saved.messages.push({ ...saved.messages[0]!, branchId: branch, content: "Second branch", extensionData: { variables: { score: 8 } }, generationMetadata: { model: "preserved-model", temperature: 0.7, maxTokens: 512 } });
  saved.activeBranchId = branch; saved.chatMetadata = { variables: { chapter: 3 } };
  const timestamp = new Date().toISOString();
  data.memories.push({ id: randomUUID(), conversationId: chat.id, characterId: character.id, type: "fact", scope: "story", content: "Remembered", importance: 3, status: "active", pinned: true, sourceMessageIds: [saved.messages[0]!.id], supersededBy: null, previousContent: null, createdAt: timestamp, lastUsedAt: null });
  data.stageSummaries.push({ conversationId: chat.id, content: "Saved summary", coveredMessageCount: 1, model: "fixture", previousContent: "Earlier summary", createdAt: timestamp });
  data.conversationSettings.push({ conversationId: chat.id, autoSummaryEnabled: false });
  const response = await restore(instance, data); expect(response.statusCode, response.body).toBe(200);
  return { character, chat, expected: (await backup(instance)) };
}

describe("Tavern character deletion and retained chat ownership", () => {
  it("really deletes the card, releases its filename, and reattaches all retained branches and variables to the recreated role", async () => {
    const instance = app(), avatar = await create(instance), { character, chat, expected } = await story(instance, avatar);
    expect((await remove(instance, avatar, false)).statusCode).toBe(200);
    expect((await read(instance, avatar)).error).toBe("Character not found");
    expect((await instance.inject({ method: "GET", url: "/api/characters/deleted" })).json().items).toHaveLength(0);
    expect((await instance.inject({ method: "GET", url: `/api/conversations/${chat.id}` })).statusCode).toBe(404);
    const detached = await backup(instance);
    expect(detached.characters).toHaveLength(0); expect(detached.conversations).toHaveLength(0);
    expect(detached.retainedCharacterChats).toHaveLength(1);
    expect(JSON.stringify(detached.retainedCharacterChats)).not.toContain("Removed card setting");
    const replacementAvatar = await create(instance, "Replacement", avatar); expect(replacementAvatar).toBe(avatar);
    const replacement = await read(instance, avatar); expect(replacement.id).not.toBe(character.id);
    const after = await backup(instance), restored = after.conversations[0]!;
    expect(restored).toEqual({ ...expected.conversations[0], characterId: replacement.id, characterName: "Replacement" });
    expect(after.memories).toEqual(expected.memories.map(item => ({ ...item, characterId: replacement.id })));
    expect(after.stageSummaries).toEqual(expected.stageSummaries); expect(after.conversationSettings).toEqual(expected.conversationSettings);
    expect(after.retainedCharacterChats).toHaveLength(0);
    const history = (await instance.inject({ method: "POST", url: "/api/chats/get", payload: { avatar_url: avatar, file_name: chat.id } })).json();
    expect(history[0].chat_metadata.variables.chapter).toBe(3); expect(history[1].mes).toBe("Second branch");
  });

  it("default HTTP deletion keeps chats, explicit delete_chats removes them, and other roles remain intact", async () => {
    const instance = app(), avatar = await create(instance), other = await create(instance, "Other");
    await story(instance, avatar); const unaffected = await story(instance, other);
    expect((await remove(instance, avatar)).statusCode).toBe(200);
    expect((await backup(instance)).retainedCharacterChats).toHaveLength(1);
    await create(instance, "Recreated", avatar); expect((await remove(instance, avatar, true)).statusCode).toBe(200);
    expect((await backup(instance)).retainedCharacterChats).toHaveLength(0);
    await create(instance, "No old stories", avatar);
    expect((await instance.inject({ method: "POST", url: "/api/characters/chats", payload: { avatar_url: avatar } })).json()).toHaveLength(0);
    expect((await instance.inject({ method: "GET", url: `/api/conversations/${unaffected.chat.id}` })).statusCode).toBe(200);
    expect((await remove(instance, "../../bad.png", true)).statusCode).toBe(400);
  });

  it("retains detached histories across database reopen and case-insensitive filename reuse", async () => {
    const path = join(tmpdir(), `retained-chat-${randomUUID()}.sqlite`); paths.push(path);
    const first = app(path), avatar = await create(first), { chat } = await story(first, avatar);
    await remove(first, avatar, false); await first.close();
    const second = app(path); const same = await create(second, "After restart", "RETAINED.png");
    expect(same).toBe("RETAINED.png");
    expect((await instanceChats(second, same))[0].file_name).toBe(chat.id + ".jsonl");
    expect((await backup(second)).retainedCharacterChats).toHaveLength(0);
  });

  it("backs up retained histories, honors skip/overwrite, and accepts legacy backups without the optional field", async () => {
    const source = app(), target = app(), avatar = await create(source); await story(source, avatar); await remove(source, avatar, false);
    const original = await backup(source);
    expect((await restore(target, original)).json().applied.retainedCharacterChats).toBe(1);
    const changed = structuredClone(original); changed.retainedCharacterChats![0]!.conversations[0]!.title = "Updated archive title";
    expect((await restore(target, changed, "skip")).json().skipped.retainedCharacterChats).toBe(1);
    expect((await backup(target)).retainedCharacterChats![0]!.conversations[0]!.title).not.toBe("Updated archive title");
    expect((await restore(target, changed)).json().applied.retainedCharacterChats).toBe(1);
    const legacy = await backup(app()); delete legacy.retainedCharacterChats;
    expect((await restore(target, legacy)).statusCode).toBe(200);
    const recreated = await create(target, "Restored archive", avatar);
    expect((await instanceChats(target, recreated))[0].chat_name).toBe("Updated archive title");
  });

  it("rejects cross-owner archives, duplicates and live-target collisions before writing", async () => {
    const source = app(), target = app(), avatar = await create(source); await story(source, avatar); await remove(source, avatar, false);
    const original = await backup(source);
    for (const mutate of [
      (data: BackupPayload) => { data.retainedCharacterChats![0]!.conversations[0]!.characterId = randomUUID(); },
      (data: BackupPayload) => { data.retainedCharacterChats!.push(structuredClone(data.retainedCharacterChats![0]!)); },
    ]) {
      const invalid = structuredClone(original); mutate(invalid);
      const response = await restore(target, invalid); expect([400, 422]).toContain(response.statusCode);
      expect((await backup(target)).retainedCharacterChats).toHaveLength(0);
    }
    await create(target, "Retained");
    expect((await restore(target, original)).statusCode).toBe(422);
    expect((await backup(target)).characters).toHaveLength(1);
  });

  it("rolls back both deletion and re-creation when a later database write fails", async () => {
    const path = join(tmpdir(), `retained-atomic-${randomUUID()}.sqlite`); paths.push(path);
    const instance = app(path), avatar = await create(instance); await story(instance, avatar);
    const database = new DatabaseSync(path);
    try {
      database.exec("CREATE TRIGGER prevent_character_delete BEFORE DELETE ON characters BEGIN SELECT RAISE(ABORT, 'fixture delete failure'); END");
      expect((await remove(instance, avatar, false)).statusCode).toBe(500);
      expect((await read(instance, avatar)).name).toBe("Retained"); expect((await backup(instance)).retainedCharacterChats).toHaveLength(0);
      database.exec("DROP TRIGGER prevent_character_delete"); await remove(instance, avatar, false);
      database.exec("CREATE TRIGGER prevent_message_restore BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'fixture restore failure'); END");
      const response = await instance.inject({ method: "POST", url: "/api/characters/create", payload: { ch_name: "Retained" } });
      expect(response.statusCode).toBe(500);
      const unchanged = await backup(instance); expect(unchanged.characters).toHaveLength(0); expect(unchanged.conversations).toHaveLength(0); expect(unchanged.retainedCharacterChats).toHaveLength(1);
      database.exec("DROP TRIGGER prevent_message_restore"); expect(await create(instance)).toBe(avatar);
      expect((await backup(instance)).retainedCharacterChats).toHaveLength(0);
    } finally { database.close(); }
  });
});

const instanceChats = async (instance: App, avatar: string) => (await instance.inject({ method: "POST", url: "/api/characters/chats", payload: { avatar_url: avatar } })).json();
