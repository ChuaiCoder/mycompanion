import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { parseCharacterCardDocument } from "@mycompanion/character-card";
import type { BackupPayload } from "@mycompanion/shared";
import { applyRestore, assembleBackupPayload, backupChecksum, previewRestore } from "./backup.js";
import { buildApp } from "./app.js";
import { CharacterRepository } from "./character-repository.js";
import { RuntimeRepository } from "./runtime-repository.js";

const databases: DatabaseSync[] = [], paths: string[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const path of paths.splice(0)) for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
});
const timestamp = "2026-10-02T00:00:00.000Z";
const png = (label: string) => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(label)]);

function setup(path = ":memory:") {
  const database = new DatabaseSync(path); databases.push(database);
  return { database, characters: new CharacterRepository(database), runtime: new RuntimeRepository(database) };
}
function seed(sources: ReturnType<typeof setup>, label: string): BackupPayload {
  const { characters, runtime } = sources;
  const card = parseCharacterCardDocument({ spec: "chara_card_v2", spec_version: "2.0", data: { name: label, description: label,
    personality: "", scenario: "", first_mes: label + " greeting", mes_example: "", creator_notes: "MyCompanion fixture",
    system_prompt: "", post_history_instructions: "", alternate_greetings: [], tags: [], creator: "MyCompanion", character_version: "1", extensions: {} } });
  const character = characters.import(card, label).character, conversation = runtime.createConversation(character);
  runtime.addMemory({ id: randomUUID(), conversationId: conversation.id, characterId: character.id, type: "fact", scope: "story",
    content: label + " memory", importance: 3, status: "active", pinned: true, sourceMessageIds: [conversation.messages[0]!.id],
    supersededBy: null, previousContent: label + " prior memory", createdAt: timestamp, lastUsedAt: null });
  runtime.saveSummary(conversation.id, label + " summary", 1, "fixture");
  runtime.restoreConversationSetting({ conversationId: conversation.id, autoSummaryEnabled: false });
  runtime.restorePlugin({ id: "atomic-prompt", manifest: { id: "atomic-prompt", name: label, version: "1", systemPrompt: label, commands: [] }, enabled: true, installedAt: timestamp });
  runtime.restoreCodePlugin({ id: "atomic-code", manifest: { display_name: label, version: "1", author: "MyCompanion fixture", license: "AGPL-3.0-only", js: "dist/index.js" },
    enabled: true, installedAt: timestamp, contributions: { systemPrompt: label, commands: [] },
    files: { "dist/index.js": Buffer.from("export const value = " + JSON.stringify(label)).toString("base64"), "asset.bin": Buffer.from(label).toString("base64") } });
  runtime.retainedChats.save({ avatar: "retained.png", characterId: randomUUID(), conversations: [], memories: [], stageSummaries: [], conversationSettings: [] });
  runtime.saveExtensionSettings({ atomicMarker: label, variables: { global: { atomic: label } } });
  runtime.avatars.put("atomic-user.png", png(label));
  runtime.worldInfo.save("atomic-book", { entries: { 1: { uid: 1, key: [label], content: label, constant: true, position: 1, disable: false } } });
  runtime.worldInfo.saveSettings({ ...runtime.worldInfo.settings(), globalSelect: ["atomic-book"], world_info_depth: label === "Existing" ? 2 : 3 });
  runtime.saveProvider({ kind: "openai-compatible", baseUrl: "https://example.com/v1", model: label, clearApiKey: false, temperature: 0.5, maxTokens: 256, contextLimitTokens: 4096 }, "fixture-encrypted-secret");
  return assembleBackupPayload(sources);
}
function snapshot(database: DatabaseSync) {
  const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
  return Object.fromEntries(tables.map(({ name }) => [name, database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]));
}
const checksum = (payload: BackupPayload) => { payload.manifest.checksum = backupChecksum(payload); return payload; };
function changedBackup(original: BackupPayload): BackupPayload {
  const incoming = structuredClone(original);
  (incoming.characters[0]!.rawCard.data as Record<string, unknown>).description = "Restored card";
  incoming.characters[0]!.sourcePngBase64 = png("restored character bytes").toString("base64");
  incoming.conversations[0]!.title = "Restored story";
  incoming.conversations[0]!.messages[0]!.content = "Restored message";
  incoming.memories[0]!.content = "Restored memory";
  incoming.plugins[0]!.manifest.name = "Restored prompt";
  incoming.codePlugins[0]!.files["asset.bin"] = Buffer.from("Restored plugin bytes").toString("base64");
  incoming.stageSummaries[0]!.content = "Restored summary";
  incoming.conversationSettings[0]!.autoSummaryEnabled = true;
  incoming.retainedCharacterChats![0]!.characterId = randomUUID();
  incoming.extensionSettings = { atomicMarker: "restored" };
  incoming.userAvatars![0]!.bytesBase64 = png("restored avatar bytes").toString("base64");
  incoming.worldbooks![0]!.data.entries["1"]!.content = "Restored world info";
  incoming.worldInfoSettings = { globalSelect: [], world_info_depth: 7 };
  incoming.providerSettings!.model = "Restored provider";
  return checksum(incoming);
}

const sections = ["characters", "conversations", "messages", "memories", "plugins", "code_plugins", "code_plugin_files",
  "stage_summaries", "conversation_settings", "retained_character_chats", "extension_settings", "user_avatars", "world_info_books", "world_info_settings", "provider_settings"];
it.each(sections.flatMap(section => ["new", "overwrite"].map(mode => ({ section, mode }))))(
  "rolls back every section after $section fails during $mode restore", ({ section, mode }) => {
    const target = setup(), beforeBackup = seed(target, "Existing");
    const payload = mode === "new" ? seed(setup(), "Incoming") : changedBackup(beforeBackup);
    expect(previewRestore(payload, target, "overwrite").valid).toBe(true);
    const before = snapshot(target.database);
    target.database.exec(`CREATE TRIGGER reject_restore BEFORE INSERT ON ${section} BEGIN SELECT RAISE(ABORT, 'restore fixture failure'); END`);
    expect(() => applyRestore(payload, target, "overwrite")).toThrow("restore fixture failure");
    expect(snapshot(target.database)).toEqual(before);
    target.database.exec("DROP TRIGGER reject_restore");
    expect(() => applyRestore(payload, target, "overwrite")).not.toThrow();
    expect(target.runtime.getEncryptedApiKey()).toBe("fixture-encrypted-secret");
    expect(target.characters.get(payload.characters[0]!.id)?.description).toBe(mode === "new" ? "Incoming" : "Restored card");
    expect(target.runtime.getConversation(payload.conversations[0]!.id)?.messages[0]?.content).toBe(payload.conversations[0]!.messages[0]!.content);
    expect(Buffer.from(target.runtime.avatars.get("atomic-user.png")!.bytes)).toEqual(Buffer.from(payload.userAvatars![0]!.bytesBase64, "base64"));
  },
);

it("rolls back new sections under skip policy while keeping all prior records", () => {
  const target = setup(), original = seed(target, "Existing"), source = setup(), payload = seed(source, "Incoming");
  const before = snapshot(target.database);
  target.database.exec("CREATE TRIGGER reject_restore BEFORE INSERT ON conversation_settings BEGIN SELECT RAISE(ABORT, 'skip restore failed'); END");
  expect(() => applyRestore(payload, target, "skip")).toThrow("skip restore failed");
  expect(snapshot(target.database)).toEqual(before);
  target.database.exec("DROP TRIGGER reject_restore");
  const result = applyRestore(payload, target, "skip");
  expect(result.applied.characters).toBe(1);
  expect(result.skipped.codePlugins).toBe(1);
  expect(target.runtime.getCodePluginBackupEntry("atomic-code")?.files).toEqual(original.codePlugins[0]!.files);
});

it("rolls back all sections when the final commit fails a deferred constraint", () => {
  const target = setup(), payload = changedBackup(seed(target, "Existing"));
  target.database.exec(`
    CREATE TABLE restore_fixture_parent (id INTEGER PRIMARY KEY);
    CREATE TABLE restore_fixture_child (parent_id INTEGER REFERENCES restore_fixture_parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER reject_commit AFTER INSERT ON provider_settings BEGIN INSERT INTO restore_fixture_child VALUES (123); END;
    CREATE TRIGGER reject_commit_update AFTER UPDATE ON provider_settings BEGIN INSERT INTO restore_fixture_child VALUES (123); END;
  `);
  const before = snapshot(target.database);
  expect(() => applyRestore(payload, target, "overwrite")).toThrow(/FOREIGN KEY constraint failed/i);
  expect(snapshot(target.database)).toEqual(before);
  target.database.exec("DROP TRIGGER reject_commit; DROP TRIGGER reject_commit_update");
  expect(() => applyRestore(payload, target, "overwrite")).not.toThrow();
  expect(target.runtime.getProvider().model).toBe("Restored provider");
});

it("survives a real SQLITE_FULL rollback and reopens the prior data with its original attachment bytes", () => {
  const path = join(tmpdir(), `backup-full-${randomUUID()}.sqlite`); paths.push(path);
  const target = setup(path), original = seed(target, "Existing"), payload = changedBackup(original);
  payload.userAvatars![0]!.bytesBase64 = Buffer.concat([png("new large attachment"), Buffer.alloc(512 * 1024, 65)]).toString("base64");
  checksum(payload);
  const before = snapshot(target.database);
  const pages = target.database.prepare("PRAGMA page_count").get() as { page_count: number };
  target.database.exec(`PRAGMA max_page_count = ${pages.page_count}`);
  expect(() => applyRestore(payload, target, "overwrite")).toThrow(/database or disk is full/i);
  expect(snapshot(target.database)).toEqual(before);
  const reopened = setup(path);
  expect(snapshot(reopened.database)).toEqual(before);
  expect(Buffer.from(reopened.runtime.avatars.get("atomic-user.png")!.bytes)).toEqual(Buffer.from(original.userAvatars![0]!.bytesBase64, "base64"));
  target.database.exec("PRAGMA max_page_count = 1073741823");
  expect(() => applyRestore(payload, target, "overwrite")).not.toThrow();
  expect(reopened.runtime.avatars.get("atomic-user.png")?.bytes.length).toBeGreaterThan(512 * 1024);
});

it("returns a failed HTTP restore without persisting an earlier section, then allows a successful retry", async () => {
  const path = join(tmpdir(), `backup-http-${randomUUID()}.sqlite`); paths.push(path);
  const app = buildApp({ databasePath: path }), target = setup(path);
  try {
    const before = seed(target, "Existing"), payload = changedBackup(before), state = snapshot(target.database);
    target.database.exec("CREATE TRIGGER reject_restore BEFORE INSERT ON world_info_settings BEGIN SELECT RAISE(ABORT, 'HTTP restore failed'); END");
    const response = await app.inject({ method: "POST", url: "/api/backup/restore", payload: { backup: payload, strategy: "overwrite" } });
    expect(response.statusCode, response.body).toBe(500);
    expect(snapshot(target.database)).toEqual(state);
    const publicBackup = (await app.inject({ method: "GET", url: "/api/backup" })).json() as BackupPayload;
    expect(publicBackup.characters).toEqual(before.characters);
    expect(publicBackup.codePlugins).toEqual(before.codePlugins);
    expect(publicBackup.userAvatars).toEqual(before.userAvatars);
    target.database.exec("DROP TRIGGER reject_restore");
    const retry = await app.inject({ method: "POST", url: "/api/backup/restore", payload: { backup: payload, strategy: "overwrite" } });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(target.runtime.getConversation(payload.conversations[0]!.id)?.title).toBe("Restored story");
  } finally { await app.close(); }
});
