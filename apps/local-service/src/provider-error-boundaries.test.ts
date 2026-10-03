import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inspect } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderSettings } from "@mycompanion/shared";
import { buildApp } from "./app.js";
import { completeText } from "./model-client.js";
import { apps, parseSse, waitFor } from "./test-helpers.js";

const sentinel = "PROVIDER_ECHO_SENTINEL";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
});

type TestProtocol = "openai" | "ollama" | "claude" | "gemini";
async function fixture(respond: (request: IncomingMessage, response: ServerResponse, input: Record<string, unknown>) => void, protocol: TestProtocol = "openai") {
  const outgoing: Array<{ url: string; authorization: string | undefined; apiKey: string | string[] | undefined }> = [];
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    outgoing.push({ url: request.url!, authorization: request.headers.authorization, apiKey: request.headers["x-api-key"] ?? request.headers["x-goog-api-key"] });
    const text = Buffer.concat(chunks).toString();
    respond(request, response, text ? JSON.parse(text) : {});
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>(resolve => provider.close(() => resolve())));
  const folder = await mkdtemp(join(tmpdir(), "mycompanion-provider-errors-"));
  cleanup.push(() => rm(folder, { recursive: true, force: true }));
  const databasePath = join(folder, "runtime.sqlite");
  const kind: ProviderSettings["kind"] = protocol === "claude" ? "anthropic" : protocol === "gemini" ? "gemini" : protocol === "ollama" ? "ollama" : "openai-compatible";
  const settings = { kind, baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/${protocol === "gemini" ? "v1beta" : "v1"}`,
    model: protocol === "claude" ? "claude-sonnet-4-6" : protocol === "gemini" ? "gemini-2.5-flash" : "gpt-4o", temperature: 0.8, maxTokens: 128, contextLimitTokens: 4096, hasApiKey: true };
  const app = buildApp({ databasePath, secretCodec: { seal: value => Buffer.from(value).toString("base64"), unseal: value => Buffer.from(value, "base64").toString() } });
  apps.push(app);
  const logs: string[] = [];
  for (const level of ["error", "warn", "info", "debug"] as const) vi.spyOn(app.log, level).mockImplementation((...args: unknown[]) => { logs.push(inspect(args)); });
  await app.inject({ method: "PUT", url: "/api/settings/provider", payload: { ...settings, apiKey: sentinel } });
  const avatar = (await app.inject({ method: "POST", url: "/api/characters/create", payload: { ch_name: "Provider error boundary", first_mes: "Hello" } })).body;
  const character = (await app.inject({ method: "POST", url: "/api/characters/get", payload: { avatar_url: avatar } })).json();
  const story = (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } })).json();
  return { app, story, settings, outgoing, logs, databasePath };
}

it("a real provider's HTTP error echo cannot reach native SSE, SQLite messages, story export, backup, raw/public APIs or connection checks", async () => {
  const f = await fixture((_request, response) => {
    response.writeHead(401, `Unauthorized ${sentinel}`, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: `Auth rejected ${sentinel}` }, requestHeaders: { Authorization: `Bearer ${sentinel}` } }));
  });
  const native = await f.app.inject({ method: "POST", url: `/api/conversations/${f.story.id}/messages`, payload: { content: "Speak" } });
  expect(parseSse(native.body).find(event => event.type === "error")).toMatchObject({ message: "服务拒绝了 API Key。" });
  expect(parseSse(native.body).find(event => event.type === "done")).toMatchObject({ message: { status: "failed", content: "服务拒绝了 API Key。" } });
  const publicResult = await f.app.inject({ method: "POST", url: "/api/backends/chat-completions/generate", payload: { messages: [{ role: "user", content: "Speak" }] } });
  const raw = await f.app.inject({ method: "POST", url: "/api/extensions/generate-raw", payload: { messages: [{ role: "user", content: "Speak" }] } });
  const connection = await f.app.inject({ method: "POST", url: "/api/settings/provider/test", payload: {} });
  const draft = await f.app.inject({ method: "POST", url: "/api/settings/provider/test", payload: f.settings });
  for (const response of [publicResult, raw, connection]) { expect(response.statusCode).toBe(401); expect(response.body).toContain("API Key"); }
  expect(draft.json()).toMatchObject({ ok: false, issue: { code: "AUTHENTICATION" } });
  const story = await f.app.inject({ method: "GET", url: `/api/conversations/${f.story.id}` });
  const exported = await f.app.inject({ method: "GET", url: `/api/conversations/${f.story.id}/export?format=json` });
  const backup = await f.app.inject({ method: "GET", url: "/api/backup" });
  const db = new DatabaseSync(f.databasePath, { readOnly: true });
  try { expect(JSON.stringify(db.prepare("SELECT content,status FROM messages").all())).not.toContain(sentinel); }
  finally { db.close(); }
  for (const response of [native, publicResult, raw, connection, draft, story, exported, backup]) expect(response.body).not.toContain(sentinel);
  expect(f.logs.join("\n")).not.toContain(sentinel);
  expect(f.outgoing).toHaveLength(5); expect(f.outgoing.every(request => request.authorization === `Bearer ${sentinel}`)).toBe(true);
});

it.each(["json", "sse", "event-error"])("sanitizes HTTP 200 %s error envelopes while keeping successful extension data intact", async format => {
  const successful = 'data: {"choices":[{"index":0,"delta":{"content":"你好","reasoning_content":"想","tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\r\n\r\n';
  const error = JSON.stringify({ error: { code: 429, message: `Quota ${sentinel}` }, leakedHeaders: { authorization: `Bearer ${sentinel}` } });
  const payload = format === "json" ? error : successful + (format === "event-error" ? `event: error\r\ndata: ${sentinel}\r\n\r\n` : `data: ${error}\r\n\r\n`) + "data: [DONE]\r\n\r\n";
  const f = await fixture((_request, response) => {
    response.writeHead(200, { "Content-Type": format === "json" ? "application/json" : "text/event-stream" });
    response.end(payload);
  });
  const publicResult = await f.app.inject({ method: "POST", url: "/api/backends/chat-completions/generate", payload: { messages: [{ role: "user", content: "Speak" }], stream: format !== "json" } });
  expect(publicResult.body).not.toContain(sentinel);
  if (format === "json") expect(publicResult.statusCode).toBe(429);
  else { expect(publicResult.statusCode).toBe(200); expect(publicResult.body.startsWith(successful)).toBe(true); expect(publicResult.body).toContain('"error"'); expect(publicResult.body.endsWith("data: [DONE]\r\n\r\n")).toBe(true); }
  if (format === "json") {
    const raw = await f.app.inject({ method: "POST", url: "/api/extensions/generate-raw", payload: { messages: [{ role: "user", content: "Speak" }] } });
    const probe = await f.app.inject({ method: "POST", url: "/api/settings/provider/test", payload: f.settings });
    expect(raw.statusCode).toBe(429); expect(raw.body + probe.body).not.toContain(sentinel); expect(probe.json()).toMatchObject({ ok: false, issue: { code: "RATE_LIMIT" } });
  }
});

it("native provider error events preserve only received reply text and never save error data", async () => {
  const f = await fixture((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: {"choices":[{"delta":{"content":"partial reply"}}]}\n\ndata: ${JSON.stringify({ error: { message: sentinel } })}\n\n`);
  });
  const result = await f.app.inject({ method: "POST", url: `/api/conversations/${f.story.id}/messages`, payload: { content: "Speak" } });
  expect(parseSse(result.body).find(event => event.type === "done")).toMatchObject({ message: { status: "failed", content: "partial reply" } });
  expect(result.body).not.toContain(sentinel);
  expect((await f.app.inject({ method: "GET", url: "/api/backup" })).body).not.toContain(sentinel);
});

const frame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
function textFrame(protocol: TestProtocol, content: string, initial = false): string {
  if (protocol === "claude") return initial
    ? frame({type: "content_block_start", index: 0, content_block: {type: "text", text: content}})
    : frame({type: "content_block_delta", index: 0, delta: {type: "text_delta", text: content}});
  if (protocol === "gemini") return frame({candidates: [{content: {parts: [{text: content}]}}]});
  return frame({choices: [{delta: {content}}]});
}
function terminalFrame(protocol: TestProtocol): string {
  if (protocol === "claude") return frame({type: "content_block_stop", index: 0})
    + frame({type: "message_delta", delta: {stop_reason: "end_turn"}}) + frame({type: "message_stop"});
  if (protocol === "gemini") return frame({candidates: [{finishReason: "STOP"}]}) + "data: [DONE]\n\n";
  return frame({choices: [{delta: {}, finish_reason: "stop"}]}) + "data: [DONE]\n\n";
}

it.each(["openai", "ollama", "claude", "gemini"] as const)("fails malformed %s JSON through actual native HTTP, retains the pre-frame text and releases the next send", async protocol => {
  const partial = "坏帧前已收到的中文", afterBad = "不得保留坏帧后的文本", recovered = "下一轮正常完成";
  let streamingRequests = 0;
  const f = await fixture((request, response, input) => {
    const stream = input.stream || request.url?.includes("streamGenerateContent");
    response.writeHead(200, {"Content-Type": stream ? "text/event-stream" : "application/json"});
    if (!stream) {
      response.end(JSON.stringify(protocol === "claude" ? {content: [{type: "text", text: "[]"}], stop_reason: "end_turn"}
        : protocol === "gemini" ? {candidates: [{content: {parts: [{text: "[]"}]}, finishReason: "STOP"}]}
        : {choices: [{message: {content: "[]"}, finish_reason: "stop"}]})); return;
    }
    streamingRequests++;
    response.end(streamingRequests === 1
      ? textFrame(protocol, partial, true) + `data: {"echo":"Bearer ${sentinel}",\n\n` + textFrame(protocol, afterBad) + terminalFrame(protocol)
      : textFrame(protocol, recovered, true) + terminalFrame(protocol));
  }, protocol);
  const base = await f.app.listen({host: "127.0.0.1", port: 0});
  const send = async () => {
    const response = await fetch(`${base}/api/conversations/${f.story.id}/messages`, {method: "POST", headers: {"Content-Type": "application/json"},
      signal: AbortSignal.timeout(15000), body: JSON.stringify({content: "Speak"})});
    expect(response.status).toBe(200); return response.text();
  };
  const failed = await send(), events = parseSse(failed);
  expect(events.find(event => event.type === "error")).toMatchObject({message: "模型返回了不兼容的响应格式。"});
  expect(events.find(event => event.type === "done")).toMatchObject({message: {status: "failed", content: partial}});
  expect(failed).not.toContain(afterBad); expect(failed).not.toContain(sentinel);
  const story = await f.app.inject({method: "GET", url: `/api/conversations/${f.story.id}`});
  expect(story.json().messages.at(-1)).toMatchObject({status: "failed", content: partial});
  const exported = await f.app.inject({method: "GET", url: `/api/conversations/${f.story.id}/export?format=json`});
  const backup = await f.app.inject({method: "GET", url: "/api/backup"});
  for (const response of [story, exported, backup]) {expect(response.body).not.toContain(sentinel); expect(response.body).not.toContain(afterBad);}
  expect(f.logs.join("\n")).not.toContain(sentinel);
  expect(f.outgoing[0]).toMatchObject(protocol === "claude" || protocol === "gemini" ? {apiKey: sentinel} : {authorization: `Bearer ${sentinel}`});
  const success = parseSse(await send());
  expect(success.some(event => event.type === "error")).toBe(false);
  expect(success.find(event => event.type === "done")).toMatchObject({message: {status: "complete", content: recovered}});
  expect(streamingRequests).toBe(2);
});

it("seven malformed native streams cannot start memory extraction or successful automatic summaries", async () => {
  let backgroundRequests = 0;
  const f = await fixture((_request, response, input) => {
    if (input.stream) {
      response.writeHead(200, {"Content-Type": "text/event-stream"});
      response.end(textFrame("openai", "partial reply", true) + `data: {"private":"${sentinel}",\n\n` + terminalFrame("openai"));
    } else {
      backgroundRequests++;
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({choices: [{message: {content: '[{"type":"fact","content":"UNEXPECTED_BACKGROUND_SUCCESS","importance":4}]'}, finish_reason: "stop"}]}));
    }
  });
  const responses: string[] = [];
  for (let i = 0; i < 7; i++) responses.push((await f.app.inject({method: "POST", url: `/api/conversations/${f.story.id}/messages`, payload: {content: `Round ${i}`}})).body);
  await f.app.close(); // Drain any actual background jobs before checking absence of their effects.
  for (const response of responses) {
    expect(parseSse(response).find(event => event.type === "done")).toMatchObject({message: {status: "failed", content: "partial reply"}});
    expect(response).not.toContain(sentinel);
  }
  expect(backgroundRequests).toBe(0); expect(f.outgoing).toHaveLength(7);
  const db = new DatabaseSync(f.databasePath, {readOnly: true});
  try {
    expect(db.prepare("SELECT COUNT(*) AS count FROM memories").get()!.count).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM stage_summaries").get()!.count).toBe(0);
    expect(JSON.stringify(db.prepare("SELECT content,status FROM messages").all())).not.toContain(sentinel);
  } finally {db.close();}
  expect(f.logs.join("\n")).not.toContain(sentinel);
});

it("a non-JSON native event:error is a failed response without exposing its provider body", async () => {
  const f = await fixture((_request, response) => {
    response.writeHead(200, {"Content-Type": "text/event-stream"});
    response.end(textFrame("openai", "partial reply", true) + `event: error\ndata: ${sentinel}\n\n` + terminalFrame("openai"));
  });
  const response = await f.app.inject({method: "POST", url: `/api/conversations/${f.story.id}/messages`, payload: {content: "Speak"}});
  expect(parseSse(response.body).find(event => event.type === "done")).toMatchObject({message: {status: "failed", content: "partial reply"}});
  expect(parseSse(response.body).find(event => event.type === "error")).toMatchObject({message: "模型返回了不兼容的响应格式。"});
  expect(response.body + f.logs.join("\n")).not.toContain(sentinel);
});

it("accepts native UTF-8 split across actual HTTP bytes, SSE comments and usage-only frames", async () => {
  const f = await fixture(async (_request, response, input) => {
    if (!input.stream) {response.writeHead(200, {"Content-Type": "application/json"}); response.end(JSON.stringify({choices: [{message: {content: "[]"}}]})); return;}
    response.writeHead(200, {"Content-Type": "text/event-stream"});
    const bytes = Buffer.from(": keepalive\r\n\r\n" + textFrame("openai", "中文回复😀", true)
      + frame({choices: [], usage: {prompt_tokens: 15, completion_tokens: 4, total_tokens: 19}}) + terminalFrame("openai"));
    for (const byte of bytes) {response.write(Buffer.from([byte])); await new Promise<void>(resolve => setImmediate(resolve));}
    response.end();
  });
  const base = await f.app.listen({host: "127.0.0.1", port: 0});
  const response = await fetch(`${base}/api/conversations/${f.story.id}/messages`, {method: "POST", headers: {"Content-Type": "application/json"},
    signal: AbortSignal.timeout(15000), body: JSON.stringify({content: "Speak"})});
  expect(response.status).toBe(200); const events = parseSse(await response.text());
  expect(events.some(event => event.type === "error")).toBe(false);
  expect(events.find(event => event.type === "done")).toMatchObject({message: {status: "complete", content: "中文回复😀", generationMetadata: {usage: {inputTokens: 15, outputTokens: 4}}}});
});

it("background extraction/summary errors cannot become stored memories or logged provider bodies", async () => {
  let backgroundRequests = 0;
  const f = await fixture((_request, response, input) => {
    if (input.stream) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{"content":"complete reply"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    } else {
      backgroundRequests++;
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: sentinel } }));
    }
  });
  for (let i = 0; i < 7; i++) {
    const result = await f.app.inject({ method: "POST", url: `/api/conversations/${f.story.id}/messages`, payload: { content: `Round ${i}` } });
    expect(parseSse(result.body).find(event => event.type === "done")).toMatchObject({ message: { status: "complete" } });
  }
  await waitFor(async () => backgroundRequests >= 8 ? true : undefined);
  await f.app.close(); // Drain actual background jobs before checking their logger boundary.
  expect(f.logs.join("\n")).not.toContain(sentinel);
  const db = new DatabaseSync(f.databasePath, { readOnly: true });
  try {
    expect(db.prepare("SELECT COUNT(*) AS count FROM memories").get()!.count).toBe(0);
    expect(JSON.stringify(db.prepare("SELECT * FROM stage_summaries").all())).not.toContain(sentinel);
  } finally { db.close(); }
  await expect(completeText({ settings: f.settings, apiKey: sentinel, messages: [{ role: "user", content: "Background" }] }))
    .rejects.toMatchObject({ statusCode: 503, message: "模型服务暂时不可用。" });
});

it("unknown transport and response exceptions are replaced before API/log output", async () => {
  const f = await fixture((_request, response) => { response.end("{}"); });
  vi.stubGlobal("fetch", async () => { throw new TypeError(`Transport failure ${sentinel}`); });
  for (const url of ["/api/backends/chat-completions/generate", "/api/extensions/generate-raw"]) {
    const response = await f.app.inject({ method: "POST", url, payload: { messages: [{ role: "user", content: "Speak" }] } });
    expect(response.statusCode).toBe(502); expect(response.body).not.toContain(sentinel);
  }
  expect(f.logs.join("\n")).not.toContain(sentinel);
  vi.stubGlobal("fetch", async () => new Response(`not JSON ${sentinel}`, { headers: { "Content-Type": "application/json" } }));
  await expect(completeText({ settings: f.settings, apiKey: sentinel, messages: [{ role: "user", content: "Background" }] }))
    .rejects.toMatchObject({ statusCode: 502, message: "模型返回了不兼容的响应格式。" });
});

it("filters SSE errors split at every byte without changing successful UTF-8, CRLF, tool or reasoning frames", async () => {
  const f = await fixture((_request, response) => { response.end("{}"); });
  const successful = 'id: exact\r\ndata: {"choices":[{"delta":{"content":"你好","tool_calls":[{"function":{"arguments":"{}"}}],"reasoning":"想"}}]}\r\n\r\n';
  const source = new TextEncoder().encode(successful + `event: error\r\ndata: ${sentinel}\r\n\r\ndata: [DONE]\r\n\r\n`);
  vi.stubGlobal("fetch", async () => new Response(new ReadableStream({ start(controller) { for (const byte of source) controller.enqueue(new Uint8Array([byte])); controller.close(); } }), { headers: { "Content-Type": "text/event-stream" } }));
  const result = await f.app.inject({ method: "POST", url: "/api/backends/chat-completions/generate", payload: { messages: [{ role: "user", content: "Speak" }], stream: true } });
  expect(result.body.startsWith(successful)).toBe(true); expect(result.body.endsWith("data: [DONE]\r\n\r\n")).toBe(true); expect(result.body).not.toContain(sentinel);
});
