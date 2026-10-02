import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { parseCharacterCardDocument } from "@mycompanion/character-card";
import { toExtensionChatState, type BackupPayload, type ChatMessage, type ConversationDetail, type MemoryRecord } from "@mycompanion/shared";
import { applyRestore, assembleBackupPayload, backupChecksum, verifyBackupPayload } from "./backup.js";
import { buildApp } from "./app.js";
import { CharacterRepository } from "./character-repository.js";
import { RuntimeRepository } from "./runtime-repository.js";

type App = ReturnType<typeof buildApp>;
const resources: Array<{ app: App; database: DatabaseSync; path: string }> = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.app.close(); resource.database.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(resource.path + suffix, { force: true });
  }
  vi.unstubAllGlobals();
});

function setup() {
  const path = join(tmpdir(), `derived-state-${randomUUID()}.sqlite`);
  const app = buildApp({ databasePath: path }), database = new DatabaseSync(path);
  const resource = { app, database, path }; resources.push(resource);
  const runtime = new RuntimeRepository(database), characters = new CharacterRepository(database);
  const card = parseCharacterCardDocument({ spec: "chara_card_v2", spec_version: "2.0", data: {
    name: "Derived fixture", description: "Original MyCompanion regression fixture", first_mes: "Opening source", personality: "",
    scenario: "", mes_example: "", creator_notes: "", system_prompt: "", post_history_instructions: "", alternate_greetings: [],
    tags: [], creator: "MyCompanion", character_version: "1", extensions: {},
  } });
  const character = characters.import(card, "derived.json").character;
  const created = runtime.createConversation(character);
  runtime.addMessage(created.id, "user", "First user source");
  runtime.addMessage(created.id, "assistant", "First reply source");
  runtime.addMessage(created.id, "user", "Later user descendant");
  runtime.addMessage(created.id, "assistant", "Later reply descendant");
  const original = runtime.getConversation(created.id)!;
  runtime.setAutoSummaryEnabled(original.id, false);
  const memory = (sources: ChatMessage[], content = "continue SECRET_MEMORY_FROM_SOURCE", status: MemoryRecord["status"] = "active") => runtime.addMemory({
    id: randomUUID(), conversationId: original.id, characterId: character.id, type: "fact", content, scope: "story", importance: 5,
    status, pinned: true, sourceMessageIds: sources.map(message => message.id), supersededBy: null, previousContent: null,
    createdAt: "2026-10-02T00:00:00.000Z", lastUsedAt: null,
  });
  const edit = async (message: ChatMessage, content: string): Promise<ChatMessage> => {
    const response = await resource.app.inject({ method: "PATCH", url: `/api/conversations/${original.id}/messages/${message.id}`, payload: { content } });
    expect(response.statusCode, response.body).toBe(200); return response.json();
  };
  const activate = async (branchId: string): Promise<ConversationDetail> => {
    const response = await resource.app.inject({ method: "POST", url: `/api/conversations/${original.id}/branches/${branchId}/activate` });
    expect(response.statusCode, response.body).toBe(200); return response.json().conversation;
  };
  const remove = async (message: ChatMessage) => {
    const response = await resource.app.inject({ method: "DELETE", url: `/api/conversations/${original.id}/messages/${message.id}` });
    expect(response.statusCode, response.body).toBe(200); return response.json().conversation as ConversationDetail;
  };
  const extensionEdit = async (messageId: string, content: string) => {
    const current = runtime.getConversation(original.id)!, base = toExtensionChatState(current), next = structuredClone(base);
    next.messages.find(message => message.id === messageId)!.mes = content;
    const response = await resource.app.inject({ method: "PUT", url: `/api/conversations/${original.id}/extension-state`,
      payload: { branchId: current.activeBranchId, base, next } });
    expect(response.statusCode, response.body).toBe(200); return response.json() as ConversationDetail;
  };
  const restart = async () => {
    await resource.app.close(); resource.database.close();
    resource.app = buildApp({ databasePath: path }); resource.database = new DatabaseSync(path);
    return { runtime: new RuntimeRepository(resource.database), characters: new CharacterRepository(resource.database) };
  };
  return { resource, runtime, characters, character, original, memory, edit, activate, remove, extensionEdit, restart };
}
const resign = (backup: BackupPayload) => { backup.manifest.checksum = backupChecksum(backup); return backup; };

it("forks a historical edit with a new message ID and keeps descendants on the original branch", async () => {
  const fixture = setup(), source = fixture.original.messages[2]!;
  const edited = await fixture.edit(source, "Corrected historical reply");
  const current = fixture.runtime.getConversation(fixture.original.id)!;
  expect(edited.id).not.toBe(source.id); expect(edited.branchId).not.toBe(source.branchId);
  expect(current.messages.map(message => message.content)).toEqual(["Opening source", "First user source", "Corrected historical reply"]);
  expect(current.messages.slice(0, 2).map(message => message.id)).toEqual(fixture.original.messages.slice(0, 2).map(message => message.id));
  expect(edited.parentMessageId).toBe(fixture.original.messages[1]!.id);
  expect((await fixture.activate(fixture.original.activeBranchId)).messages).toEqual(fixture.original.messages);
  expect((await fixture.activate(edited.branchId)).messages).toEqual(current.messages);
});

it("keeps an unchanged edit on its original branch and preserves derived state", async () => {
  const fixture = setup(), memory = fixture.memory([fixture.original.messages[2]!]);
  const summary = fixture.runtime.saveSummary(fixture.original.id, "Verified summary", 3, "fixture");
  expect(await fixture.edit(fixture.original.messages[2]!, fixture.original.messages[2]!.content)).toEqual(fixture.original.messages[2]);
  expect(fixture.runtime.listAllBranchMessages(fixture.original.id)).toHaveLength(5);
  expect(fixture.runtime.getMemory(memory.id)?.status).toBe("active");
  expect(fixture.runtime.getSummary(fixture.original.id)).toEqual(summary);
});

it("orphans a multi-source memory even when one source remains reachable and reactivates it on return", async () => {
  const fixture = setup(), memory = fixture.memory(fixture.original.messages.slice(1, 3));
  const prefixMemory = fixture.memory([fixture.original.messages[0]!], "Prefix fact");
  const edited = await fixture.edit(fixture.original.messages[2]!, "Changed reply");
  expect(fixture.runtime.getMemory(memory.id)?.status).toBe("orphaned");
  expect(fixture.runtime.getMemory(prefixMemory.id)?.status).toBe("active");
  const report = await fixture.resource.app.inject({ method: "POST", url: `/api/conversations/${fixture.original.id}/memories/test`, payload: { input: "continue" } });
  expect(report.statusCode, report.body).toBe(200);
  expect(report.json().results.find((item: { memoryId: string }) => item.memoryId === memory.id).injected).toBe(false);
  await fixture.activate(fixture.original.activeBranchId); expect(fixture.runtime.getMemory(memory.id)?.status).toBe("active");
  await fixture.activate(edited.branchId); expect(fixture.runtime.getMemory(memory.id)?.status).toBe("orphaned");
});

it.each(["disabled", "pending", "superseded"] as const)("does not reactivate a deliberately $status memory while switching branches", async status => {
  const fixture = setup(), memory = fixture.memory([fixture.original.messages[2]!], "Protected manual status", status);
  const edited = await fixture.edit(fixture.original.messages[2]!, "Changed reply");
  await fixture.activate(fixture.original.activeBranchId); await fixture.activate(edited.branchId);
  expect(fixture.runtime.getMemory(memory.id)?.status).toBe(status);
});

it("isolates summaries whose covered sources changed while preserving an unchanged prefix summary", async () => {
  const fixture = setup();
  fixture.runtime.saveSummary(fixture.original.id, "Old full summary", 3, "fixture");
  const edited = await fixture.edit(fixture.original.messages[2]!, "Changed reply");
  expect(fixture.runtime.getSummary(fixture.original.id)).toBeUndefined();
  fixture.runtime.saveSummary(fixture.original.id, "New branch summary", 3, "fixture");
  await fixture.activate(fixture.original.activeBranchId);
  expect(fixture.runtime.getSummary(fixture.original.id)).toMatchObject({ content: "Old full summary", branchId: fixture.original.activeBranchId, valid: true });
  await fixture.activate(edited.branchId);
  expect(fixture.runtime.getSummary(fixture.original.id)).toMatchObject({ content: "New branch summary", branchId: edited.branchId, valid: true });
  fixture.runtime.saveSummary(fixture.original.id, "Shared prefix summary", 2, "fixture");
  const next = await fixture.edit(fixture.runtime.getConversation(fixture.original.id)!.messages[2]!, "Changed again");
  expect(fixture.runtime.getSummary(fixture.original.id)).toMatchObject({ content: "Shared prefix summary", branchId: next.branchId, valid: true });
});

it("invalidates a summary and source memory immediately after deleting a covered message", async () => {
  const fixture = setup(), source = fixture.original.messages[0]!, memory = fixture.memory([source]);
  fixture.runtime.saveSummary(fixture.original.id, "STALE_SUMMARY_MARKER", 3, "fixture");
  await fixture.remove(source);
  expect(fixture.runtime.getMemory(memory.id)?.status).toBe("orphaned");
  expect(fixture.runtime.getSummary(fixture.original.id)).toMatchObject({ content: "STALE_SUMMARY_MARKER", valid: false });
  const summaryResponse = await fixture.resource.app.inject({ method: "GET", url: `/api/conversations/${fixture.original.id}/summary` });
  expect(summaryResponse.json().summary.valid).toBe(false);
  let prompt = "";
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { stream: boolean; messages: unknown };
    if (!body.stream) return Response.json({ choices: [{ message: { content: "[]" } }] });
    prompt = JSON.stringify(body.messages);
    return new Response('data: {"choices":[{"delta":{"content":"Fresh reply"},"finish_reason":"stop"}]}\n\n', { headers: { "Content-Type": "text/event-stream" } });
  }));
  await fixture.resource.app.inject({ method: "PUT", url: "/api/settings/provider", payload: { kind: "ollama", baseUrl: "http://derived.test/v1", model: "fixture" } });
  const reply = await fixture.resource.app.inject({ method: "POST", url: `/api/conversations/${fixture.original.id}/messages`, payload: { content: "continue" } });
  expect(reply.statusCode, reply.body).toBe(200);
  expect(prompt).not.toContain("STALE_SUMMARY_MARKER"); expect(prompt).not.toContain("SECRET_MEMORY_FROM_SOURCE");
});

it("checks the source revision when an extension changes text while retaining the message ID", async () => {
  const fixture = setup(), source = fixture.original.messages[2]!, memory = fixture.memory([source]);
  const summary = fixture.runtime.saveSummary(fixture.original.id, "Original source summary", 3, "fixture");
  const edited = await fixture.extensionEdit(source.id, "Extension changed the source text");
  expect(edited.activeBranchId).toBe(fixture.original.activeBranchId); expect(edited.messages[2]!.id).toBe(source.id);
  expect(fixture.runtime.getMemory(memory.id)?.status).toBe("orphaned");
  expect(fixture.runtime.getSummary(fixture.original.id)).toMatchObject({ valid: false });
  expect(fixture.runtime.isMessageSnapshotCurrent(fixture.original.id, fixture.original.activeBranchId, [source])).toBe(false);
  expect(fixture.runtime.isMessageSnapshotCurrent(fixture.original.id, fixture.original.activeBranchId, fixture.original.messages.slice(0, 3), true)).toBe(false);
  await fixture.extensionEdit(source.id, source.content);
  expect(fixture.runtime.getMemory(memory.id)?.status).toBe("active");
  expect(fixture.runtime.getSummary(fixture.original.id)).toEqual(summary);
});

it("does not invalidate sources for extension metadata-only saves", async () => {
  const fixture = setup(), source = fixture.original.messages[2]!, memory = fixture.memory([source]);
  const summary = fixture.runtime.saveSummary(fixture.original.id, "Verified source summary", 3, "fixture");
  const base = toExtensionChatState(fixture.original), next = structuredClone(base);
  next.metadata.variables = { progress: 4 }; next.messages[2]!.extra = { image: "fixture.png" };
  const saved = await fixture.resource.app.inject({ method: "PUT", url: `/api/conversations/${fixture.original.id}/extension-state`,
    payload: { branchId: fixture.original.activeBranchId, base, next } });
  expect(saved.statusCode, saved.body).toBe(200);
  expect(fixture.runtime.getMemory(memory.id)?.status).toBe("active"); expect(fixture.runtime.getSummary(fixture.original.id)).toEqual(summary);
  expect(fixture.runtime.isMessageSnapshotCurrent(fixture.original.id, fixture.original.activeBranchId, [source])).toBe(true);
});

it("restores a summary's previous source revision without marking stale previous text valid", async () => {
  const fixture = setup(); fixture.runtime.saveSummary(fixture.original.id, "Old summary", 3, "fixture");
  await fixture.extensionEdit(fixture.original.messages[2]!.id, "Edited source on same branch");
  expect(fixture.runtime.getSummary(fixture.original.id)?.valid).toBe(false);
  expect(fixture.runtime.editSummary(fixture.original.id, "Reviewed new source summary")).toMatchObject({ valid: true, previousContent: "Old summary" });
  expect(fixture.runtime.restoreSummary(fixture.original.id)).toMatchObject({ content: "Old summary", valid: false, previousContent: null });
});

it("persists isolated branch summaries and source revisions across a service restart", async () => {
  const fixture = setup(), memory = fixture.memory([fixture.original.messages[2]!]);
  fixture.runtime.saveSummary(fixture.original.id, "Original branch summary", 3, "fixture");
  const edited = await fixture.edit(fixture.original.messages[2]!, "New reply");
  fixture.runtime.saveSummary(fixture.original.id, "Edited branch summary", 3, "fixture");
  const reopened = await fixture.restart();
  expect(reopened.runtime.getSummary(fixture.original.id)).toMatchObject({ content: "Edited branch summary", branchId: edited.branchId, valid: true });
  expect(reopened.runtime.getMemory(memory.id)).toMatchObject({ status: "orphaned", sourceMessageFingerprints: memory.sourceMessageFingerprints });
  await fixture.activate(fixture.original.activeBranchId);
  expect(reopened.runtime.getSummary(fixture.original.id)).toMatchObject({ content: "Original branch summary", valid: true });
  expect(reopened.runtime.getMemory(memory.id)?.status).toBe("active");
});

it("migrates a legacy story-level summary as preserved content with an unverified source", async () => {
  const fixture = setup();
  fixture.resource.database.exec(`DROP TABLE stage_summaries;
    CREATE TABLE stage_summaries (conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      content TEXT NOT NULL, covered_message_count INTEGER NOT NULL DEFAULT 0, model TEXT NOT NULL,
      previous_content TEXT, created_at TEXT NOT NULL);`);
  fixture.resource.database.prepare("INSERT INTO stage_summaries VALUES (?, ?, 3, 'legacy', NULL, ?)")
    .run(fixture.original.id, "Legacy preserved summary", "2026-10-02T00:00:00.000Z");
  const reopened = await fixture.restart();
  expect(reopened.runtime.getSummary(fixture.original.id)).toMatchObject({ content: "Legacy preserved summary", branchId: fixture.original.activeBranchId, valid: false });
  expect(reopened.runtime.editSummary(fixture.original.id, "Explicitly reviewed summary")?.valid).toBe(true);
});

it("round-trips both branch summaries and orphaned memories through a complete backup", async () => {
  const fixture = setup(), memory = fixture.memory([fixture.original.messages[2]!]);
  fixture.runtime.saveSummary(fixture.original.id, "Original branch summary", 3, "fixture");
  const edited = await fixture.edit(fixture.original.messages[2]!, "Edited branch reply");
  fixture.runtime.saveSummary(fixture.original.id, "Edited branch summary", 3, "fixture");
  const backup = assembleBackupPayload(fixture), target = setup();
  expect(backup.stageSummaries.filter(summary => summary.conversationId === fixture.original.id)).toHaveLength(2);
  expect(verifyBackupPayload(backup).valid).toBe(true); applyRestore(backup, target, "overwrite");
  expect(target.runtime.getSummary(fixture.original.id)).toMatchObject({ content: "Edited branch summary", branchId: edited.branchId, valid: true });
  expect(target.runtime.getMemory(memory.id)?.status).toBe("orphaned");
  target.runtime.activateBranch(fixture.original.id, fixture.original.activeBranchId); target.runtime.syncMemoryReachability(fixture.original.id);
  expect(target.runtime.getSummary(fixture.original.id)).toMatchObject({ content: "Original branch summary", valid: true });
  expect(target.runtime.getMemory(memory.id)?.status).toBe("active");
});

it("applies skip to each summary branch even when another branch is active", async () => {
  const fixture = setup(); fixture.runtime.saveSummary(fixture.original.id, "Original summary", 3, "fixture");
  const edited = await fixture.edit(fixture.original.messages[2]!, "Edited reply");
  fixture.runtime.saveSummary(fixture.original.id, "Edited summary", 3, "fixture");
  const backup = assembleBackupPayload(fixture), target = setup(); applyRestore(backup, target, "overwrite");
  const changed = structuredClone(backup); for (const summary of changed.stageSummaries) summary.content += " incoming overwrite";
  resign(changed); target.runtime.activateBranch(fixture.original.id, fixture.original.activeBranchId);
  applyRestore(changed, target, "skip");
  expect(target.runtime.getSummary(fixture.original.id)?.content).toBe("Original summary");
  target.runtime.activateBranch(fixture.original.id, edited.branchId);
  expect(target.runtime.getSummary(fixture.original.id)?.content).toBe("Edited summary");
});

it("restores old backup summaries without source metadata as invalid preserved content", () => {
  const fixture = setup(); fixture.runtime.saveSummary(fixture.original.id, "Legacy backup summary", 3, "fixture");
  const backup = assembleBackupPayload(fixture), summary = backup.stageSummaries[0]!;
  delete summary.branchId; delete summary.sourceMessageIds; delete summary.sourceFingerprint; delete summary.previousSource; resign(backup);
  expect(verifyBackupPayload(backup).valid).toBe(true);
  const target = setup(); applyRestore(backup, target, "overwrite");
  expect(target.runtime.getSummary(fixture.original.id)).toMatchObject({ content: "Legacy backup summary", branchId: fixture.original.activeBranchId, valid: false });
});

it.each(["foreign-branch", "foreign-story-source", "previous-source"] as const)("rejects a backup summary with %s references", async kind => {
  const fixture = setup(); fixture.runtime.saveSummary(fixture.original.id, "Source summary", 3, "fixture");
  const other = fixture.runtime.createConversation(fixture.character);
  await fixture.edit(fixture.original.messages[2]!, "Other branch source");
  await fixture.activate(fixture.original.activeBranchId);
  const backup = assembleBackupPayload(fixture), summary = backup.stageSummaries[0]!;
  if (kind === "foreign-branch") summary.branchId = other.activeBranchId;
  if (kind === "foreign-story-source") summary.sourceMessageIds = [other.messages[0]!.id];
  if (kind === "previous-source") summary.previousSource = { sourceMessageIds: [other.messages[0]!.id], sourceFingerprint: "", coveredMessageCount: 1 };
  resign(backup);
  const result = verifyBackupPayload(backup);
  expect(result.valid).toBe(false); expect(result.errors.some(error => error.includes("阶段摘要"))).toBe(true);
  const target = setup(); expect(() => applyRestore(backup, target, "overwrite")).toThrow(/阶段摘要/);
  expect(target.runtime.conversationExists(fixture.original.id)).toBe(false);
});

it.each(["deleted-source", "reordered-sources", "removed-historical-branch"] as const)("preserves %s summary history during backup restore without injecting it", kind => {
  const fixture = setup(); fixture.runtime.saveSummary(fixture.original.id, "Stale preserved summary", 3, "fixture");
  const backup = assembleBackupPayload(fixture), summary = backup.stageSummaries[0]!;
  if (kind === "deleted-source") summary.sourceMessageIds = [randomUUID()];
  if (kind === "reordered-sources") summary.sourceMessageIds!.reverse();
  if (kind === "removed-historical-branch") summary.branchId = randomUUID();
  if (kind === "removed-historical-branch") summary.sourceMessageIds = []; // That branch has no surviving messages.
  resign(backup); expect(verifyBackupPayload(backup).valid).toBe(true);
  const target = setup(); applyRestore(backup, target, "overwrite");
  if (kind === "removed-historical-branch") {
    expect(target.runtime.getSummary(fixture.original.id)).toBeUndefined();
    expect(target.runtime.listStageSummariesForBackup().find(item => item.branchId === summary.branchId)?.content).toBe("Stale preserved summary");
  } else expect(target.runtime.getSummary(fixture.original.id)).toMatchObject({ content: "Stale preserved summary", valid: false });
});

it("backs up a deleted source that still survives on another branch as invalid preserved history", async () => {
  const fixture = setup(), source = fixture.original.messages[0]!;
  fixture.runtime.saveSummary(fixture.original.id, "Summary of the shared opening", 2, "fixture");
  const edited = await fixture.edit(fixture.original.messages[2]!, "Forked reply");
  expect(fixture.runtime.getSummary(fixture.original.id)?.valid).toBe(true);
  await fixture.remove(source);
  expect(fixture.runtime.getSummary(fixture.original.id)).toMatchObject({ content: "Summary of the shared opening", valid: false });
  const backup = assembleBackupPayload(fixture), target = setup();
  expect(backup.conversations[0]!.messages.some(message => message.id === source.id && message.branchId === fixture.original.activeBranchId)).toBe(true);
  expect(verifyBackupPayload(backup).valid).toBe(true); applyRestore(backup, target, "overwrite");
  expect(target.runtime.getSummary(fixture.original.id)).toMatchObject({ branchId: edited.branchId, valid: false });
  target.runtime.activateBranch(fixture.original.id, fixture.original.activeBranchId);
  expect(target.runtime.getSummary(fixture.original.id)).toMatchObject({ content: "Summary of the shared opening", valid: true });
});
