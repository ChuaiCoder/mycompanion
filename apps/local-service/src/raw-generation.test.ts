import { afterEach, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); vi.unstubAllGlobals(); });
async function fixture() {
  const app = buildApp({ secretCodec: { seal: value => 'sealed:' + value, unseal: value => value.slice(7) } });
  apps.push(app);
  const saved = await app.inject({ method: "PUT", url: "/api/settings/provider", payload: {
    kind: "openai-compatible", baseUrl: "http://localhost:9999/v1", model: "raw-model", apiKey: "fixture-key", temperature: 1.2, maxTokens: 4096,
  } });
  expect(saved.statusCode, saved.body).toBe(200);
  return app;
}
it("uses real provider credentials and sampling without the memory cap or saved-setting mutation", async () => {
  const app = await fixture();
  const payloads: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: URL, init: RequestInit) => {
    expect(String(url)).toBe("http://localhost:9999/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer fixture-key");
    const body = JSON.parse(String(init.body)); payloads.push(body);
    return Response.json({ choices: [{ message: { content: "result", reasoning_content: "reasoning" } }], usage: { total_tokens: 3 } });
  }));
  const messages = [{ role: "user", content: "raw input", name: "Tester" }];
  const response = await app.inject({ method: "POST", url: "/api/extensions/generate-raw", payload: { messages, responseLength: 8000 } });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().choices[0].message.reasoning_content).toBe("reasoning");
  await app.inject({ method: "POST", url: "/api/extensions/generate-raw", payload: { messages } });
  expect(payloads[0]).toEqual({ model: "raw-model", messages, max_tokens: 8000, temperature: 1.2, stream: false });
  expect(payloads[1]?.max_tokens).toBe(4096);
  expect((await app.inject({ method: "GET", url: "/api/settings/provider" })).json().maxTokens).toBe(4096);
});

it("translates Tavern structured-output schema without forwarding client extraction options", async () => {
  const app = await fixture(); let sent: Record<string, unknown> = {};
  vi.stubGlobal("fetch", vi.fn(async (_url: URL, init: RequestInit) => { sent = JSON.parse(String(init.body)); return Response.json({ choices: [] }); }));
  const response = await app.inject({ method: "POST", url: "/api/extensions/generate-raw", payload: {
    messages: [{ role: "system", content: "JSON" }], jsonSchema: { name: "answer", description: "A result", value: { type: "object", properties: { result: { type: "string" } }, required: ["result"] }, strict: true, returnInvalid: true },
  } });
  expect(response.statusCode, response.body).toBe(200);
  expect(sent.response_format).toEqual({ type: "json_schema", json_schema: { name: "answer", description: "A result", schema: { type: "object", properties: { result: { type: "string" } }, required: ["result"] }, strict: true } });
});

it("rejects invalid requests before contacting the provider and propagates provider errors", async () => {
  const app = await fixture(); const fetchMock = vi.fn(async () => Response.json({ error: { message: "Rate limited" } }, { status: 429 })); vi.stubGlobal("fetch", fetchMock);
  for (const payload of [{ messages: [] }, { messages: [{ role: "invalid", content: "x" }] }, { messages: [{ role: "user", content: "x" }], responseLength: -1 }]) {
    expect((await app.inject({ method: "POST", url: "/api/extensions/generate-raw", payload })).statusCode).toBe(400);
  }
  expect(fetchMock).not.toHaveBeenCalled();
  const response = await app.inject({ method: "POST", url: "/api/extensions/generate-raw", payload: { messages: [{ role: "user", content: "x" }] } });
  expect(response.statusCode).toBe(429); expect(response.body).toContain("额度不足");
});

it("service shutdown aborts an active raw request including response-body reads", async () => {
  const app = await fixture(); let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }); let aborted = false;
  vi.stubGlobal("fetch", vi.fn(async (_url: URL, init: RequestInit) => ({ ok: true, json: async () => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => { aborted = true; reject(init.signal!.reason); }, { once: true }); entered();
  }) })));
  const response = app.inject({ method: "POST", url: "/api/extensions/generate-raw", payload: { messages: [{ role: "user", content: "hold" }] } });
  const pending = response.then(value => value);
  await started; await app.close();
  expect(aborted).toBe(true); expect((await pending).statusCode).toBe(499);
});
