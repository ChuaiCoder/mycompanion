import { createServer, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ProviderProfile, ProviderProfiles } from "@mycompanion/shared";
import { buildApp } from "./app.js";
import { createTestCharacter } from "./testing/native-character.js";
import { apps, parseSse, waitFor } from "./testing/helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); for (const cleanup of cleanups.splice(0)) await cleanup(); });
const codec = { seal: (value: string) => Buffer.from(value).toString("base64"), unseal: (value: string) => Buffer.from(value, "base64").toString() };
const settings = { kind: "openai-compatible" as const, baseUrl: "http://profile.example/v1", model: "gpt-4o", temperature: 0.8, maxTokens: 128, contextLimitTokens: 4096 };
async function folder() { const path = await mkdtemp(join(tmpdir(), "mycompanion-task-routing-")); cleanups.push(() => rm(path, { recursive: true, force: true })); return path; }
async function story(app: ReturnType<typeof buildApp>) {
  const character = await createTestCharacter(app, { ch_name: "Task routing", first_mes: "Hello" });
  return (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } })).json();
}
async function add(app: ReturnType<typeof buildApp>, name: string, overrides: Record<string, unknown> = {}): Promise<ProviderProfile> {
  const response = await app.inject({ method: "POST", url: "/api/settings/providers", payload: { name, settings: { ...settings, ...overrides } } });
  expect(response.statusCode, response.body).toBe(201); return response.json();
}
interface Captured { path: string; body: Record<string, any>; authorization: string | undefined }
async function remote(failureModel?: string, holdModel?: string) {
  const requests: Captured[] = [], waiting: Array<() => void> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    requests.push({ path: request.url!, body, authorization: request.headers.authorization });
    const complete = () => {
      if (body.model === failureModel) { response.writeHead(401, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: { message: `Rejected ${request.headers.authorization}` } })); return; }
      if (request.url!.endsWith("/embeddings") || request.url!.endsWith("/api/embed")) {
        response.writeHead(200, { "Content-Type": "application/json" });
        const values = body.input.map(() => [1, 0.1, 0]);
        response.end(JSON.stringify(request.url!.endsWith("/api/embed") ? { embeddings: values } : { data: values.map((embedding: number[], index: number) => ({ index, embedding })) })); return;
      }
      if (body.stream) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: `Reply ${body.model}` }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`); return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      const system = body.messages?.[0]?.content ?? "";
      const content = system.includes("记忆助手") ? '[{"type":"fact","content":"阿岚把黄铜钥匙交给林医生保管。","importance":3}]'
        : system.includes("摘要助手") ? "Earlier story summary." : `Reply ${body.model}`;
      response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }));
    };
    if (body.model === holdModel) waiting.push(complete); else complete();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>(resolve => { waiting.splice(0).forEach(release => release()); server.close(() => resolve()); }));
  return { requests, base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, release: () => waiting.splice(0).forEach(release => release()) };
}

it("migrates the singleton ciphertext once and persists independently named task connections across restart", async () => {
  const databasePath = join(await folder(), "runtime.sqlite"), old = new DatabaseSync(databasePath);
  old.exec("CREATE TABLE provider_settings(singleton INTEGER PRIMARY KEY,kind TEXT,base_url TEXT,model TEXT,api_key_ciphertext TEXT,temperature REAL,max_tokens INTEGER,updated_at TEXT)");
  old.prepare("INSERT INTO provider_settings VALUES(1,?,?,?,?,?,?,?)").run(settings.kind, settings.baseUrl, "legacy-chat", codec.seal("legacy-key"), 0.7, 128, new Date().toISOString()); old.close();
  let app = buildApp({ databasePath, secretCodec: codec }); apps.push(app);
  const first = (await app.inject({ method: "GET", url: "/api/settings/providers" })).json() as ProviderProfiles;
  expect(first.profiles).toHaveLength(1); expect(first.profiles[0]!.settings).toMatchObject({ model: "legacy-chat", hasApiKey: true, contextLimitTokens: 32768 });
  const added = await add(app, "Independent", { model: "other-chat", apiKey: "other-key" });
  await app.inject({ method: "PATCH", url: "/api/settings/provider-tasks", payload: { chat: added.id, summary: first.tasks.chat } });
  await app.close(); app = buildApp({ databasePath, secretCodec: codec }); apps.push(app);
  const restarted = (await app.inject({ method: "GET", url: "/api/settings/providers" })).json() as ProviderProfiles;
  expect(restarted.tasks).toEqual({ chat: added.id, summary: first.tasks.chat, extraction: null, embedding: null });
  expect(restarted.profiles).toHaveLength(2); expect((await app.inject({ method: "GET", url: "/api/settings/provider" })).json().model).toBe("other-chat");
  expect(JSON.stringify(restarted)).not.toContain("legacy-key"); expect(JSON.stringify(restarted)).not.toContain(codec.seal("legacy-key"));
});

it("selected-chat extension saves preserve other profiles, duplicate display names and atomic reassignment on deletion", async () => {
  const app = buildApp({ secretCodec: codec }); apps.push(app);
  const a = await add(app, "Same name", { model: "A", apiKey: "a-key" }), b = await add(app, "Same name", { model: "B", apiKey: "b-key" });
  await app.inject({ method: "PATCH", url: "/api/settings/provider-tasks", payload: { chat: b.id, summary: b.id, extraction: b.id, embedding: b.id } });
  const patched = await app.inject({ method: "PUT", url: `/api/settings/providers/${b.id}`, payload: { name: b.name, settings: { ...b.settings, model: "B changed" } } });
  expect(patched.statusCode, patched.body).toBe(200);
  expect(patched.json().settings).toMatchObject({ model: "B changed", hasApiKey: true });
  const listed = (await app.inject({ method: "GET", url: "/api/settings/providers" })).json() as ProviderProfiles;
  expect(listed.profiles.find(profile => profile.id === a.id)!.settings).toMatchObject({ model: "A", hasApiKey: true });
  expect((await app.inject({ method: "PATCH", url: "/api/settings/provider-tasks", payload: { chat: "missing", summary: a.id } })).statusCode).toBe(400);
  expect((await app.inject({ method: "GET", url: "/api/settings/providers" })).json().tasks).toEqual(listed.tasks);
  const removed = (await app.inject({ method: "DELETE", url: `/api/settings/providers/${b.id}` })).json() as ProviderProfiles;
  expect(removed.tasks).toEqual({ chat: "default", summary: null, extraction: null, embedding: null });
  await app.inject({ method: "DELETE", url: `/api/settings/providers/${a.id}` });
  expect((await app.inject({ method: "DELETE", url: "/api/settings/providers/default" })).statusCode).toBe(409);
});

it.each(["openai-compatible", "ollama"] as const)("routes chat, extraction, summary and %s embedding through their actual chosen targets/models/keys", async kind => {
  const provider = await remote(), app = buildApp({ secretCodec: codec }); apps.push(app);
  const profiles: Record<string, ProviderProfile> = {};
  for (const task of ["chat", "extraction", "summary", "embedding"]) profiles[task] = await add(app, task, {
    kind: task === "embedding" ? kind : "openai-compatible", baseUrl: `${provider.base}/${task}/v1`, model: `${task}-model`, apiKey: `${task}-secret`,
  });
  await app.inject({ method: "PATCH", url: "/api/settings/provider-tasks", payload: Object.fromEntries(Object.entries(profiles).map(([task, profile]) => [task, profile.id])) });
  const conversation = await story(app);
  for (let i = 0; i < 7; i++) {
    const result = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/messages`, payload: { content: `Round ${i}; open the door.` } });
    expect(parseSse(result.body).find(event => event.type === "done")).toMatchObject({ message: { status: "complete", content: "Reply chat-model" } });
  }
  await waitFor(async () => {
    const summary = (await app.inject({ method: "GET", url: `/api/conversations/${conversation.id}/summary` })).json().summary;
    return summary?.content === "Earlier story summary." ? true : undefined;
  });
  const result = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/memories/test`, payload: { input: "Who holds the thing that unlocks the door?" } });
  expect(result.json().retrieval).toMatchObject({ mode: "hybrid", embeddingModel: "embedding-model" });
  for (const task of Object.keys(profiles)) {
    const requests = provider.requests.filter(request => request.body.model === `${task}-model`);
    expect(requests.length, task).toBeGreaterThan(0); expect(requests.every(request => request.authorization === `Bearer ${task}-secret`)).toBe(true);
    expect(requests.every(request => request.path.startsWith(`/${task}/`))).toBe(true);
  }
  const vectors = provider.requests.filter(request => request.body.model === "embedding-model");
  expect(vectors.every(request => request.path.endsWith(kind === "ollama" ? "/api/embed" : "/v1/embeddings"))).toBe(true);
  expect(vectors.some(request => request.body.input.includes("Who holds the thing that unlocks the door?"))).toBe(true);
  const probe = await app.inject({ method: "POST", url: `/api/settings/providers/${profiles.embedding!.id}/test`, payload: { ...profiles.embedding!.settings, task: "embedding" } });
  expect(probe.json()).toMatchObject({ ok: true, capability: "embedding" });
  const backup = (await app.inject({ method: "GET", url: "/api/backup" })).body;
  for (const task of Object.keys(profiles)) { expect(result.body + backup).not.toContain(`${task}-secret`); expect(backup).not.toContain(codec.seal(`${task}-secret`)); }
});

it("a rejected extraction model does not stop chat or an independently selected summary model", async () => {
  const provider = await remote("extraction-model"), app = buildApp({ secretCodec: codec }); apps.push(app);
  const chat = await add(app, "chat", { baseUrl: provider.base + "/chat/v1", model: "chat-model" });
  const extraction = await add(app, "extraction", { baseUrl: provider.base + "/extraction/v1", model: "extraction-model", apiKey: "rejected-extraction-key" });
  const summary = await add(app, "summary", { baseUrl: provider.base + "/summary/v1", model: "summary-model" });
  await app.inject({ method: "PATCH", url: "/api/settings/provider-tasks", payload: { chat: chat.id, summary: summary.id, extraction: extraction.id } });
  const conversation = await story(app);
  for (let i = 0; i < 7; i++) {
    const result = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/messages`, payload: { content: `Round ${i}` } });
    expect(parseSse(result.body).find(event => event.type === "done")).toMatchObject({ message: { status: "complete" } });
  }
  await waitFor(async () => (await app.inject({ method: "GET", url: `/api/conversations/${conversation.id}/summary` })).json().summary?.model === "summary-model" ? true : undefined);
  expect((await app.inject({ method: "GET", url: `/api/conversations/${conversation.id}/memories` })).json().items).toEqual([]);
  expect(provider.requests.some(request => request.body.model === "extraction-model")).toBe(true);
  expect((await app.inject({ method: "GET", url: "/api/backup" })).body).not.toContain("rejected-extraction-key");
});

it("unassigned extraction/summary use the selected chat connection and unassigned embedding makes no vector requests", async () => {
  const provider = await remote(), app = buildApp({ secretCodec: codec }); apps.push(app);
  const chat = await add(app, "Default task model", { baseUrl: provider.base + "/chat/v1", model: "chat-model", apiKey: "shared-chat-key" });
  await app.inject({ method: "PATCH", url: "/api/settings/provider-tasks", payload: { chat: chat.id } });
  const conversation = await story(app);
  for (let i = 0; i < 7; i++) {
    const result = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/messages`, payload: { content: `Default ${i}` } });
    expect(parseSse(result.body).find(event => event.type === "memory")).toMatchObject({ report: { retrieval: { mode: "keyword" } } });
  }
  await waitFor(async () => provider.requests.some(request => request.body.messages?.[0]?.content.includes("摘要助手")) ? true : undefined);
  expect(provider.requests.some(request => request.body.messages?.[0]?.content.includes("记忆助手"))).toBe(true);
  expect(provider.requests.every(request => request.body.model === "chat-model" && request.authorization === "Bearer shared-chat-key")).toBe(true);
  expect(provider.requests.some(request => /embeddings|embed$/.test(request.path))).toBe(false);
});

it("switching the selected chat profile mid-session sends later generations to the new endpoint/model/key", async () => {
  const provider = await remote(), app = buildApp({ secretCodec: codec }); apps.push(app);
  const a = await add(app, "A", { baseUrl: provider.base + "/a/v1", model: "A-model", apiKey: "A-secret" });
  const b = await add(app, "B", { baseUrl: provider.base + "/b/v1", model: "B-model", apiKey: "B-secret" });
  await app.inject({ method: "PATCH", url: "/api/settings/provider-tasks", payload: { chat: a.id } });
  const conversation = await story(app);
  const first = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/messages`, payload: { content: "Speak" } });
  expect(first.body).toContain("Reply A-model");
  await app.inject({ method: "PATCH", url: "/api/settings/provider-tasks", payload: { chat: b.id } });
  const next = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/messages`, payload: { content: "Next" } });
  expect(next.body).toContain("Reply B-model");
  const chats = provider.requests.filter(request => request.body.stream);
  expect(chats.map(request => [request.path, request.body.model, request.authorization])).toEqual([
    ["/a/v1/chat/completions", "A-model", "Bearer A-secret"], ["/b/v1/chat/completions", "B-model", "Bearer B-secret"],
  ]);
});

it("profile draft tests and profile edits never inherit a saved key after changing kind or effective endpoint path", async () => {
  const provider = await remote(), app = buildApp({ secretCodec: codec }); apps.push(app);
  const profile = await add(app, "Scoped", { baseUrl: provider.base + "/old/v1", apiKey: "scoped-secret" });
  const probe = await app.inject({ method: "POST", url: `/api/settings/providers/${profile.id}/test`, payload: { ...profile.settings, baseUrl: provider.base + "/new/v1" } });
  expect(probe.json().ok).toBe(true); expect(provider.requests.at(-1)!.authorization).toBeUndefined();
  const saved = await app.inject({ method: "PUT", url: `/api/settings/providers/${profile.id}`, payload: { name: profile.name, settings: { ...profile.settings, baseUrl: provider.base + "/new/v1" } } });
  expect(saved.json().settings.hasApiKey).toBe(false);
  await app.inject({ method: "PATCH", url: "/api/settings/provider-tasks", payload: { chat: profile.id } });
  const conversation = await story(app);
  const result = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/messages`, payload: { content: "Speak" } });
  expect(result.statusCode).toBe(200); expect(provider.requests.at(-1)!.authorization).toBeUndefined();
});

it("new multi-profile backups restore task ids without credentials, and old backups retain their original checksums", async () => {
  const source = buildApp({ secretCodec: codec }), target = buildApp({ secretCodec: codec }); apps.push(source, target);
  const profile = await add(source, "Task model", { model: "task-model", apiKey: "not-exported-key" });
  await source.inject({ method: "PATCH", url: "/api/settings/provider-tasks", payload: { chat: profile.id, summary: profile.id, embedding: profile.id } });
  const backup = (await source.inject({ method: "GET", url: "/api/backup" })).json();
  expect(JSON.stringify(backup)).not.toContain("not-exported-key"); expect(JSON.stringify(backup)).not.toContain(codec.seal("not-exported-key"));
  const preview = await target.inject({ method: "POST", url: "/api/backup/restore/preview", payload: { backup, strategy: "skip" } });
  expect(preview.json()).toMatchObject({ valid: true, sections: { providerProfiles: { new: 3 } } });
  const restored = await target.inject({ method: "POST", url: "/api/backup/restore", payload: { backup, strategy: "skip" } });
  expect(restored.statusCode, restored.body).toBe(200);
  const state = (await target.inject({ method: "GET", url: "/api/settings/providers" })).json() as ProviderProfiles;
  expect(state.tasks).toEqual(backup.providerProfiles.tasks); expect(state.profiles.every(item => !item.settings.hasApiKey)).toBe(true);
  const invalid = { ...backup, providerProfiles: { ...backup.providerProfiles, tasks: { ...backup.providerProfiles.tasks, embedding: "missing" } } };
  expect((await target.inject({ method: "POST", url: "/api/backup/restore/preview", payload: { backup: invalid } })).statusCode).toBe(400);
});
