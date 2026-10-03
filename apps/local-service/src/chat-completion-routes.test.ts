import { afterEach, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); vi.unstubAllGlobals(); });
async function fixture() {
  const app = buildApp({ secretCodec: {seal: value => value, unseal: value => value} }); apps.push(app);
  await app.inject({method:"PUT",url:"/api/settings/provider",payload:{kind:"openai-compatible",baseUrl:"http://localhost:9999/v1",model:"configured",apiKey:"saved-key"}});
  return app;
}
it("relays exact provider data and custom request YAML without serializing transport secrets", async () => {
  const app = await fixture(); let sent: Record<string, unknown> = {};
  vi.stubGlobal("fetch", vi.fn(async (url: URL, init: RequestInit) => {
    expect(String(url)).toBe("http://localhost:9999/v1/chat/completions");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer override-key");
    expect(new Headers(init.headers).get("x-fixture")).toBe("yes");
    sent = JSON.parse(String(init.body));
    return new Response('{"choices":[{"message":{"content":"reply","reasoning":"thought"}}],"usage":{"total_tokens":9}}', {headers:{"content-type":"application/json"}});
  }));
  const response = await app.inject({method:"POST",url:"/api/backends/chat-completions/generate",payload:{
    messages:[{role:"user",content:"hello"}],chat_completion_source:"custom",model:"override",stream:false,temperature:0.5,logprobs:3,
    proxy_password:"secret-in-transport",custom_include_headers:"Authorization: Bearer override-key\nX-Fixture: yes",
    custom_include_body:"- extra: true\n- temperature: 0.7",custom_exclude_body:"- temperature",
    json_schema:{name:"answer",value:{type:"object"}},tools:[{type:"function",function:{name:"tool"}}],tool_choice:"auto",
  }});
  expect(response.statusCode, response.body).toBe(200); expect(response.json().usage.total_tokens).toBe(9);
  expect(sent).toMatchObject({model:"override",extra:true,logprobs:true,top_logprobs:3,tool_choice:"auto",response_format:{type:"json_schema",json_schema:{name:"answer",schema:{type:"object"},strict:true}}});
  expect(sent).not.toHaveProperty("temperature"); expect(JSON.stringify(sent)).not.toContain("secret-in-transport"); expect(sent).not.toHaveProperty("chat_completion_source");
});
it("does not send a saved key to a different override origin and honors explicit proxy credentials", async () => {
  const app = await fixture(); const authorizations: Array<string | null> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: URL, init: RequestInit) => { authorizations.push(new Headers(init.headers).get("authorization")); return Response.json({choices:[]}); }));
  const send = (extra: Record<string, unknown>) => app.inject({method:"POST",url:"/api/backends/chat-completions/generate",payload:{messages:[{role:"user",content:"x"}],...extra}});
  await send({}); await send({custom_url:"http://localhost:9998/v1"}); await send({custom_url:"http://localhost:9998/v1",proxy_password:"explicit"});
  await send({custom_url:"http://localhost:9999/different/v1"});
  expect(authorizations).toEqual(["Bearer saved-key",null,"Bearer explicit",null]);
});
it("preserves provider HTTP status with safe diagnostics and rejects unsupported native protocol before fetching", async () => {
  const app = await fixture(); const fetchMock = vi.fn(async () => Response.json({error:{message:"Provider quota"}}, {status:429})); vi.stubGlobal("fetch",fetchMock);
  const rejected = await app.inject({method:"POST",url:"/api/backends/chat-completions/generate",payload:{messages:[{}],chat_completion_source:"claude"}});
  expect(rejected.statusCode).toBe(400); expect(fetchMock).not.toHaveBeenCalled();
  const result = await app.inject({method:"POST",url:"/api/backends/chat-completions/generate",payload:{messages:[{role:"user",content:"x"}]}});
  expect(result.statusCode).toBe(429); expect(result.json().error.message).toContain("额度不足");
});
it("relays split SSE bytes without losing multi-choice, reasoning or tool fields", async () => {
  const app = await fixture(); const source = 'data: {"choices":[{"index":0,"delta":{"content":"你好","reasoning_content":"想","tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n';
  const bytes = new TextEncoder().encode(source);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({start(controller) {for (let i=0;i<bytes.length;i+=7) controller.enqueue(bytes.slice(i,i+7));controller.close();}}),{headers:{"content-type":"text/event-stream"}})));
  const response = await app.inject({method:"POST",url:"/api/backends/chat-completions/generate",payload:{messages:[{role:"user",content:"x"}],stream:true}});
  expect(response.statusCode).toBe(200); expect(response.body).toBe(source);
});

it("applies per-request context limits without persisting or forwarding them", async () => {
  const app = await fixture();
  await app.inject({method:"PUT",url:"/api/settings/provider",payload:{kind:"ollama",baseUrl:"http://localhost:9999/v1",model:"gpt-4o",maxTokens:128,contextLimitTokens:1024}});
  const sent: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: URL, init: RequestInit) => {sent.push(JSON.parse(String(init.body)));return Response.json({choices:[]});}));
  const payload = {messages:[{role:"user",content:"hello ".repeat(1000)}],max_tokens:128};
  const send = (extra = {}) => app.inject({method:"POST",url:"/api/backends/chat-completions/generate",payload:{...payload,...extra}});
  expect((await send()).statusCode).toBe(400);
  const [accepted, rejected] = await Promise.all([send({_mycompanion_context_limit:4096}),send({_mycompanion_context_limit:1000})]);
  expect(accepted.statusCode,accepted.body).toBe(200);expect(rejected.statusCode).toBe(400);
  expect(sent).toHaveLength(1);expect(sent[0]).not.toHaveProperty("_mycompanion_context_limit");
  expect((await app.inject({method:"GET",url:"/api/settings/provider"})).json().contextLimitTokens).toBe(1024);
});

it.each([
  ["custom body messages", {custom_include_body:JSON.stringify({messages:[{role:"user",content:"hello ".repeat(2000)}]})}],
  ["completion reserve", {max_completion_tokens:2000}],
  ["custom completion reserve", {custom_include_body:"max_completion_tokens: 2000"}],
  ["tools", {tools:[{type:"function",function:{name:"test",description:"hello ".repeat(2000)}}]}],
  ["structured output", {json_schema:{name:"answer",value:{type:"string",description:"hello ".repeat(2000)}}}],
])("rejects final budget overflow from %s before contacting the provider", async (_name, extra) => {
  const app=await fixture(), fetchMock=vi.fn(async()=>Response.json({choices:[]}));vi.stubGlobal("fetch",fetchMock);
  const payload={messages:[{role:"user",content:"small"}],model:"gpt-4o",max_tokens:128,_mycompanion_context_limit:1024};
  const response=await app.inject({method:"POST",url:"/api/backends/chat-completions/generate",payload:{...payload,...extra}});
  expect(response.statusCode,response.body).toBe(400);expect(response.json().error.message).toContain("超出上下文");expect(fetchMock).not.toHaveBeenCalled();
  const recovery=await app.inject({method:"POST",url:"/api/backends/chat-completions/generate",payload});
  expect(recovery.statusCode,recovery.body).toBe(200);expect(fetchMock).toHaveBeenCalledOnce();
});

it("validates the final message shape after custom YAML edits", async () => {
  const app=await fixture(),fetchMock=vi.fn();vi.stubGlobal("fetch",fetchMock);
  const response=await app.inject({method:"POST",url:"/api/backends/chat-completions/generate",payload:{messages:[{role:"user",content:"valid"}],custom_include_body:'messages: [{role: invalid, content: x}]'}});
  expect(response.statusCode).toBe(400);expect(response.json().error.message).toContain("无效的模型请求");expect(fetchMock).not.toHaveBeenCalled();
});

it("service shutdown cancels an upstream response that has sent headers but never finishes", async () => {
  const app = await fixture(), nativeFetch = globalThis.fetch; let cancelled = false;
  vi.stubGlobal("fetch", vi.fn(async (_url: URL, init: RequestInit) => new Response(new ReadableStream({start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'));
    init.signal!.addEventListener("abort", () => {cancelled = true; controller.error(init.signal!.reason);}, {once:true});
  }}),{headers:{"content-type":"text/event-stream"}})));
  const origin = await app.listen({host:"127.0.0.1",port:0});
  const response = await nativeFetch(origin + "/api/backends/chat-completions/generate", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messages:[{role:"user",content:"hold"}],stream:true})});
  const reader = response.body!.getReader(); await reader.read();
  const read = reader.read().then(() => "ended", () => "aborted");
  await app.close(); expect(cancelled).toBe(true); expect(await read).toBe("aborted");
  reader.releaseLock();
});
