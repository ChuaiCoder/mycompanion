import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { conversationDetailSchema, toExtensionChatState, type ExtensionChatState } from "@mycompanion/shared";
import { buildApp } from "./app.js";
import { RuntimeRepository } from "./runtime-repository.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), "mycompanion-chat-preservation-"));
  cleanups.push(() => rm(folder, { recursive: true, force: true }));
  const databasePath = join(folder, "runtime.sqlite"), app = buildApp({ databasePath });
  cleanups.push(() => app.close());
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const database = new DatabaseSync(databasePath);
  cleanups.push(async () => database.close());
  const runtime = new RuntimeRepository(database);
  const request = (method: string, path: string, payload?: unknown) => fetch(origin + path, {
    method, ...(payload === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(10_000),
  });
  const created = await request("POST", "/api/characters/create", { ch_name: "Preservation fixture", first_mes: "Opening" });
  expect(created.status).toBe(200);
  const characterResponse = await request("POST", "/api/characters/get", { avatar_url: await created.text() });
  expect(characterResponse.status).toBe(200);
  const character = await characterResponse.json() as { id: string };
  const storyResponse = await request("POST", "/api/conversations", { characterId: character.id });
  expect(storyResponse.status).toBe(201);
  const original = conversationDetailSchema.parse(await storyResponse.json());
  runtime.addMessage(original.id, "user", "Native user text");
  const assistant = runtime.addMessage(original.id, "assistant", "Native assistant text");
  // A saved host response can contain provider state unknown to extensions.
  database.prepare("UPDATE messages SET generation_json = ? WHERE id = ?").run(JSON.stringify({
    model: "fixture", temperature: 0.8, maxTokens: 256,
    finishReason: "stop", completionOutcome: "complete", futureHostField: { retained: [null, true] },
  }), assistant.id);
  const read = async () => {
    const response = await request("GET", `/api/conversations/${original.id}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return conversationDetailSchema.parse(await response.json());
  };
  const save = (base: ExtensionChatState, next: ExtensionChatState) => request("PUT", `/api/conversations/${original.id}/extension-state`, {
    branchId: original.activeBranchId, base, next,
  });
  const rows = () => database.prepare("SELECT rowid AS sequence, * FROM messages WHERE conversation_id = ? ORDER BY rowid").all(original.id);
  return { database, runtime, original, character, read, save, rows };
}

it.each([false, true])("metadata-only HTTP saves preserve every SQLite message row without writes or reachability repair (stale=%s)", async stale => {
  const f = await fixture(), before = await f.read(), base = toExtensionChatState(stale ? f.original : before), next = structuredClone(base);
  next.metadata.savedByExtension = { retained: true, count: 7 };
  // This pre-existing derived state must not be repaired by a metadata save.
  const memory = f.runtime.addMemory({ id: randomUUID(), conversationId: before.id, characterId: f.character.id,
    type: "fact", content: "Existing source memory", scope: "story", importance: 3, status: "orphaned", pinned: false,
    sourceMessageIds: [before.messages[2]!.id], supersededBy: null, previousContent: null,
    createdAt: "2026-10-03T00:00:00.000Z", lastUsedAt: null });
  const messages = f.rows();
  f.database.exec(`
    CREATE TRIGGER reject_metadata_message_insert BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'metadata wrote a message'); END;
    CREATE TRIGGER reject_metadata_message_update BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'metadata wrote a message'); END;
    CREATE TRIGGER reject_metadata_message_delete BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT, 'metadata wrote a message'); END;
    CREATE TRIGGER reject_metadata_memory_update BEFORE UPDATE ON memories BEGIN SELECT RAISE(ABORT, 'metadata repaired reachability'); END;
  `);
  const response = await f.save(base, next);
  expect(response.status, await response.clone().text()).toBe(200);
  const saved = conversationDetailSchema.parse(await response.json());
  expect(saved.messages).toEqual(before.messages);
  expect(saved.chatMetadata).toEqual({ ...before.chatMetadata, savedByExtension: next.metadata.savedByExtension });
  expect(f.rows()).toEqual(messages);
  expect(f.runtime.getMemory(memory.id)?.status).toBe("orphaned");
  expect((await f.read()).messages).toEqual(before.messages);
  expect(saved.updatedAt >= before.updatedAt).toBe(true);
  // Repeating the save remains a full no-op, including the timestamp.
  const repeated = await f.save(toExtensionChatState(saved), toExtensionChatState(saved));
  expect(repeated.status, await repeated.clone().text()).toBe(200);
  expect(conversationDetailSchema.parse(await repeated.json())).toEqual(saved);
});

it("editing one message through HTTP preserves its untouched extension fields and every neighboring native message", async () => {
  const f = await fixture(), before = await f.read(), base = toExtensionChatState(before), next = structuredClone(base);
  next.messages[1]!.mes = "Edited native user text";
  next.messages[1]!.extra = { future: { variables: [null, { retained: true }] } };
  const response = await f.save(base, next);
  expect(response.status, await response.clone().text()).toBe(200);
  const saved = conversationDetailSchema.parse(await response.json());
  expect(saved.messages[0]).toEqual(before.messages[0]);
  expect(saved.messages[2]).toEqual(before.messages[2]);
  expect(saved.messages[1]).toEqual({ ...before.messages[1], content: "Edited native user text",
    extensionData: { extra: next.messages[1]!.extra } });
  expect((await f.read()).messages).toEqual(saved.messages);
});

it("reordering through HTTP changes parent links while preserving native fields and absent extension data", async () => {
  const f = await fixture(), before = await f.read(), base = toExtensionChatState(before), next = structuredClone(base);
  next.messages.reverse();
  const response = await f.save(base, next);
  expect(response.status, await response.clone().text()).toBe(200);
  const saved = conversationDetailSchema.parse(await response.json()), reversed = [...before.messages].reverse();
  expect(saved.messages).toEqual(reversed.map((message, index) => ({ ...message, parentMessageId: reversed[index - 1]?.id ?? null })));
  expect((await f.read()).messages).toEqual(saved.messages);
});

it("a failed metadata-only SQLite update rolls back the metadata and retains all message bytes, then permits retry", async () => {
  const f = await fixture(), before = await f.read(), messages = f.rows(), base = toExtensionChatState(before), next = structuredClone(base);
  next.metadata.failedSave = { count: 9 };
  f.database.exec("CREATE TRIGGER reject_metadata_save BEFORE UPDATE OF metadata_json ON conversations BEGIN SELECT RAISE(ABORT, 'metadata failure'); END");
  const failed = await f.save(base, next);
  expect(failed.status).toBe(500);
  expect(await f.read()).toEqual(before);
  expect(f.rows()).toEqual(messages);
  f.database.exec("DROP TRIGGER reject_metadata_save");
  const retry = await f.save(base, next);
  expect(retry.status, await retry.clone().text()).toBe(200);
  expect((await f.read()).messages).toEqual(before.messages);
  expect((await f.read()).chatMetadata?.failedSave).toEqual(next.metadata.failedSave);
});

it("projection-only attempts to change native status or generation fields do not rewrite durable messages", async () => {
  const f = await fixture(), before = await f.read(), messages = f.rows(), base = toExtensionChatState(before), next = structuredClone(base);
  next.messages[2]!.status = "failed";
  next.messages[2]!.generationMetadata = { model: "forged", usage: { totalTokens: 999999 } };
  next.messages[2]!.content = "forged content alias";
  next.messages[2]!.role = "user";
  const response = await f.save(base, next);
  expect(response.status, await response.clone().text()).toBe(200);
  expect(conversationDetailSchema.parse(await response.json())).toEqual(before);
  expect(f.rows()).toEqual(messages);
});
