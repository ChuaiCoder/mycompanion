import { afterEach, expect, it, vi } from "vitest";
import type { GenerationSseEvent } from "@mycompanion/shared";
import { buildApp } from "./app.js";
import { apps, fullV2Card, sseResponse, completionResponse } from "./test-helpers.js";
import { MacroEvaluationSession } from "./prompt-macros.js";

afterEach(() => vi.restoreAllMocks());

const nativeFetch = globalThis.fetch;
async function fixture() {
  const app = buildApp(); apps.push(app);
  const card = (await app.inject({ method: "POST", url: "/api/characters/import/commit", payload: { filename: "preflight.json", card: fullV2Card } })).json();
  await app.inject({ method: "PUT", url: "/api/settings/provider", payload: { kind: "ollama", baseUrl: "http://provider.test/v1", model: "gpt-4o", maxTokens: 128, contextLimitTokens: 4096 } });
  const chat = (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: card.id } })).json();
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith(base)) return nativeFetch(url, init);
    const body = JSON.parse(String(init?.body)); requests.push(body);
    return body.stream ? sseResponse(["accepted"]) : completionResponse("nonstream");
  });
  const readChat = async () => (await app.inject({ method: "GET", url: `/api/conversations/${chat.id}` })).json();
  const exchange = async (payload: Record<string, unknown> = {}, regenerate = false, quiet = false) => {
    const controller = new AbortController();
    const response = await nativeFetch(`${base}/api/conversations/${chat.id}${quiet ? "/quiet-generation" : `/messages${regenerate ? "/regenerate" : ""}`}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(quiet ? {...payload,browserPreflight:true} : regenerate ? { browserPreflight: true, dryRun: payload.dryRun ?? false } : { content: "", allowEmpty: true, browserPreflight: true, ...payload }), signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader(), decoder = new TextDecoder();
    let buffer = "";
    const events: GenerationSseEvent[] = [];
    async function read() {
      const { value, done } = await reader.read();
      if (done) return false;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        if (raw.startsWith("data: ")) events.push(JSON.parse(raw.slice(6)));
      }
      return true;
    }
    while (!events.some(event => event.type === "completion_request")) if (!await read()) throw new Error("Missing completion request");
    const event = events.find(event => event.type === "completion_request")!;
    if (event.type !== "completion_request") throw new Error("Wrong event");
    return { controller, events, event, answer: (payload: Record<string, unknown>) => app.inject({ method: "POST", url: `/api/generation/preflight/${event.requestId}`, payload }),
      finish: async () => { while (await read()) { /* drain */ } return events; } };
  };
  return { app, chat, requests, readChat, exchange };
}

it.each(["dry","cancel","conflict","success"])("stages native macro writes until accepted preflight: %s",async mode=>{
  const f=await fixture();
  await f.app.inject({method:"PUT",url:"/api/extensions/settings",payload:{extensionSettings:{__mycompanion_power_user:{experimental_macro_engine:true},variables:{global:{counter:0}}}}});
  const before=await f.readChat();
  const evaluate=vi.spyOn(MacroEvaluationSession.prototype,"evaluate");
  const x=await f.exchange({dryRun:mode==="dry",extensionPrompts:[{key:"variables",value:"{{incvar::counter}}/{{incglobalvar::counter}}",position:1,depth:0,role:0,scan:true}]});
  const counterPasses=evaluate.mock.calls.flatMap(([text],index)=>text.includes("{{incvar::counter}}")?[evaluate.mock.results[index]?.value]:[]);
  // First the WI scan bucket expands, then the outgoing IN_CHAT bucket expands.
  expect(counterPasses).toEqual(["1/1","2/2"]);
  expect(JSON.stringify(x.event.request.messages)).toContain("2/2");
  expect(await f.readChat()).toEqual(before);
  if(mode==="conflict")await f.app.inject({method:"PUT",url:"/api/extensions/settings",payload:{extensionSettings:{__mycompanion_power_user:{experimental_macro_engine:true},variables:{global:{counter:9}}}}});
  await x.answer(mode==="cancel"?{error:"cancelled"}:{request:x.event.request});
  const events=await x.finish();
  const settings=(await f.app.inject({method:"GET",url:"/api/extensions/settings"})).json().extensionSettings;
  if(mode==="success"){
    // WI scan and final assembly each substitute their own extension bucket.
    expect(f.requests).toHaveLength(1);expect((await f.readChat()).chatMetadata.variables.counter).toBe(2);expect(settings.variables.global.counter).toBe(2);
    expect(events.some(event=>event.type==="macro_variables")).toBe(true);
  }else{
    expect(f.requests).toHaveLength(0);expect(await f.readChat()).toEqual(before);
    expect(settings.variables.global.counter).toBe(mode==="conflict"?9:0);
    expect(events.some(event=>event.type==="macro_variables")).toBe(false);
    if(mode==="conflict")expect(events).toContainEqual({type:"error",message:"生成期间变量 counter 已被修改，请重新生成以使用最新值。"});
  }
});

it("reports quiet preflight variable conflicts without sending a provider request", async () => {
  const f = await fixture();
  const settings = { __mycompanion_power_user: { experimental_macro_engine: true }, variables: { global: { counter: 0 } } };
  await f.app.inject({ method: "PUT", url: "/api/extensions/settings", payload: { extensionSettings: settings } });
  const before = await f.readChat();
  const x = await f.exchange({ quietPrompt: "{{incvar::local}}/{{incglobalvar::counter}}" }, false, true);
  settings.variables.global.counter = 9;
  await f.app.inject({ method: "PUT", url: "/api/extensions/settings", payload: { extensionSettings: settings } });
  await x.answer({ request: x.event.request });
  expect(await x.finish()).toContainEqual({ type: "error", message: "生成期间变量 counter 已被修改，请重新生成以使用最新值。" });
  expect(f.requests).toHaveLength(0);
  expect(await f.readChat()).toEqual(before);
});

it("holds provider and message creation, then sends rewritten custom/nonstream data without another macro pass", async () => {
  const f = await fixture(), x = await f.exchange();
  expect(f.requests).toHaveLength(0); expect((await f.readChat()).messages).toEqual(f.chat.messages);
  const request = { ...x.event.request, messages: [{ role: "user", content: "literal {{random::a::b}}" }], stream: false,
    custom_include_body: "temperature: 0.25\nmax_tokens: 64" };
  expect((await x.answer({ request })).statusCode).toBe(200);
  const events = await x.finish();
  expect(f.requests[0]).toMatchObject({ messages: request.messages, stream: false, temperature: 0.25, max_tokens: 64 });
  expect(events).toContainEqual(expect.objectContaining({ type: "done", message: expect.objectContaining({ content: "nonstream", status: "complete" }) }));
  expect((await f.readChat()).messages).toHaveLength(f.chat.messages.length + 1);
  expect((await x.answer({ request })).statusCode).toBe(409);
});

it.each([false, true])("dryRun keeps chat and branch unchanged (regenerate=%s)", async regenerate => {
  const f = await fixture(), x = await f.exchange({ content: "/must-not-run", dryRun: true }, regenerate);
  expect((await x.answer({ request: x.event.request })).statusCode).toBe(200);
  expect(await x.finish()).toContainEqual({ type: "generation_end", reason: "preview" });
  expect(f.requests).toHaveLength(0); expect(await f.readChat()).toEqual(f.chat);
});

it.each(["listener", "invalid", "budget", "completion-budget"])("rejects %s before provider and assistant creation", async mode => {
  const f = await fixture(), x = await f.exchange();
  const request = { ...x.event.request };
  if (mode === "invalid") request.messages = [];
  if (mode === "budget") request.custom_include_body = JSON.stringify({ messages: [{ role: "user", content: "large ".repeat(8000) }] });
  if (mode === "completion-budget") request.max_completion_tokens = 5000;
  await x.answer(mode === "listener" ? { error: "Listener failed" } : { request });
  expect(await x.finish()).toContainEqual(expect.objectContaining({ type: "error" }));
  expect(f.requests).toHaveLength(0); expect((await f.readChat()).messages).toEqual(f.chat.messages);
});

it.each([false, true])("stop releases preflight without a phantom message or branch (regenerate=%s)", async regenerate => {
  const f = await fixture(), x = await f.exchange({}, regenerate);
  await f.app.inject({ method: "POST", url: `/api/conversations/${f.chat.id}/generation/stop` });
  expect(await x.finish()).toContainEqual({ type: "generation_end", reason: "stopped" });
  expect(f.requests).toHaveLength(0); expect(await f.readChat()).toEqual(f.chat);
  expect((await x.answer({ request: x.event.request })).statusCode).toBe(409);
  const next = await f.exchange(); await next.answer({ request: next.event.request });
  expect(await next.finish()).toContainEqual(expect.objectContaining({ type: "done" }));
});

it("disconnect releases the pending exchange and shutdown does not hang", async () => {
  const f = await fixture(), x = await f.exchange(); x.controller.abort();
  await expect(x.finish()).rejects.toThrow();
  await vi.waitFor(async () => {
    const response = await f.app.inject({ method: "POST", url: `/api/conversations/${f.chat.id}/messages`, payload: { content: "", dryRun: true } });
    expect(response.statusCode).toBe(200);
  });
  expect((await x.answer({ request: x.event.request })).statusCode).toBe(409);
  const next = await f.exchange(); await f.app.close();
  await next.finish(); expect(f.requests).toHaveLength(0);
});

it("refuses a concurrent regenerate while waiting for preflight", async () => {
  const f = await fixture(), x = await f.exchange();
  expect((await f.app.inject({ method: "POST", url: `/api/conversations/${f.chat.id}/messages/regenerate`, payload: {} })).statusCode).toBe(409);
  await x.answer({ request: x.event.request }); await x.finish();
});

it("quiet preflight supports schema, mutable requests and nonstream output without chat writes", async () => {
  const f = await fixture(), x = await f.exchange({quietPrompt:"QUIET {{maxResponse}}",responseLength:77,jsonSchema:{name:"result",value:{type:"object"}}},false,true);
  expect(f.requests).toHaveLength(0);
  expect(x.event.request.messages.at(-1)?.content).toBe("QUIET 77");
  expect(x.event.request.json_schema).toMatchObject({name:"result"});
  await x.answer({request:{...x.event.request,stream:false,temperature:0.4}});
  expect(await x.finish()).toContainEqual({type:"quiet_result",text:"{}"});
  expect(f.requests[0]).toMatchObject({max_tokens:77,temperature:0.4,response_format:{type:"json_schema"}});
  expect(await f.readChat()).toEqual(f.chat);
});

it("quiet dryRun emits preview and leaves messages and model untouched", async () => {
  const f = await fixture(), x = await f.exchange({quietPrompt:"preview",dryRun:true},false,true);
  await x.answer({request:x.event.request});
  expect(await x.finish()).toContainEqual({type:"generation_end",reason:"preview"});
  expect(f.requests).toHaveLength(0);expect(await f.readChat()).toEqual(f.chat);
});

it.each(["failure","budget","disconnect"])("quiet %s ends before model and releases the exchange", async mode => {
  const f = await fixture(), x = await f.exchange({quietPrompt:"quiet"},false,true);
  if(mode==="disconnect") {x.controller.abort();await expect(x.finish()).rejects.toThrow();}
  else {
    await x.answer(mode==="failure" ? {error:"listener failure"} : {request:{...x.event.request,max_completion_tokens:5000}});
    expect(await x.finish()).toContainEqual(expect.objectContaining({type:"error"}));
  }
  expect(f.requests).toHaveLength(0);expect(await f.readChat()).toEqual(f.chat);
  const next=await f.exchange({dryRun:true},false,true);await next.answer({request:next.event.request});await next.finish();
});
