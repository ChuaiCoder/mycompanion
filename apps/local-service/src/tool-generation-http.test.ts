import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { chatMessageSchema, type GenerationSseEvent, type NativeCompletionRequest, type ProviderSettings } from "@mycompanion/shared";
import { buildApp } from "./app.js";
import { createToolTestRuntime } from "./tool-test-runtime.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const frame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
const call = (id = "call_a", args = '{"city":"北京"}') => ({id, type: "function", function: {name: "weather", arguments: args}});
type Protocol = "openai" | "claude" | "gemini";
function toolResponse(protocol: Protocol, res: ServerResponse, calls = [call()], finish = "tool_calls", prelude = "", beforeTerminal = "") {
  res.writeHead(200, {"Content-Type": "text/event-stream"});
  if (protocol === "claude") {
    res.write(frame({type: "message_start", message: {usage: {input_tokens: 11, output_tokens: 0}}}));
    res.write(frame({type: "content_block_start", index: 0, content_block: {type: "thinking", thinking: "thought", signature: "signed-original"}}));
    res.write(frame({type: "content_block_stop", index: 0}));
    if (prelude) {
      res.write(frame({type: "content_block_start", index: 1, content_block: {type: "text", text: prelude}}));
      res.write(frame({type: "content_block_stop", index: 1}));
    }
    calls.forEach((item, index) => {
      const ordinal = index + (prelude ? 2 : 1);
      res.write(frame({type: "content_block_start", index: ordinal, content_block: {type: "tool_use", id: item.id, name: item.function.name, input: JSON.parse(item.function.arguments)}}));
      res.write(frame({type: "content_block_stop", index: ordinal}));
    });
    res.write(frame({type: "message_delta", delta: {stop_reason: "tool_use"}, usage: {output_tokens: 3}}));
    res.write(beforeTerminal);
    res.end(frame({type: "message_stop"}));
  } else if (protocol === "gemini") {
    res.end(frame({candidates: [{content: {role: "model", parts: [...(prelude ? [{text: prelude}] : []), ...calls.map(item => ({functionCall: {id: item.id, name: item.function.name, args: JSON.parse(item.function.arguments)}, thoughtSignature: "signed-original"}))]}, finishReason: "STOP"}],
      usageMetadata: {promptTokenCount: 11, candidatesTokenCount: 3, totalTokenCount: 14}}) + beforeTerminal + (beforeTerminal ? "data: [DONE]\n\n" : ""));
  } else {
    if (prelude) res.write(frame({choices: [{delta: {content: prelude}}]}));
    // Real fragmented arguments, with two distinct IDs sharing a name if supplied.
    calls.forEach((item, index) => {
      res.write(frame({choices: [{delta: {tool_calls: [{index, ...item, function: {...item.function, arguments: item.function.arguments.slice(0, 8)}}]}}]}));
      res.write(frame({choices: [{delta: {tool_calls: [{index, function: {arguments: item.function.arguments.slice(8)}}]}}]}));
    });
    if (finish !== "eof") res.write(frame({choices: [{delta: {}, finish_reason: finish}], usage: {prompt_tokens: 11, completion_tokens: 3, total_tokens: 14}}));
    res.write(beforeTerminal);
    res.end(finish === "eof" ? "" : "data: [DONE]\n\n");
  }
}
function finalResponse(protocol: Protocol, res: ServerResponse) {
  res.writeHead(200, {"Content-Type": "text/event-stream"});
  if (protocol === "claude") res.end([
    {type: "message_start", message: {usage: {input_tokens: 31, output_tokens: 0}}},
    {type: "content_block_start", index: 0, content_block: {type: "text", text: "工具结果已收到"}},
    {type: "content_block_stop", index: 0},
    {type: "message_delta", delta: {stop_reason: "end_turn"}, usage: {output_tokens: 5}}, {type: "message_stop"},
  ].map(frame).join(""));
  else if (protocol === "gemini") res.end(frame({candidates: [{content: {parts: [{text: "工具结果已收到"}]}, finishReason: "STOP"}], usageMetadata: {promptTokenCount: 31, candidatesTokenCount: 5, totalTokenCount: 36}}));
  else res.end(frame({choices: [{delta: {content: "工具结果已收到"}, finish_reason: "stop"}], usage: {prompt_tokens: 31, completion_tokens: 5, total_tokens: 36}}) + "data: [DONE]\n\n");
}
async function fixture(protocol: Protocol = "openai", reply?: (round: number, res: ServerResponse) => void) {
  const requests: Array<{path: string; body: Record<string, any>}> = [];
  let backgroundRequests = 0;
  const provider = createServer(async (req, res) => {
    const bytes: Buffer[] = []; for await (const chunk of req) bytes.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(bytes).toString()), stream = body.stream || req.url?.includes("streamGenerateContent");
    if (!stream) {
      backgroundRequests++;
      res.writeHead(200, {"Content-Type": "application/json"});
      res.end(JSON.stringify(protocol === "claude" ? {content: [{type: "text", text: "[]"}], stop_reason: "end_turn"} : protocol === "gemini" ? {candidates: [{content: {parts: [{text: "[]"}]}, finishReason: "STOP"}]} : {choices: [{message: {content: "[]"}, finish_reason: "stop"}]})); return;
    }
    requests.push({path: req.url!, body});
    if (reply) reply(requests.length, res); else if (requests.length === 1) toolResponse(protocol, res); else finalResponse(protocol, res);
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>(resolve => { provider.closeAllConnections(); provider.close(() => resolve()); }));
  const folder = await mkdtemp(join(tmpdir(), "mycompanion-tool-http-")); cleanups.push(() => rm(folder, {recursive: true, force: true}));
  const databasePath = join(folder, "runtime.sqlite");
  let app = buildApp({databasePath}); cleanups.push(() => app.close());
  const kind: ProviderSettings["kind"] = protocol === "claude" ? "anthropic" : protocol === "gemini" ? "gemini" : "openai-compatible";
  expect((await app.inject({method: "PUT", url: "/api/settings/provider", payload: {kind, baseUrl: `http://127.0.0.1:${(provider.address() as {port: number}).port}/${protocol === "gemini" ? "v1beta" : "v1"}`,
    model: protocol === "claude" ? "claude-sonnet-4-6" : protocol === "gemini" ? "gemini-2.5-flash" : "gpt-4o", maxTokens: 128, contextLimitTokens: 8192}})).statusCode).toBe(200);
  const avatar = (await app.inject({method: "POST", url: "/api/characters/create", payload: {ch_name: "Tool loop protocol fixture", first_mes: "Hello"}})).body;
  const role = (await app.inject({method: "POST", url: "/api/characters/get", payload: {avatar_url: avatar}})).json();
  const story = (await app.inject({method: "POST", url: "/api/conversations", payload: {characterId: role.id}})).json();
  let base = await app.listen({host: "127.0.0.1", port: 0});
  const runtime = createToolTestRuntime(), actions: string[] = [];
  runtime.ToolManager.registerFunctionTool({name: "weather", description: "fixture weather", parameters: {type: "object", properties: {city: {type: "string"}}, required: ["city"]},
    action: ({city}: {city: string}) => { actions.push(city); return {city, temperature: 20}; }});
  const readChat = async () => (await app.inject({method: "GET", url: `/api/conversations/${story.id}`})).json();
  const exchange = async (options: {
    payload?: Record<string, unknown>; quiet?: boolean;
    preflight?: (request: NativeCompletionRequest, ordinal: number) => Promise<NativeCompletionRequest>;
    effect?: (event: Extract<GenerationSseEvent, {type: "effect_request"}>) => Promise<void>;
  } = {}) => {
    const response = await fetch(`${base}/api/conversations/${story.id}/${options.quiet ? "quiet-generation" : "messages"}`, {
      method: "POST", headers: {"Content-Type": "application/json"}, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({...(options.quiet ? {quietPrompt: "weather?"} : {content: "北京天气"}), browserPreflight: true, browserMacros: false, ...options.payload}),
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader(), decoder = new TextDecoder(), events: GenerationSseEvent[] = [];
    let buffer = "", ordinal = 0;
    try {
      for (;;) {
        const {value, done} = await reader.read(); if (done) break;
        buffer += decoder.decode(value, {stream: true});
        for (let index; (index = buffer.indexOf("\n\n")) >= 0;) {
          const raw = buffer.slice(0, index); buffer = buffer.slice(index + 2); if (!raw.startsWith("data: ")) continue;
          const event = JSON.parse(raw.slice(6)) as GenerationSseEvent; events.push(event);
          if (event.type === "completion_request") {
            const request = structuredClone(event.request); await runtime.ToolManager.registerFunctionToolsOpenAI(request);
            const changed = options.preflight ? await options.preflight(request, ordinal++) : request;
            expect((await app.inject({method: "POST", url: `/api/generation/preflight/${event.requestId}`, payload: {request: changed}})).statusCode).toBe(200);
          } else if (event.type === "effect_request") {
            expect(event.evaluation.kind).toBe("tool-calls");
            if (options.effect) await options.effect(event);
            else {
              const payload = await runtime.run(event.evaluation, AbortSignal.timeout(5000));
              expect((await app.inject({method: "POST", url: `/api/generation/effects/${event.requestId}`, payload: {result: {payload, local: event.evaluation.local, global: event.evaluation.global}}})).statusCode).toBe(200);
            }
          }
        }
      }
      return events;
    } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
  };
  const restart = async () => {await app.close(); app = buildApp({databasePath}); base = await app.listen({host: "127.0.0.1", port: 0});};
  return {get app() {return app;}, get backgroundRequests() {return backgroundRequests;}, story, role, requests, actions, runtime, exchange, readChat, restart};
}

it.each(["openai", "claude", "gemini"] as const)("executes the original ToolManager through real %s HTTP, budgets each round and persists exact tool results", async protocol => {
  const f = await fixture(protocol), events = await f.exchange();
  expect(f.actions).toEqual(["北京"]); expect(f.requests).toHaveLength(2);
  const done = events.find(event => event.type === "done"); if (done?.type !== "done") throw new Error(JSON.stringify(events));
  const message = chatMessageSchema.parse(done.message), metadata = message.generationMetadata!;
  expect(message).toMatchObject({status: "complete", content: "工具结果已收到"});
  expect(metadata.usage).toMatchObject({protocol, inputTokens: 31, outputTokens: 5});
  expect(metadata.toolRounds).toHaveLength(1);
  expect(metadata.toolRounds![0]).toMatchObject({usage: {inputTokens: 11, outputTokens: 3}, invocations: [{id: "call_a", name: "weather", result: '{"city":"北京","temperature":20}'}]});
  const budgets = events.filter(event => event.type === "prompt_budget"); expect(budgets).toHaveLength(2);
  expect(metadata.toolRounds![0]!.tokenAccounting).toEqual(budgets[0]!.report.tokenAccounting);
  expect(metadata.tokenAccounting).toEqual(budgets[1]!.report.tokenAccounting);
  expect(metadata.tokenAccounting!.promptTokens).toBeGreaterThan(metadata.toolRounds![0]!.tokenAccounting!.promptTokens);
  const wire = f.requests[1]!.body;
  if (protocol === "openai") expect(wire.messages).toContainEqual({role: "tool", tool_call_id: "call_a", content: '{"city":"北京","temperature":20}'});
  else if (protocol === "claude") {
    const content = wire.messages.flatMap((item: any) => item.content);
    expect(content).toContainEqual({type: "thinking", thinking: "thought", signature: "signed-original"});
    expect(content).toContainEqual({type: "tool_result", tool_use_id: "call_a", content: '{"city":"北京","temperature":20}'});
  } else {
    const parts = wire.contents.flatMap((item: any) => item.parts);
    expect(parts).toContainEqual({functionCall: {id: "call_a", name: "weather", args: {city: "北京"}}, thoughtSignature: "signed-original"});
    expect(parts).toContainEqual({functionResponse: {id: "call_a", name: "weather", response: {result: '{"city":"北京","temperature":20}'}}});
  }
  expect(JSON.stringify(wire)).not.toContain("provider_response_");
  expect((await f.app.inject({method: "GET", url: "/api/backup"})).json().conversations[0].messages.at(-1).generationMetadata).toEqual(metadata);
  await f.restart(); expect((await f.readChat()).messages.at(-1).generationMetadata).toEqual(metadata);
  expect((await f.readChat()).messages.filter((item: any) => item.role === "assistant")).toHaveLength(2);
});

it("executes two independent IDs with identical arguments, and sends both results in the next actual request", async () => {
  const f = await fixture("openai", (round, res) => round === 1 ? toolResponse("openai", res, [call(), call("call_b")]) : finalResponse("openai", res));
  const events = await f.exchange(); expect(f.actions).toEqual(["北京", "北京"]);
  expect(f.requests[1]!.body.messages.filter((item: any) => item.role === "tool").map((item: any) => item.tool_call_id)).toEqual(["call_a", "call_b"]);
  expect(events.some(event => event.type === "done")).toBe(true);
});

it.each(["openai", "claude", "gemini"] as const)("replays %s tool history once after restart, keeping the final saved reply separate from its prelude", async protocol => {
  const prelude = "我先检查工具。";
  const f = await fixture(protocol, (round, res) => round === 1 ? toolResponse(protocol, res, [call()], "tool_calls", prelude) : finalResponse(protocol, res));
  const events = await f.exchange(), done = events.find(event => event.type === "done");
  expect(done).toMatchObject({message: {content: "工具结果已收到", generationMetadata: {toolRounds: [{content: prelude}]}}});
  await f.restart(); await f.exchange(); expect(f.actions).toEqual(["北京"]); expect(f.requests).toHaveLength(3);
  const wire = f.requests[2]!.body;
  const messages = protocol === "gemini" ? wire.contents : wire.messages;
  const text = JSON.stringify(messages);
  expect(text.match(/我先检查工具。/g)).toHaveLength(1);
  expect(text).not.toContain(prelude + "工具结果已收到");
  expect(text).not.toContain("provider_response_"); expect(text).not.toContain("toolRounds"); expect(text).not.toContain("responseState");
  const toolPosition = messages.findIndex((item: any) => protocol === "openai" ? item.role === "tool" :
    protocol === "claude" ? Array.isArray(item.content) && item.content.some((part: any) => part.type === "tool_result") : item.parts.some((part: any) => part.functionResponse));
  expect(toolPosition).toBeGreaterThan(0);
  expect(JSON.stringify(messages[toolPosition])).toContain('temperature');
  expect(JSON.stringify(messages[toolPosition - 1])).toContain("weather");
  expect(JSON.stringify(messages.slice(toolPosition + 1))).toContain("工具结果已收到");
});

it("commits a sticky world-info activation only once across two accepted provider rounds", async () => {
  const f = await fixture();
  expect((await f.app.inject({method: "POST", url: "/api/worldinfo/edit", payload: {name: "Tool-sticky", data: {entries: {
    0: {uid: 0, key: ["北京"], content: "TOOL_STICKY_ACTIVE", constant: false, disable: false, position: 0, order: 100, sticky: 3},
  }}}})).statusCode).toBe(200);
  const settings = (await f.app.inject({method: "GET", url: "/api/worldinfo/settings"})).json();
  expect((await f.app.inject({method: "PUT", url: "/api/worldinfo/settings", payload: {...settings, world_info: {globalSelect: ["Tool-sticky"], charLore: []}}})).statusCode).toBe(200);
  const events = await f.exchange(); expect(events.filter(event => event.type === "lorebook")).toHaveLength(1);
  expect(f.requests).toHaveLength(2); for (const request of f.requests) expect(JSON.stringify(request.body.messages)).toContain("TOOL_STICKY_ACTIVE");
  const chat = await f.readChat(), timer = chat.chatMetadata.timedWorldInfo.sticky["Tool-sticky.0"];
  expect(timer).toMatchObject({start: 2, end: 5});
  await f.restart(); expect((await f.readChat()).chatMetadata.timedWorldInfo.sticky["Tool-sticky.0"]).toEqual(timer);
});

it("rejects a returned invocation belonging to another response before issuing a second provider request", async () => {
  const f = await fixture();
  const events = await f.exchange({effect: async event => {
    const payload = await f.runtime.run(event.evaluation, AbortSignal.timeout(5000)); payload.invocations[0]!.id = "another_round";
    expect((await f.app.inject({method: "POST", url: `/api/generation/effects/${event.requestId}`, payload: {result: {payload, local: event.evaluation.local, global: event.evaluation.global}}})).statusCode).toBe(200);
  }});
  expect(f.actions).toEqual(["北京"]); expect(f.requests).toHaveLength(1);
  expect(events.find(event => event.type === "error")).toMatchObject({message: expect.stringContaining("不一致")});
  expect((await f.readChat()).messages.at(-1).status).toBe("failed");
});

it("writes a thrown callback as a real error result and allows the provider to recover in the next round", async () => {
  const f = await fixture(); f.runtime.ToolManager.registerFunctionTool({name: "weather", parameters: {}, action: () => {throw new Error("fixture action failed");}});
  const events = await f.exchange();
  expect(f.requests[1]!.body.messages).toContainEqual({role: "tool", tool_call_id: "call_a", content: "Error: fixture action failed"});
  expect(events.find(event => event.type === "done")).toMatchObject({message: {generationMetadata: {toolRounds: [{invocations: [{error: true}]}]}}});
});

it("executes stealth once without a saved invocation or a follow-up request", async () => {
  const f = await fixture(); f.runtime.ToolManager.registerFunctionTool({name: "weather", parameters: {}, stealth: true, action: () => {f.actions.push("stealth"); return "private";}});
  const events = await f.exchange(); expect(f.actions).toEqual(["stealth"]); expect(f.requests).toHaveLength(1);
  const done = events.find(event => event.type === "done"); expect(done).toBeDefined();
  if (done?.type === "done") {expect(done.message.generationMetadata?.toolRounds).toBeUndefined(); expect(JSON.stringify(done.message)).not.toContain("private");}
});

it.each(["length", "eof", "invalid-second-args"])("never dispatches even the first callback when the response is %s", async mode => {
  const f = await fixture("openai", (_round, res) => toolResponse("openai", res, mode === "invalid-second-args" ? [call(), call("call_b", '{"city":')] : [call()], mode === "invalid-second-args" ? "tool_calls" : mode));
  const events = await f.exchange(); expect(f.actions).toEqual([]); expect(f.requests).toHaveLength(1);
  expect(events.some(event => event.type === "effect_request")).toBe(false);
  expect(events.some(event => event.type === "error")).toBe(true); expect((await f.readChat()).messages.at(-1).status).toBe("failed");
});

it.each(["openai", "claude", "gemini"] as const)("rejects malformed %s JSON after a complete tool call before dispatching the original ToolManager", async protocol => {
  const prelude = "工具前已收到的中文", privateBody = "MALFORMED_TOOL_PROVIDER_BODY";
  const f = await fixture(protocol, (round, res) => round === 1
    ? toolResponse(protocol, res, [call()], "tool_calls", prelude, `data: {"private":"${privateBody}",\n\n`)
    : finalResponse(protocol, res));
  const events = await f.exchange();
  expect(events.find(event => event.type === "error")).toMatchObject({message: "模型返回了不兼容的响应格式。"});
  expect(events.find(event => event.type === "done")).toMatchObject({message: {status: "failed", content: prelude}});
  expect(f.actions).toEqual([]); expect(f.requests).toHaveLength(1); expect(f.backgroundRequests).toBe(0);
  expect(events.some(event => event.type === "effect_request")).toBe(false);
  expect(JSON.stringify(events)).not.toContain(privateBody);
  const chat = await f.readChat();
  expect(chat.messages.at(-1)).toMatchObject({status: "failed", content: prelude});
  expect(chat.messages.at(-1).generationMetadata.toolRounds).toBeUndefined();
  expect((await f.app.inject({method: "GET", url: "/api/backup"})).body).not.toContain(privateBody);
  // The failed stream releases both its reader and conversation generation lock.
  expect((await f.exchange()).find(event => event.type === "done")).toMatchObject({message: {status: "complete", content: "工具结果已收到"}});
  expect(f.actions).toEqual([]); expect(f.requests).toHaveLength(2);
});

it("rejects an oversized second preflight before its HTTP request, retaining the completed first tool round", async () => {
  const f = await fixture();
  const events = await f.exchange({preflight: async (request, ordinal) => ordinal === 1 ? {...request, messages: [{role: "user", content: "large ".repeat(18000)}]} : request});
  expect(f.requests).toHaveLength(1); expect(f.actions).toEqual(["北京"]);
  expect(events.some(event => event.type === "error")).toBe(true);
  expect((await f.readChat()).messages.at(-1)).toMatchObject({status: "failed", generationMetadata: {toolRounds: [{invocations: [{id: "call_a"}]}]}});
});

it.each(["openai", "claude", "gemini"] as const)("budgets long actual %s tool results before sending the continuation", async protocol => {
  const f = await fixture(protocol);
  f.runtime.ToolManager.registerFunctionTool({name: "weather", parameters: {}, action: () => "large tool result ".repeat(15000)});
  const events = await f.exchange(); expect(f.requests).toHaveLength(1);
  expect(events.find(event => event.type === "error")).toMatchObject({message: expect.stringContaining("上下文上限")});
  expect((await f.readChat()).messages.at(-1)).toMatchObject({status: "failed", generationMetadata: {toolRounds: [{invocations: [{id: "call_a"}]}]}});
});

it("stops a pending tool exchange, rejects its late result and releases generation for the next send", async () => {
  const f = await fixture(); let requestId = "";
  const events = await f.exchange({effect: async event => {requestId = event.requestId; expect((await f.app.inject({method: "POST", url: `/api/conversations/${f.story.id}/generation/stop`})).statusCode).toBe(200);}});
  expect(f.actions).toEqual([]); expect(f.requests).toHaveLength(1);
  expect(events.find(event => event.type === "done")).toMatchObject({message: {status: "stopped"}});
  expect((await f.app.inject({method: "POST", url: `/api/generation/effects/${requestId}`, payload: {result: {payload: {}, local: {}, global: {}}}})).statusCode).toBe(409);
  expect((await f.exchange()).some(event => event.type === "done")).toBe(true); expect(f.requests).toHaveLength(2);
});

it("enforces the original five executed rounds and refuses the sixth callback", async () => {
  const f = await fixture("openai", (round, res) => toolResponse("openai", res, [call(`call_${round}`)]));
  const events = await f.exchange(); expect(f.requests).toHaveLength(6); expect(f.actions).toHaveLength(5);
  expect(events.filter(event => event.type === "effect_request")).toHaveLength(5);
  expect(events.find(event => event.type === "error")).toMatchObject({message: expect.stringContaining("5 轮")});
  expect((await f.readChat()).messages.at(-1).generationMetadata.toolRounds).toHaveLength(5);
});

it("keeps quiet generation from executing real tools or persisting an assistant message", async () => {
  const f = await fixture(), before = await f.readChat(); const events = await f.exchange({quiet: true});
  expect(f.actions).toEqual([]); expect(f.requests).toHaveLength(1); expect(events.some(event => event.type === "effect_request")).toBe(false);
  expect(events.some(event => event.type === "error")).toBe(true); expect(await f.readChat()).toEqual(before);
});
