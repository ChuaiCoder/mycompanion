import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { RuntimeRepository } from "./runtime-repository.js";
import { importChatJsonl } from "./chat-jsonl-import.js";
import { CharacterRepository } from "./character-repository.js";
import { parseCharacterCardDocument } from "@mycompanion/character-card";

const directories: string[] = [];
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  for (const path of directories.splice(0)) {
    if (dirname(resolve(path)) !== resolve(tmpdir()) || !basename(path).startsWith("mycompanion-jsonl-")) throw new Error("Unexpected cleanup path");
    rmSync(path, { recursive: true, force: true });
  }
});
const header = { user_name: "Reader", character_name: "Original", create_date: "old-format date", unknownHeader: { keep: [1, 2] },
  chat_metadata: { variables: { score: 7 }, unknownMetadata: { future: true } } };
const raw = [header, { id: "external-id", name: "Reader", is_user: true, mes: { message: "Hello" }, extra: { variables: { a: 1 } }, unknownMessage: [4, 5] },
  { name: "Original", is_user: false, mes: "Second", swipes: [{ message: "First" }, { message: "Second" }], swipe_id: 1,
    swipe_info: [{ extra: { variables: { n: 1 } } }, { extra: { variables: { n: 2 } } }], extra: { media: { url: "https://example.invalid/media" } } } ] as const;
const content = raw.map(value => JSON.stringify(value)).join("\n") + "\n";
async function setup(databasePath?: string) {
  const app = buildApp(databasePath ? { databasePath } : {}); apps.push(app);
  const response = await app.inject({ method: "POST", url: "/api/characters/import/commit", payload: { filename: "card.json",
    card: { name: "Import target", description: "", personality: "", scenario: "", first_mes: "", mes_example: "" } } });
  expect(response.statusCode, response.body).toBe(201);
  return { app, character: response.json() };
}
async function send(app: ReturnType<typeof buildApp>, avatar: string, value = content, file_type = "jsonl") {
  const data = new FormData(); data.set("avatar", new Blob([value], { type: "application/json" }), "Imported.jsonl");
  data.set("file_type", file_type); data.set("avatar_url", avatar); data.set("character_name", "Import target"); data.set("user_name", "Reader");
  const request = new Request("http://localhost", { method: "POST", body: data });
  return app.inject({ method: "POST", url: "/api/chats/import", headers: { "content-type": request.headers.get("content-type")! }, payload: Buffer.from(await request.arrayBuffer()) });
}
const read = async (app: ReturnType<typeof buildApp>, avatar: string, file_name: string) => (await app.inject({ method: "POST", url: "/api/chats/get", payload: { avatar_url: avatar, file_name } })).json();
describe("Tavern raw JSONL import", () => {
  it("preserves header, Chub text, unknown message fields, swipes, variables and backup/restart identity", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mycompanion-jsonl-")); directories.push(directory);
    const databasePath = join(directory, "profile.sqlite"), { app, character } = await setup(databasePath);
    const imported = await send(app, character.avatar); expect(imported.statusCode, imported.body).toBe(200);
    const name = imported.json().fileNames[0]; expect(imported.json().res).toBe(true);
    const messages = await read(app, character.avatar, name);
    expect(messages[0]).toEqual(header); expect(messages[1]).toMatchObject({ mes: "Hello", extra: raw[1]!.extra, unknownMessage: [4, 5] });
    expect(messages[2]).toMatchObject({ swipes: ["First", "Second"], swipe_id: 1, swipe_info: raw[2]!.swipe_info, extra: raw[2]!.extra });
    const second = await send(app, character.avatar); expect(second.json().fileNames[0]).not.toBe(name);
    const backup = (await app.inject({ method: "GET", url: "/api/backup" })).json();
    const entry = backup.conversations.find((item: { id: string }) => item.id + ".jsonl" === name);
    expect(entry.chatHeader).toEqual(header); expect(entry.messages[0].extensionData.id).toBe("external-id");
    const exported = await app.inject({ method: "GET", url: `/api/conversations/${entry.id}/export?format=json` });
    expect(exported.statusCode, exported.body).toBe(200); expect(exported.json().conversation.chatHeader).toEqual(header);
    const target = buildApp(); apps.push(target);
    expect((await target.inject({ method: "POST", url: "/api/backup/restore", payload: { backup, strategy: "overwrite" } })).statusCode).toBe(200);
    expect(await read(target, character.avatar, name)).toEqual(messages);
    await app.close(); apps.splice(apps.indexOf(app), 1);
    const reopened = buildApp({ databasePath }); apps.push(reopened);
    expect(await read(reopened, character.avatar, name)).toEqual(messages);
    const chats = (await reopened.inject({ method: "POST", url: "/api/characters/chats", payload: { avatar_url: character.avatar } })).json();
    expect(chats).toHaveLength(2); expect(chats.some((chat: { file_name: string }) => chat.file_name === name)).toBe(true);
  });
  it("returns original error contracts and leaves no story for invalid rows/metadata/header", async () => {
    const { app, character } = await setup();
    for (const text of ["{broken", JSON.stringify({ unexpected: true }), `${JSON.stringify(header)}\n${JSON.stringify({ mes: 5 })}`,
      JSON.stringify({ user_name: "Reader", chat_metadata: [] })]) {
      const response = await send(app, character.avatar, text); expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ error: true });
    }
    expect((await app.inject({ method: "GET", url: "/api/conversations" })).json().total).toBe(0);
    expect((await send(app, "missing.png")).statusCode).toBe(404);
    expect((await send(app, character.avatar, content, "json")).statusCode).toBe(400);
    for (const original of [{ user_name: "Reader", unknown: 1 }, { name: "Named", unknown: 2 }, { chat_metadata: {}, unknown: 3 }]) {
      const imported = await send(app, character.avatar, JSON.stringify(original));
      expect(await read(app, character.avatar, imported.json().fileNames[0])).toEqual([original]);
    }
  });
  it("preserves past native timestamps and sends imported narrator messages as system in actual prompt preview", async () => {
    const { app, character } = await setup();
    const response = await send(app, character.avatar, [header,
      { name: "Narrator", is_user: false, mes: "THE ROOM IS DARK", send_date: "2020-01-02T03:04:05.000Z", extra: { type: "narrator", variables: { saved: true } } },
      { name: "Hidden", is_user: false, is_system: true, mes: "HIDDEN DISPLAY SYSTEM" }].map(value => JSON.stringify(value)).join("\n"));
    const id = response.json().fileNames[0].replace(/\.jsonl$/, "");
    const stored = (await app.inject({ method: "GET", url: `/api/conversations/${id}` })).json();
    expect(stored.messages[0].createdAt).toBe("2020-01-02T03:04:05.000Z");
    expect(stored.messages[0].extensionData.extra).toEqual({ type: "narrator", variables: { saved: true } });
    await app.inject({ method: "PUT", url: "/api/settings/provider", payload: { kind: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "test-model" } });
    await app.inject({ method: "PUT", url: "/api/extensions/settings", payload: { extensionSettings: { __mycompanion_openai: { settings: { names_behavior: 1 } } } } });
    const preview = await app.inject({ method: "POST", url: `/api/conversations/${id}/prompt-preview`, payload: { draft: "What happened?" } });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().messages.some((message: { role: string; content: string }) => message.role === "system" && message.content.includes("THE ROOM IS DARK"))).toBe(true);
    expect(preview.json().messages.find((message: { content: string }) => message.content.includes("THE ROOM IS DARK"))?.name).toBe("Narrator");
    expect(JSON.stringify(preview.json().messages)).not.toContain("HIDDEN DISPLAY SYSTEM");
  });
  it("accepts each original header discriminator and commits no partial rows on SQLite failure", () => {
    const database = new DatabaseSync(":memory:"), characters = new CharacterRepository(database), runtime = new RuntimeRepository(database);
    try {
      const imported = characters.import(parseCharacterCardDocument({ name: "Target", description: "", personality: "", scenario: "", first_mes: "", mes_example: "" }), "");
      const stored = characters.getStored(imported.character.id)!;
      for (const key of ["user_name", "name", "chat_metadata"]) {
        const file = importChatJsonl(runtime, stored, Buffer.from(JSON.stringify({ [key]: key === "chat_metadata" ? {} : "x" })), key);
        expect(runtime.getConversation(file.replace(/\.jsonl$/, ""))?.messageCount).toBe(0);
      }
      const count = runtime.listConversations().total;
      database.exec("CREATE TEMP TRIGGER fail_import BEFORE INSERT ON messages WHEN NEW.content = 'Second' BEGIN SELECT RAISE(ABORT, 'import write failed'); END");
      expect(() => importChatJsonl(runtime, stored, Buffer.from(content), "Failure")).toThrow("import write failed");
      expect(runtime.listConversations().total).toBe(count);
      expect((database.prepare("SELECT count(*) n FROM messages").get() as { n: number }).n).toBe(0);
      database.exec("DROP TRIGGER fail_import");
      expect(importChatJsonl(runtime, stored, Buffer.from(content), randomUUID())).toMatch(/\.jsonl$/);
    } finally { database.close(); }
  });
});
