import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderSettings } from "@mycompanion/shared";
import { probeProvider } from "./provider-probe.js";
import { apps, completionResponse } from "../testing/helpers.js";
import { buildApp } from "../app.js";

const settings: ProviderSettings = { kind: "openai-compatible", baseUrl: "https://provider.example/v1", model: "selected-model",
  hasApiKey: false, temperature: 0.8, maxTokens: 1024, contextLimitTokens: 32768 };
afterEach(() => vi.unstubAllGlobals());

describe("未配置时的默认生成参数", () => {
  it("defaults the reply budget high enough for narrative replies", async () => {
    // 1024 曾经是默认值，实测一张角色卡的开场在那里被句中截断（finishReason: length，
    // completionOutcome: truncated）。叙述型回复要成段输出，而带推理的模型还会先从同一预算里
    // 扣掉思考 token（同一次实测：reasoningTokens 421 / outputTokens 1024），留给正文的更少。
    const app = buildApp({ databasePath: ":memory:" }); apps.push(app);
    const provider = (await app.inject({ method: "GET", url: "/api/settings/provider" })).json() as ProviderSettings;
    expect(provider.maxTokens).toBe(4096);
    expect(provider.maxTokens).toBeGreaterThan(1024);
    // 回复预算必须留在上下文预算之内，否则会被截断而不是报错。
    expect(provider.maxTokens).toBeLessThan(provider.contextLimitTokens);
  });
});

describe("draft model checks", () => {
  it("tests the selected model using a real completion request without saving configuration or replies", async () => {
    const fetchMock = vi.fn(async () => completionResponse("OK")); vi.stubGlobal("fetch", fetchMock);
    const app = buildApp({ databasePath: ":memory:" }); apps.push(app);
    const before = (await app.inject({ method: "GET", url: "/api/settings/provider" })).json();
    const result = await app.inject({ method: "POST", url: "/api/settings/provider/test", payload: { ...settings, apiKey: "draft-key" } });
    expect(result.json()).toMatchObject({ ok: true, testedModel: "selected-model", capability: "chat-completion" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe("https://provider.example/v1/chat/completions");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "selected-model", stream: false, max_tokens: 16 });
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer draft-key");
    expect((await app.inject({ method: "GET", url: "/api/settings/provider" })).json()).toEqual(before);
    expect((await app.inject({ method: "GET", url: "/api/conversations" })).json().items).toEqual([]);
    expect(result.body).not.toContain("draft-key");
  });

  it("reuses a saved credential only for the same service, never a newly typed endpoint", async () => {
    const mock = vi.fn(async () => completionResponse("OK")); vi.stubGlobal("fetch", mock);
    const app = buildApp({ databasePath: ":memory:", secretCodec: { seal: value => `sealed:${value}`, unseal: value => value.slice(7) } }); apps.push(app);
    await app.inject({ method: "PUT", url: "/api/settings/provider", payload: { ...settings, apiKey: "saved-secret" } });
    await app.inject({ method: "POST", url: "/api/settings/provider/test", payload: settings });
    await app.inject({ method: "POST", url: "/api/settings/provider/test", payload: { ...settings, baseUrl: "https://another.example/v1" } });
    expect(new Headers((mock.mock.calls[0] as unknown as [URL, RequestInit])[1].headers).get("Authorization")).toBe("Bearer saved-secret");
    expect(new Headers((mock.mock.calls[1] as unknown as [URL, RequestInit])[1].headers).has("Authorization")).toBe(false);
  });

  it.each([[401, "AUTHENTICATION", "apiKey"], [403, "AUTHENTICATION", "apiKey"], [404, "MODEL_NOT_FOUND", "model"],
    [429, "RATE_LIMIT", "connection"], [503, "SERVICE_UNAVAILABLE", "connection"], [400, "REQUEST_REJECTED", "model"]])
    ("classifies HTTP %s without echoing an untrusted provider message or key", async (status, code, field) => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":{"message":"echo-secret"}}', { status: Number(status) })));
      const result = await probeProvider(settings, "echo-secret");
      expect(result).toMatchObject({ ok: false, issue: { code, field } });
      expect(JSON.stringify(result)).not.toContain("echo-secret");
    });

  it.each(["not-json", "null", "{}", '{"choices":[{"message":{"content":""}}]}'])
    ("reports malformed or empty responses as an incompatible protocol: %s", async body => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
      expect(await probeProvider(settings)).toMatchObject({ ok: false, issue: { code: "INVALID_RESPONSE" } });
    });

  it("reports timeout separately from connection failures", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: URL, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })));
    expect(await probeProvider(settings, undefined, 20)).toMatchObject({ ok: false, issue: { code: "TIMEOUT", retryable: true } });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network failed"); }));
    expect(await probeProvider(settings)).toMatchObject({ ok: false, issue: { code: "CONNECTION" } });
  });

  it("rejects an invalid URL before making a request", async () => {
    const mock = vi.fn(); vi.stubGlobal("fetch", mock);
    expect(await probeProvider({ ...settings, baseUrl: "file:///etc" })).toMatchObject({ ok: false, issue: { code: "INVALID_ADDRESS" } });
    expect(mock).not.toHaveBeenCalled();
  });
});
