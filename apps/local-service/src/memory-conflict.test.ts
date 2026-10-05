import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { parseCharacterCardDocument } from "@mycompanion/character-card";
import { type MemoryRecord } from "@mycompanion/shared";
import { buildApp } from "./app.js";
import { CharacterRepository } from "./character/character-repository.js";
import { RuntimeRepository } from "./persistence/runtime-repository.js";
import { applyRestore, assembleBackupPayload, backupChecksum, verifyBackupPayload } from "./storage/backup.js";

const resources: Array<{ app: ReturnType<typeof buildApp>; database: DatabaseSync; path: string }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const resource of resources.splice(0)) {
    await resource.app.close(); resource.database.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(resource.path + suffix, { force: true });
  }
});

it("checks retrieval existence without hydrating the message tree and returns 404 for missing stories", async () => {
  const f = setup(), read = vi.spyOn(RuntimeRepository.prototype, "getConversation");
  const response = await f.resource.app.inject({ method: "POST", url: `/api/conversations/${f.story.id}/memories/test`, payload: { input: "位置" } });
  expect(response.statusCode).toBe(200); expect(read).not.toHaveBeenCalled();
  const missing = await f.resource.app.inject({ method: "POST", url: `/api/conversations/${randomUUID()}/memories/test`, payload: { input: "位置" } });
  expect(missing.statusCode).toBe(404); expect(missing.json().error.code).toBe("CONVERSATION_NOT_FOUND");
  expect(read).not.toHaveBeenCalled();
});

function setup(quote = "玩家的位置从北京搬到上海。") {
  const path = join(tmpdir(), `memory-conflict-${randomUUID()}.sqlite`);
  const app = buildApp({ databasePath: path }), database = new DatabaseSync(path);
  const resource = { app, database, path }; resources.push(resource);
  const runtime = new RuntimeRepository(database), characters = new CharacterRepository(database);
  const card = parseCharacterCardDocument({ spec: "chara_card_v2", spec_version: "2.0", data: {
    name: "Memory fixture", description: "Original MyCompanion fixture", first_mes: "开始。", personality: "", scenario: "",
    mes_example: "", creator_notes: "", system_prompt: "", post_history_instructions: "", alternate_greetings: [], tags: [],
    creator: "MyCompanion", character_version: "1", extensions: {},
  } });
  const character = characters.import(card, "memory.json").character;
  const story = runtime.createConversation(character);
  const beforeUser = runtime.addMessage(story.id, "user", "玩家的位置是北京。");
  const beforeAssistant = runtime.addMessage(story.id, "assistant", "确认当前位置。");
  const afterUser = runtime.addMessage(story.id, "user", quote);
  const afterAssistant = runtime.addMessage(story.id, "assistant", "新的当前位置已确认。");
  const make = (later = false, patch: Partial<MemoryRecord> = {}): MemoryRecord => ({
    id: randomUUID(), conversationId: story.id, characterId: character.id, type: "state", scope: "story", importance: 4,
    content: later ? "玩家现在在上海。" : "玩家在北京。", status: "active", pinned: false, manuallyEdited: false,
    sourceMessageIds: later ? [afterUser.id, afterAssistant.id] : [beforeUser.id, beforeAssistant.id],
    supersededBy: null, previousContent: null, createdAt: "2026-10-02T00:00:00.000Z", lastUsedAt: null,
    claim: { subject: "玩家", predicate: "位置", value: later ? "上海" : "北京", temporality: "current",
      ...(later ? { transition: { from: "北京", sourceMessageId: afterUser.id, quote } } : {}) }, ...patch,
  });
  const add = (record: MemoryRecord) => runtime.withTransaction(() => {
    runtime.recordSupersession(record); return runtime.addMemory(record);
  });
  const update = async (record: MemoryRecord, payload: Record<string, unknown>) => {
    const response = await app.inject({ method: "PUT", url: `/api/conversations/${story.id}/memories/${record.id}`, payload });
    expect(response.statusCode, response.body).toBe(200); return response.json() as MemoryRecord;
  };
  return { resource, runtime, characters, character, story, beforeUser, beforeAssistant, afterUser, afterAssistant, make, add, update };
}

it("supersedes only a verified same-branch temporal change, retaining every source and explicit relation", () => {
  const f = setup(), old = f.add(f.make()), next = f.add(f.make(true));
  expect(f.runtime.getMemory(old.id)).toMatchObject({ status: "superseded", supersededBy: next.id, sourceMessageIds: old.sourceMessageIds });
  expect(next).toMatchObject({ status: "active", reconciliation: { kind: "temporal_update", relatedMemoryIds: [old.id] } });
  expect(next.claim?.transition?.quote).toBe(f.afterUser.content);
});

it.each(["fixed", "edited", "restored-edit", "promoted"])("preserves %s user authority instead of automatically replacing it", async kind => {
  const f = setup(), old = f.add(f.make());
  if (kind === "fixed") await f.update(old, { pinned: true });
  if (kind === "edited" || kind === "restored-edit") {
    await f.update(old, { content: "人工确认玩家仍在北京。" });
    if (kind === "restored-edit") f.runtime.restoreMemory(old.id, "previous_content");
  }
  // 用户能做的"提权"只剩改成全局：角色级已废弃（每次开档独立，不再跨对话共享）。
  if (kind === "promoted") await f.update(old, { scope: "user" });
  const next = f.add(f.make(true));
  expect(f.runtime.getMemory(old.id)).toMatchObject({ status: "active", supersededBy: null });
  expect(next.status).toBe("pending");
  expect(next.reconciliation?.relatedMemoryIds).toContain(old.id);
});

it.each(["forged", "hypothetical", "negated", "wrong-subject", "out-of-order", "hearsay"])
  ("does not grant transition authority to %s evidence", kind => {
    const quote = kind === "hypothetical" ? "如果玩家的位置从北京搬到上海。" : kind === "negated" ? "玩家的位置没有从北京搬到上海。"
      : kind === "hearsay" ? "小王说玩家的位置从北京搬到上海。" : undefined;
    const f = setup(quote), old = f.add(f.make()), incoming = f.make(true);
    if (kind === "forged") incoming.claim!.transition!.quote = "玩家的位置从北京变成上海。";
    if (kind === "wrong-subject") incoming.claim!.subject = "小王";
    if (kind === "out-of-order") incoming.sourceMessageIds = old.sourceMessageIds;
    const next = f.add(incoming);
    expect(f.runtime.getMemory(old.id)?.status).toBe("active");
    expect(next.status).toBe(kind === "wrong-subject" ? "active" : "pending");
    expect(f.runtime.getMemory(old.id)?.supersededBy).toBeNull();
  });

it("classifies paraphrases, stable contradictions and unrelated attributes with actual persisted results", () => {
  const f = setup(), old = f.add(f.make());
  const duplicate = f.add(f.make(true, { content: "北京是玩家现在所在的地方。", claim: { ...old.claim!, transition: undefined } }));
  expect(duplicate).toMatchObject({ status: "pending", reconciliation: { kind: "duplicate" } });
  const conflict = f.add(f.make(true, { claim: { ...old.claim!, value: "上海", temporality: "stable", transition: undefined } }));
  expect(conflict).toMatchObject({ status: "pending", reconciliation: { kind: "conflict" } });
  const unrelated = f.add(f.make(true, { claim: { subject: "玩家", predicate: "出生地", value: "上海", temporality: "stable" } }));
  expect(unrelated.status).toBe("active");
  expect(f.runtime.getMemory(old.id)?.status).toBe("active");
});

it("compares explicit same-slot evidence across fact/state type labels instead of injecting both versions", () => {
  const f = setup(), old = f.add(f.make(false, { type: "fact" })), next = f.add(f.make(true));
  expect(f.runtime.getMemory(old.id)).toMatchObject({ status: "superseded", supersededBy: next.id });
  expect(next.reconciliation?.kind).toBe("temporal_update");
});

it("makes pending adoption an explicit atomic user choice, including a pinned old memory", async () => {
  const f = setup(), old = f.add(f.make(false, { pinned: true })), next = f.add(f.make(true));
  const before = f.runtime.listMemories(f.story.id);
  f.resource.database.exec(`CREATE TRIGGER fail_adoption BEFORE UPDATE ON memories
    WHEN NEW.id = '${next.id}' AND NEW.status = 'active' BEGIN SELECT RAISE(ABORT, 'adoption failure'); END`);
  const failed = await f.resource.app.inject({ method: "PUT", url: `/api/conversations/${f.story.id}/memories/${next.id}`, payload: { status: "active" } });
  expect(failed.statusCode).toBe(500); expect(f.runtime.listMemories(f.story.id)).toEqual(before);
  f.resource.database.exec("DROP TRIGGER fail_adoption");
  const adopted = await f.update(next, { status: "active" });
  expect(adopted).toMatchObject({ status: "active", manuallyEdited: true });
  expect(f.runtime.getMemory(old.id)).toMatchObject({ status: "superseded", pinned: true, supersededBy: next.id });
});

it("rolls back replacement links when a new extracted record cannot be inserted, then permits retry", () => {
  const f = setup(), old = f.add(f.make()), incoming = f.make(true), before = f.runtime.listMemories(f.story.id);
  f.resource.database.exec("CREATE TEMP TRIGGER fail_memory_insert BEFORE INSERT ON memories WHEN NEW.content = '玩家现在在上海。' BEGIN SELECT RAISE(ABORT, 'insertion failure'); END");
  expect(() => f.add(incoming)).toThrow("insertion failure");
  expect(f.runtime.listMemories(f.story.id)).toEqual(before);
  f.resource.database.exec("DROP TRIGGER fail_memory_insert");
  expect(f.add(incoming).status).toBe("active");
  expect(f.runtime.getMemory(old.id)?.supersededBy).toBe(incoming.id);
});

it("keeps rollback history and only injects the branch-valid version during a real branch round trip", async () => {
  const f = setup(), old = f.add(f.make()), next = f.add(f.make(true));
  const edited = await f.resource.app.inject({ method: "PATCH", url: `/api/conversations/${f.story.id}/messages/${f.afterUser.id}`, payload: { content: "玩家继续停留在北京。" } });
  expect(edited.statusCode, edited.body).toBe(200); const branch = edited.json().branchId as string;
  expect(f.runtime.getMemory(old.id)).toMatchObject({ status: "active", supersededBy: next.id });
  expect(f.runtime.getMemory(next.id)?.status).toBe("orphaned");
  const report = await f.resource.app.inject({ method: "POST", url: `/api/conversations/${f.story.id}/memories/test`, payload: { input: "玩家位置" } });
  expect(report.json().results.find((result: { memoryId: string }) => result.memoryId === next.id)?.injected).toBe(false);
  f.runtime.activateBranch(f.story.id, f.story.activeBranchId); f.runtime.syncMemoryReachability(f.story.id);
  expect(f.runtime.getMemory(old.id)).toMatchObject({ status: "superseded", supersededBy: next.id });
  expect(f.runtime.getMemory(next.id)?.status).toBe("active");
  await f.update(old, { status: "disabled" });
  f.runtime.activateBranch(f.story.id, branch); f.runtime.syncMemoryReachability(f.story.id);
  expect(f.runtime.getMemory(old.id)?.status).toBe("disabled");
});

it("restores a superseded record through a replacement chain without reactivating the conflicting latest record", async () => {
  const f = setup(), old = f.add(f.make()), next = f.add(f.make(true));
  const user = f.runtime.addMessage(f.story.id, "user", "玩家的位置从上海搬到南京。"), assistant = f.runtime.addMessage(f.story.id, "assistant", "南京。 ");
  const latest = f.add(f.make(true, { content: "玩家现在在南京。", sourceMessageIds: [user.id, assistant.id], claim: {
    subject: "玩家", predicate: "位置", value: "南京", temporality: "current", transition: { from: "上海", quote: user.content, sourceMessageId: user.id },
  } }));
  const response = await f.resource.app.inject({ method: "POST", url: `/api/conversations/${f.story.id}/memories/${old.id}/restore`, payload: { mode: "supersession" } });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({ status: "active", manuallyEdited: true, supersededBy: null });
  expect(f.runtime.getMemory(next.id)).toMatchObject({ status: "pending", supersededBy: latest.id });
  expect(f.runtime.getMemory(latest.id)?.status).toBe("pending");
  f.runtime.syncMemoryReachability(f.story.id); expect(f.runtime.getMemory(latest.id)?.status).toBe("pending");
});

it("keeps previous-content restoration separate from supersession restoration, with atomic rollback", async () => {
  const f = setup(), old = f.add(f.make(false, { previousContent: "上次人工版本。", manuallyEdited: true }));
  const next = f.add(f.make(true)); await f.update(next, { status: "active" });
  expect(f.runtime.getMemory(old.id)?.status).toBe("superseded");
  const textRestore = await f.resource.app.inject({ method: "POST", url: `/api/conversations/${f.story.id}/memories/${old.id}/restore`, payload: { mode: "previous_content" } });
  expect(textRestore.json()).toMatchObject({ content: "上次人工版本。", previousContent: null, status: "superseded", supersededBy: next.id });
  const before = f.runtime.listMemories(f.story.id);
  f.resource.database.exec(`CREATE TRIGGER fail_restore BEFORE UPDATE ON memories WHEN NEW.id = '${old.id}' AND NEW.status = 'active' BEGIN SELECT RAISE(ABORT, 'restore failure'); END`);
  const fail = await f.resource.app.inject({ method: "POST", url: `/api/conversations/${f.story.id}/memories/${old.id}/restore`, payload: { mode: "supersession" } });
  expect(fail.statusCode).toBe(500); expect(f.runtime.listMemories(f.story.id)).toEqual(before);
  f.resource.database.exec("DROP TRIGGER fail_restore");
  const retry = await f.resource.app.inject({ method: "POST", url: `/api/conversations/${f.story.id}/memories/${old.id}/restore`, payload: { mode: "supersession" } });
  expect(retry.json()).toMatchObject({ content: "上次人工版本。", status: "active" });
  expect(f.runtime.getMemory(next.id)?.status).toBe("pending");
  const invalid = await f.resource.app.inject({ method: "POST", url: `/api/conversations/${f.story.id}/memories/${old.id}/restore`, payload: { mode: "invented" } });
  expect(invalid.statusCode).toBe(400);
});

it("preserves manual protection and verified claim provenance across complete and legacy backup restoration", async () => {
  const f = setup(), old = f.add(f.make()), next = f.add(f.make(true));
  await f.update(next, { content: "玩家在上海（人工确认）。" }); f.runtime.restoreMemory(next.id, "previous_content");
  const backup = assembleBackupPayload(f), target = setup();
  expect(verifyBackupPayload(backup).valid).toBe(true); applyRestore(backup, target, "overwrite");
  expect(target.runtime.getMemory(next.id)).toEqual(f.runtime.getMemory(next.id));
  expect(target.runtime.getMemory(old.id)?.claim).toEqual(old.claim);
  const legacy = structuredClone(backup);
  for (const item of legacy.memories) { delete item.manuallyEdited; delete item.claim; delete item.reconciliation; }
  legacy.memories.find(item => item.id === next.id)!.previousContent = "有人工更正记录。";
  legacy.manifest.checksum = backupChecksum(legacy);
  expect(verifyBackupPayload(legacy).valid).toBe(true); applyRestore(legacy, target, "overwrite");
  expect(target.runtime.getMemory(next.id)?.manuallyEdited).toBe(true);
});

it("migrates legacy manual evidence and preserves protection after restart", async () => {
  const f = setup(), old = f.add(f.make(false, { previousContent: "修改前。" }));
  await f.resource.app.close(); f.resource.database.exec("ALTER TABLE memories DROP COLUMN provenance_json");
  const migrated = new RuntimeRepository(f.resource.database);
  expect(migrated.getMemory(old.id)?.manuallyEdited).toBe(true);
  migrated.restoreMemory(old.id, "previous_content");
  const restarted = new RuntimeRepository(f.resource.database);
  expect(restarted.getMemory(old.id)).toMatchObject({ manuallyEdited: true, previousContent: null, content: "修改前。" });
});
