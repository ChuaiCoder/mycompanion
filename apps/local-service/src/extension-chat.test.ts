import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationDetailSchema, toExtensionChatState, type ConversationDetail, type ExtensionChatState } from "@mycompanion/shared";
import { buildApp } from "./app.js";
import { backupChecksum } from "./backup.js";

type App = ReturnType<typeof buildApp>;
const apps: App[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); vi.unstubAllGlobals(); });
async function setup(app: App): Promise<ConversationDetail> {
  const imported = await app.inject({ method: "POST", url: "/api/characters/import/commit", payload: {
    filename: "extension-chat.json", card: { spec: "chara_card_v2", spec_version: "2.0", data: {
      name: "Fixture", description: "Description", first_mes: "Opening", personality: "", scenario: "", mes_example: "",
      creator_notes: "", system_prompt: "", post_history_instructions: "", alternate_greetings: [], tags: [], creator: "MyCompanion", character_version: "1", extensions: {},
    } },
  } });
  expect(imported.statusCode).toBe(201);
  const response = await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: imported.json().id } });
  return conversationDetailSchema.parse(response.json());
}
const read = async (app: App, id: string) => conversationDetailSchema.parse((await app.inject({ method: "GET", url: `/api/conversations/${id}` })).json());
async function save(app: App, conversation: ConversationDetail, next: ExtensionChatState): Promise<ConversationDetail> {
  const response = await app.inject({ method: "PUT", url: `/api/conversations/${conversation.id}/extension-state`, payload: {
    branchId: conversation.activeBranchId, base: toExtensionChatState(conversation), next,
  } });
  expect(response.statusCode, response.body).toBe(200);
  return conversationDetailSchema.parse(response.json());
}

describe("real extension chat persistence", () => {
  it.each([false,true])("does not rewrite durable messages or timestamps for an unchanged extension snapshot (stale=%s)",async stale=>{
    const app=buildApp();apps.push(app);
    const original=await setup(app);
    await app.inject({method:"PUT",url:"/api/settings/provider",payload:{kind:"ollama",baseUrl:"http://provider.test/v1",model:"fixture"}});
    vi.stubGlobal("fetch",async()=>Response.json({choices:[{message:{content:"Native reply"}}]}));
    const generated=await app.inject({method:"POST",url:`/api/conversations/${original.id}/messages`,payload:{content:"Native input"}});
    expect(generated.statusCode,generated.body).toBe(200);
    const before=await read(app,original.id);
    expect(before.messages.at(-1)?.extensionData).toBeUndefined();
    const snapshot=stale?original:before;
    const result=await save(app,snapshot,toExtensionChatState(snapshot));
    expect(result).toEqual(before);
    expect(await read(app,original.id)).toEqual(before);
  });

  it("persists message content, ordering, arbitrary fields and metadata across migration/reopen", async () => {
    const path = join(tmpdir(), `mycompanion-extension-chat-${randomUUID()}.sqlite`);
    let app = buildApp({ databasePath: path });
    try {
      let conversation = await setup(app);
      await app.close();
      const legacy = new DatabaseSync(path);
      legacy.exec("ALTER TABLE messages DROP COLUMN extension_data_json; ALTER TABLE conversations DROP COLUMN metadata_json");
      legacy.close();
      app = buildApp({ databasePath: path });
      expect((await read(app, conversation.id)).messages.map(message => message.id)).toEqual(conversation.messages.map(message => message.id));
      const next = toExtensionChatState(conversation);
      next.messages[0]!.mes = "Edited opening";
      next.messages[0]!.variables = [{ nested: { count: 2 }, flags: [true, null] }, { alternate: "second" }];
      next.messages[0]!.swipes = ["Edited opening", "Alternative"];
      next.messages[0]!.swipe_id = 0;
      next.messages[0]!.swipe_info = [{ extra: { image: "local.png" } }];
      next.messages.unshift({ id: randomUUID(), mes: "Inserted first", is_user: true, name: "Player", extra: { future: { unicode: "你好" } } });
      next.metadata = { variables: { score: 7 }, scripts: ["const answer = 42;"], future: { list: [null, false, []] } };
      conversation = await save(app, conversation, next);
      expect(conversation.messages.map(message => message.content)).toEqual(["Inserted first", "Edited opening"]);
      expect(conversation.messages[1]!.parentMessageId).toBe(conversation.messages[0]!.id);
      await app.close(); app = buildApp({ databasePath: path });
      expect(await read(app, conversation.id)).toEqual(conversation);
      const reordered = toExtensionChatState(conversation); reordered.messages.reverse();
      conversation = await save(app, conversation, reordered);
      expect(conversation.messages.map(message => message.content)).toEqual(["Edited opening", "Inserted first"]);
      expect(conversation.messages[0]!.parentMessageId).toBeNull();
      const removed = toExtensionChatState(conversation); removed.messages.splice(0, 1); delete removed.metadata.future;
      conversation = await save(app, conversation, removed);
      expect(conversation.messages).toHaveLength(1); expect(conversation.chatMetadata).not.toHaveProperty("future");
    } finally {
      await app.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    }
  });

  it("merges independent changes and never deletes messages appended after a snapshot", async () => {
    const app = buildApp(); apps.push(app);
    const original = await setup(app), first = toExtensionChatState(original), second = toExtensionChatState(original);
    first.messages[0]!.variables = [{ source: "first" }]; first.metadata.variables = { first: true };
    await save(app, original, first);
    second.messages[0]!.mes = "Changed by second"; second.metadata.note = "second";
    let stored = await save(app, original, second);
    expect(stored.messages[0]!.extensionData?.variables).toEqual([{ source: "first" }]);
    expect(stored.chatMetadata).toEqual({ variables: { first: true }, note: "second" });
    const add = toExtensionChatState(stored);
    add.messages.push({ id: randomUUID(), mes: "Concurrent new message", is_user: false });
    await save(app, stored, add);
    stored = await save(app, original, second);
    expect(stored.messages.map(message => message.content)).toEqual(["Changed by second", "Concurrent new message"]);
    const remove = toExtensionChatState(stored); remove.messages.shift();
    await save(app, stored, remove);
    stored = await save(app, original, first);
    expect(stored.messages.map(message => message.content)).toEqual(["Concurrent new message"]);
  });

  it("includes extension data in story/backup exports, restore policies and legacy checksums", async () => {
    const source = buildApp(), target = buildApp(); apps.push(source, target);
    const original = await setup(source), next = toExtensionChatState(original);
    next.metadata.variables = { saved: 42 }; next.messages[0]!.variables = [{ saved: "floor" }];
    const saved = await save(source, original, next);
    const exported = (await source.inject({ method: "GET", url: `/api/conversations/${saved.id}/export?format=json` })).json();
    expect(exported.conversation.chatMetadata).toEqual(saved.chatMetadata);
    expect(exported.messages[0].extensionData.variables).toEqual([{ saved: "floor" }]);
    const backup = (await source.inject({ method: "GET", url: "/api/backup" })).json();
    const restore = (strategy: string) => target.inject({ method: "POST", url: "/api/backup/restore", payload: { backup, strategy } });
    expect((await restore("skip")).statusCode).toBe(200);
    expect((await read(target, saved.id)).chatMetadata).toEqual(saved.chatMetadata);
    const local = toExtensionChatState(saved); local.metadata.variables = { local: true };
    await save(target, saved, local);
    await restore("skip"); expect((await read(target, saved.id)).chatMetadata?.variables).toEqual({ local: true });
    await restore("overwrite"); expect((await read(target, saved.id)).chatMetadata).toEqual(saved.chatMetadata);
    for (const item of backup.conversations) {
      delete item.chatMetadata;
      for (const message of item.messages) delete message.extensionData;
    }
    backup.manifest.checksum = backupChecksum(backup);
    expect((await restore("overwrite")).statusCode).toBe(200);
    expect((await read(target, saved.id)).messages[0]!.extensionData?.variables).toEqual([{ saved: "floor" }]);
    expect((await read(target, saved.id)).chatMetadata).toEqual(saved.chatMetadata);
  });

  it("uses saved edits in the real prompt, excludes hidden messages and retains fields when copying a branch", async () => {
    const app = buildApp(); apps.push(app);
    const requests: Array<{ messages: Array<{ content: string }> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: "Reply" } }] }), { headers: { "Content-Type": "application/json" } });
    }));
    const original = await setup(app), next = toExtensionChatState(original);
    next.messages[0]!.mes = "Extension edited opening"; next.messages[0]!.variables = [{ retained: true }];
    next.messages.push({ id: randomUUID(), mes: "Hidden from prompt", is_user: false, is_system: true });
    await save(app, original, next);
    await app.inject({ method: "PUT", url: "/api/settings/provider", payload: { kind: "ollama", baseUrl: "http://localhost:11434/v1", model: "fixture" } });
    const sent = await app.inject({ method: "POST", url: `/api/conversations/${original.id}/messages`, payload: { content: "User input" } });
    expect(sent.statusCode).toBe(200);
    expect(JSON.stringify(requests[0])).toContain("Extension edited opening");
    expect(JSON.stringify(requests[0])).not.toContain("Hidden from prompt");
    const regenerated = await app.inject({ method: "POST", url: `/api/conversations/${original.id}/messages/regenerate` });
    expect(regenerated.statusCode).toBe(200);
    expect((await read(app, original.id)).messages[0]!.extensionData?.variables).toEqual([{ retained: true }]);
  });

  it("rejects malformed snapshots atomically and does not write into a different story", async () => {
    const app = buildApp(); apps.push(app);
    const original = await setup(app), other = await setup(app);
    const base = toExtensionChatState(original), next = structuredClone(base);
    next.messages.push(next.messages[0]!);
    const request = (branchId: string, value: ExtensionChatState) => app.inject({ method: "PUT", url: `/api/conversations/${original.id}/extension-state`, payload: { branchId, base, next: value } });
    expect((await request(original.activeBranchId, next)).statusCode).toBe(400);
    expect((await request(other.activeBranchId, base)).statusCode).toBe(409);
    expect(await read(app, original.id)).toEqual(original);
    expect(await read(app, other.id)).toEqual(other);
  });
});
