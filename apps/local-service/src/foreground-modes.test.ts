import { afterEach, expect, it, vi } from "vitest";
import type { GenerationSseEvent } from "@mycompanion/shared";
import { buildApp } from "./app.js";
import { apps, fullV2Card, sseResponse, completionResponse, stoppableSseResponse } from "./test-helpers.js";

afterEach(() => vi.restoreAllMocks());
const nativeFetch = globalThis.fetch;
async function fixture() {
  const app = buildApp(); apps.push(app);
  const card = (await app.inject({ method: "POST", url: "/api/characters/import/commit", payload: { filename: "foreground.json", card: fullV2Card } })).json();
  await app.inject({ method: "PUT", url: "/api/settings/provider", payload: { kind: "openai-compatible", baseUrl: "http://provider.test/v1", model: "foreground-fixture", maxTokens: 128, contextLimitTokens: 8192 } });
  const story = (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: card.id } })).json();
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith(base)) return nativeFetch(url, init);
    const body = JSON.parse(String(init?.body)); requests.push(body);
    return body.stream ? sseResponse([" continued", " answer"]) : completionResponse("[]");
  });
  const read = async () => (await app.inject({ method: "GET", url: `/api/conversations/${story.id}` })).json();
  const call = (mode: string, payload = {}) => app.inject({ method: "POST", url: `/api/conversations/${story.id}/messages/${mode}`, payload });
  const events = (body: string): GenerationSseEvent[] => body.split("\n\n").slice(0, -1).filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
  return { app, base, story, requests, read, call, events };
}

it("continues the same tail and preserves original prefix, branch and extension swipe data", async () => {
  const f = await fixture(), before = await f.read(), old = before.messages.at(-1);
  expect(old.role).toBe("assistant");
  const result = await f.call("continue"); expect(result.statusCode).toBe(200);
  const after = await f.read(), continued = after.messages.at(-1);
  expect(after.activeBranchId).toBe(before.activeBranchId); expect(after.messages).toHaveLength(before.messages.length);
  expect(continued).toMatchObject({ id: old.id, role: "assistant", content: old.content + " continued answer", status: "complete" });
  expect(f.events(result.body).find(event => event.type === "assistant_start")).toMatchObject({ message: { id: old.id, content: old.content } });
  expect(JSON.stringify(f.requests[0])).toContain(old.content);
});

it("impersonates without writing any chat message and reports separate transient output", async () => {
  const f = await fixture(), before = await f.read();
  const result = await f.call("impersonate"); expect(result.statusCode).toBe(200);
  expect((await f.read()).messages).toEqual(before.messages); expect((await f.read()).activeBranchId).toBe(before.activeBranchId);
  const events = f.events(result.body);
  expect(events).toContainEqual({ type: "impersonate_result", text: "continued answer" });
  expect(events.some(event => ["assistant_start", "done", "user_message"].includes(event.type))).toBe(false);
});

it.each(["continue", "impersonate"])("preview %s sends no provider request and leaves messages untouched", async mode => {
  const f = await fixture(), before = await f.read();
  const result = await f.call(mode, { dryRun: true });
  expect(f.events(result.body)).toContainEqual({ type: "generation_end", reason: "preview" });
  expect(f.requests).toEqual([]); expect((await f.read()).messages).toEqual(before.messages);
});

it("stopping a continuation preserves both original prefix and accepted partial text", async () => {
  const f = await fixture(), before = await f.read();
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => String(url).startsWith(f.base) ? nativeFetch(url, init) : stoppableSseResponse(init?.signal));
  const response = await nativeFetch(`${f.base}/api/conversations/${f.story.id}/messages/continue`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const reader = response.body!.getReader(); let text = "";
  while (!text.includes('"type":"delta"')) { const part = await reader.read(); if (part.done) throw new Error("No partial delta"); text += new TextDecoder().decode(part.value); }
  await f.app.inject({ method: "POST", url: `/api/conversations/${f.story.id}/generation/stop` });
  while (!(await reader.read()).done) { /* drain */ }
  expect((await f.read()).messages.at(-1)).toMatchObject({ id: before.messages.at(-1).id, content: before.messages.at(-1).content + "你好，", status: "stopped" });
});
