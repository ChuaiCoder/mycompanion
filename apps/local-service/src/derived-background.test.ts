import { afterEach, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { RuntimeRepository } from "./persistence/runtime-repository.js";
import { apps, commitCard, completionResponse, fullV2Card, sseResponse } from "./testing/helpers.js";

afterEach(() => vi.restoreAllMocks());

async function story() {
  const app = buildApp(); apps.push(app);
  const character = await commitCard(app, fullV2Card);
  await app.inject({ method: "PUT", url: "/api/settings/provider", payload: { kind: "ollama", baseUrl: "http://derived.test/v1", model: "derived" } });
  const created = (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } })).json();
  return { app, created };
}

it("discards a memory extraction that finishes after its source was edited onto a new branch", async () => {
  let release!: (response: Response) => void;
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const completion = new Promise<Response>(resolve => { release = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
    if ((JSON.parse(String(init?.body)) as { stream: boolean }).stream) return sseResponse(["The old fact."]);
    began(); return completion;
  }));
  const guard = vi.spyOn(RuntimeRepository.prototype, "isMessageSnapshotCurrent");
  const write = vi.spyOn(RuntimeRepository.prototype, "addMemory");
  const { app, created } = await story();
  await app.inject({ method: "POST", url: `/api/conversations/${created.id}/messages`, payload: { content: "Old source." } });
  await started;
  const current = (await app.inject({ method: "GET", url: `/api/conversations/${created.id}` })).json();
  const source = current.messages.find((message: { role: string }) => message.role === "user");
  const edited = await app.inject({ method: "PATCH", url: `/api/conversations/${created.id}/messages/${source.id}`, payload: { content: "Corrected source." } });
  expect(edited.statusCode).toBe(200);
  release(completionResponse('[{"type":"fact","content":"The old source fact.","importance":4}]'));
  await vi.waitFor(() => expect(guard.mock.results.at(-1)?.value).toBe(false));
  expect(write).not.toHaveBeenCalled();
  expect((await app.inject({ method: "GET", url: `/api/conversations/${created.id}/memories` })).json().items).toEqual([]);
});

it("does not save a late summary against a different branch", async () => {
  let release!: (response: Response) => void;
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const completion = new Promise<Response>(resolve => { release = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { stream: boolean; messages: Array<{ content: string }> };
    if (body.stream) return sseResponse(["Reply."]);
    if (body.messages[0]!.content.includes("记忆助手")) return completionResponse();
    began(); return completion;
  }));
  const guard = vi.spyOn(RuntimeRepository.prototype, "isMessageSnapshotCurrent");
  const write = vi.spyOn(RuntimeRepository.prototype, "saveSummary");
  const { app, created } = await story();
  for (let turn = 0; turn < 7; turn++) await app.inject({ method: "POST", url: `/api/conversations/${created.id}/messages`, payload: { content: `Turn ${turn}` } });
  await started;
  await app.inject({ method: "PATCH", url: `/api/conversations/${created.id}/messages/${created.messages[0].id}`, payload: { content: "New opening." } });
  release(completionResponse("Summary of the old branch."));
  await vi.waitFor(() => {
    expect(guard.mock.calls.at(-1)?.[3]).toBe(true);
    expect(guard.mock.results.at(-1)?.value).toBe(false);
  });
  expect(write).not.toHaveBeenCalled();
  await app.inject({ method: "POST", url: `/api/conversations/${created.id}/branches/${created.activeBranchId}/activate` });
  expect((await app.inject({ method: "GET", url: `/api/conversations/${created.id}/summary` })).json().summary).toBeUndefined();
});
