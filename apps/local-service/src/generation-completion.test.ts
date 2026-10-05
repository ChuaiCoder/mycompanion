import { expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { apps, commitCard, completionResponse, fullV2Card, parseSse } from "./testing/helpers.js";

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

it("accepts legal unknown events, comments and DONE across byte boundaries, then cancels an open body", async () => {
  let cancelled = false, extractionRequests = 0;
  let stream: ReadableStream<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (!(JSON.parse(String(init?.body)) as { stream: boolean }).stream) { extractionRequests++; return completionResponse(); }
    stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const raw = encoder.encode(': keepalive\r\n\r\nevent: unknown\r\ndata: {"future":{"retained":true}}\r\n\r\ndata: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\ndata: [DONE]\r\n\r\n');
        for (const byte of raw) controller.enqueue(new Uint8Array([byte]));
        // A terminal event should finish without waiting for the provider to close.
      },
      cancel() { cancelled = true; },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  }));
  const app = buildApp(); apps.push(app);
  const character = await commitCard(app, fullV2Card);
  await app.inject({ method: "PUT", url: "/api/settings/provider", payload: { kind: "ollama", baseUrl: "http://completion.test/v1", model: "completion" } });
  const story = (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } })).json();
  const reply = await app.inject({ method: "POST", url: `/api/conversations/${story.id}/messages`, payload: { content: "continue" } });
  expect(parseSse(reply.body).find(event => event.type === "done")).toMatchObject({ message: { status: "complete", content: "你好", generationMetadata: { completionOutcome: "complete", finishReason: "done" } } });
  expect(parseSse(reply.body).some(event => event.type === "error")).toBe(false);
  expect(cancelled).toBe(true); expect(stream!.locked).toBe(false);
  await app.close(); expect(extractionRequests).toBe(1);
});

it("fails malformed JSON after received text, cancels and releases the body, skips success memory jobs and permits the next send", async () => {
  const privateBody = "MALFORMED_COMPLETION_PRIVATE_BODY", streams: ReadableStream<Uint8Array>[] = [], cancellations: number[] = [];
  let providerRequests = 0, extractionRequests = 0;
  const encoder = new TextEncoder();
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (!(JSON.parse(String(init?.body)) as {stream: boolean}).stream) {extractionRequests++; return completionResponse();}
    const ordinal = providerRequests++;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const raw = ordinal === 0
          ? 'data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\n' + `data: {"private":"${privateBody}",\r\n\r\n`
            + 'data: {"choices":[{"delta":{"content":"不得保留的坏帧后正文"}}]}\r\n\r\ndata: [DONE]\r\n\r\n'
          : 'data: {"choices":[{"delta":{"content":"恢复成功"}}]}\r\n\r\ndata: [DONE]\r\n\r\n';
        for (const byte of encoder.encode(raw)) controller.enqueue(new Uint8Array([byte]));
        // Both malformed data and DONE must terminate an otherwise open body.
      },
      cancel() {cancellations.push(ordinal);},
    });
    streams.push(stream); return new Response(stream, {headers: {"Content-Type": "text/event-stream"}});
  }));
  const app = buildApp(); apps.push(app);
  const character = await commitCard(app, fullV2Card);
  await app.inject({method: "PUT", url: "/api/settings/provider", payload: {kind: "ollama", baseUrl: "http://completion.test/v1", model: "completion"}});
  const story = (await app.inject({method: "POST", url: "/api/conversations", payload: {characterId: character.id}})).json();
  const send = () => app.inject({method: "POST", url: `/api/conversations/${story.id}/messages`, payload: {content: "continue"}});
  const failed = await send(), events = parseSse(failed.body);
  expect(events.filter(event => event.type === "error")).toEqual([{type: "error", message: "模型返回了不兼容的响应格式。"}]);
  expect(events.find(event => event.type === "done")).toMatchObject({message: {status: "failed", content: "你好"}});
  expect(failed.body).not.toContain(privateBody); expect(failed.body).not.toContain("不得保留的坏帧后正文");
  expect(cancellations).toEqual([0]); expect(streams[0]!.locked).toBe(false);
  expect(providerRequests).toBe(1); expect(extractionRequests).toBe(0);
  const stored = (await app.inject({url: `/api/conversations/${story.id}`})).json();
  expect(stored.messages.at(-1)).toMatchObject({status: "failed", content: "你好"});
  const backup = await app.inject({url: "/api/backup"});
  expect(backup.json().memories).toEqual([]); expect(backup.json().stageSummaries).toEqual([]);
  expect(backup.body).not.toContain(privateBody); expect(extractionRequests).toBe(0);
  const recovered = await send();
  expect(parseSse(recovered.body).some(event => event.type === "error")).toBe(false);
  expect(parseSse(recovered.body).find(event => event.type === "done")).toMatchObject({message: {status: "complete", content: "恢复成功"}});
  expect(providerRequests).toBe(2); expect(cancellations).toEqual([0, 1]); expect(streams.every(stream => !stream.locked)).toBe(true);
  await app.close(); expect(extractionRequests).toBe(1); // Only the recovered successful turn extracts.
});
