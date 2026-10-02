import { expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { apps, commitCard, completionResponse, fullV2Card, parseSse } from "./test-helpers.js";

it.each([
  { finish: "stop", status: "complete", outcome: "complete", extracts: 1 },
  { finish: "length", status: "complete", outcome: "truncated", extracts: 0 },
  { finish: "content_filter", status: "failed", outcome: "incomplete", extracts: 0 },
  { finish: null, status: "failed", outcome: "incomplete", extracts: 0 },
] as const)("records $finish and only extracts from normally completed streams", async ({ finish, status, outcome, extracts }) => {
  let extractionRequests = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { stream: boolean };
    if (!body.stream) { extractionRequests++; return completionResponse(); }
    const event = { choices: [{ delta: { content: "partial reply" }, ...(finish ? { finish_reason: finish } : {}) }] };
    return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  }));
  const app = buildApp(); apps.push(app);
  const character = await commitCard(app, fullV2Card);
  await app.inject({ method: "PUT", url: "/api/settings/provider", payload: { kind: "ollama", baseUrl: "http://completion.test/v1", model: "completion" } });
  const story = (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } })).json();
  const reply = await app.inject({ method: "POST", url: `/api/conversations/${story.id}/messages`, payload: { content: "continue" } });
  const done = parseSse(reply.body).find(event => event.type === "done") as { message: { status: string; content: string; generationMetadata: Record<string, unknown> } };
  expect(done.message).toMatchObject({ status, content: "partial reply", generationMetadata: { completionOutcome: outcome, finishReason: finish ?? "eof" } });
  await app.close();
  expect(extractionRequests).toBe(extracts);
  const errors = parseSse(reply.body).filter(event => event.type === "error");
  expect(errors).toHaveLength(status === "failed" ? 1 : 0);
});

it("accepts DONE across byte boundaries, ignores malformed events and stops an open body", async () => {
  let cancelled = false;
  const encoder = new TextEncoder();
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (!(JSON.parse(String(init?.body)) as { stream: boolean }).stream) return completionResponse();
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const raw = encoder.encode('data: invalid\r\n\r\ndata: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\ndata: [DONE]\r\n\r\n');
        for (const byte of raw) controller.enqueue(new Uint8Array([byte]));
        // A terminal event should finish without waiting for the provider to close.
      },
      cancel() { cancelled = true; },
    }), { headers: { "Content-Type": "text/event-stream" } });
  }));
  const app = buildApp(); apps.push(app);
  const character = await commitCard(app, fullV2Card);
  await app.inject({ method: "PUT", url: "/api/settings/provider", payload: { kind: "ollama", baseUrl: "http://completion.test/v1", model: "completion" } });
  const story = (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } })).json();
  const reply = await app.inject({ method: "POST", url: `/api/conversations/${story.id}/messages`, payload: { content: "continue" } });
  expect(parseSse(reply.body).find(event => event.type === "done")).toMatchObject({ message: { status: "complete", content: "你好", generationMetadata: { completionOutcome: "complete", finishReason: "done" } } });
  expect(cancelled).toBe(true);
});
