import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { listProviderModels } from "./provider-models.js";

// 「测试获取模型」必须按协议鉴权：以前只有 OpenAI 一种实现（GET /models + Bearer），
// 对 Claude 和 Gemini 必然失败，于是配置正常的用户被报成「未连接」。
// 这里用真实 HTTP 服务记录收到的请求，验证各协议的鉴权头与解析结果。

interface SeenRequest {
  url: string;
  authorization: string | undefined;
  apiKey: string | undefined;
  geminiKey: string | undefined;
  version: string | undefined;
}

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    // 关掉监听并断开keep-alive连接，避免把套接字留给后面的测试（并行跑全套时会造成干扰）。
    await new Promise<void>(done => { server.close(() => done()); });
    server.closeAllConnections();
  }
});

/** 起一个本地服务：记录请求，并按 body 返回各协议的结构。 */
async function stubProvider(responses: Record<string, unknown>): Promise<{ baseUrl: string; seen: SeenRequest[] }> {
  const seen: SeenRequest[] = [];
  const server = createServer((request, response) => {
    const headers = request.headers;
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    seen.push({
      url: `${url.pathname}${url.search}`,
      authorization: headers.authorization,
      apiKey: typeof headers["x-api-key"] === "string" ? headers["x-api-key"] : undefined,
      geminiKey: typeof headers["x-goog-api-key"] === "string" ? headers["x-goog-api-key"] : undefined,
      version: typeof headers["anthropic-version"] === "string" ? headers["anthropic-version"] : undefined,
    });
    const key = url.pathname.includes("models") ? "models" : "chat";
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(responses[key] ?? {}));
  });
  servers.push(server);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, seen };
}

const settings = (baseUrl: string, kind: "openai-compatible" | "anthropic" | "gemini") => ({
  kind, baseUrl, model: "fixture", hasApiKey: true, temperature: 0.8, maxTokens: 1_024, contextLimitTokens: 32_768,
});

describe("listProviderModels（测试获取模型）", () => {
  it("reads the OpenAI-compatible shape and sends the key as a Bearer token", async () => {
    const { baseUrl, seen } = await stubProvider({ models: { data: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }] } });
    const result = await listProviderModels(settings(baseUrl, "openai-compatible"), "sk-openai");

    expect(result.ok).toBe(true);
    expect(result.models).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("/v1/models");
    expect(seen[0]!.authorization).toBe("Bearer sk-openai");
    // 不能把 OpenAI 的鉴权头发给别家协议。
    expect(seen[0]!.apiKey).toBeUndefined();
    expect(seen[0]!.geminiKey).toBeUndefined();
  });

  it("uses the Anthropic headers for Claude instead of a Bearer token", async () => {
    // 这是之前会误报的路径：Claude 要 x-api-key + anthropic-version。
    const { baseUrl, seen } = await stubProvider({ models: { data: [{ id: "claude-sonnet-4-6" }] } });
    const result = await listProviderModels(settings(baseUrl, "anthropic"), "sk-ant");

    expect(result.ok).toBe(true);
    expect(result.models).toEqual(["claude-sonnet-4-6"]);
    expect(seen[0]!.apiKey).toBe("sk-ant");
    expect(seen[0]!.version).toBe("2023-06-01");
    expect(seen[0]!.authorization).toBeUndefined();
  });

  it("uses the Gemini header and strips the models/ prefix", async () => {
    const { baseUrl, seen } = await stubProvider({ models: { models: [{ name: "models/gemini-2.5-flash" }, { name: "models/gemini-2.5-pro" }] } });
    const result = await listProviderModels(settings(baseUrl, "gemini"), "gm-key");

    expect(result.ok).toBe(true);
    // 返回给用户的是可直接填进设置的名字，不带 models/ 前缀。
    expect(result.models).toEqual(["gemini-2.5-flash", "gemini-2.5-pro"]);
    expect(seen[0]!.geminiKey).toBe("gm-key");
    expect(seen[0]!.authorization).toBeUndefined();
    expect(seen[0]!.apiKey).toBeUndefined();
  });

  it("deduplicates and sorts the model list", async () => {
    const { baseUrl } = await stubProvider({ models: { data: [{ id: "b" }, { id: "a" }, { id: "b" }, { notId: 1 }] } });
    const result = await listProviderModels(settings(baseUrl, "openai-compatible"), "k");
    expect(result.models).toEqual(["a", "b"]);
  });

  it("explains a rejected key instead of reporting a network failure", async () => {
    const server = createServer((_request, response) => { response.writeHead(401, { "Content-Type": "application/json" }); response.end("{}"); });
    servers.push(server);
    await new Promise<void>(done => server.listen(0, "127.0.0.1", () => done()));
    const address = server.address() as { port: number };

    const result = await listProviderModels(settings(`http://127.0.0.1:${address.port}/v1`, "openai-compatible"), "bad");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("密钥被拒绝");
  });

  it("tells the user when the address has no model list endpoint", async () => {
    const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
    servers.push(server);
    await new Promise<void>(done => server.listen(0, "127.0.0.1", () => done()));
    const address = server.address() as { port: number };

    const result = await listProviderModels(settings(`http://127.0.0.1:${address.port}/v1`, "openai-compatible"), "k");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("/v1");
  });

  it("reports an unreachable service without throwing", async () => {
    // 端口 1 上不会有服务在听。
    const result = await listProviderModels(settings("http://127.0.0.1:1/v1", "openai-compatible"), "k");
    expect(result.ok).toBe(false);
    expect(result.models).toEqual([]);
    expect(result.message).toContain("无法连接");
  });

  it("succeeds with an empty list when the service returns nothing usable", async () => {
    const { baseUrl } = await stubProvider({ models: {} });
    const result = await listProviderModels(settings(baseUrl, "openai-compatible"), "k");
    // 空列表不是错误：有些服务不提供列表接口或没有可用模型。
    expect(result.ok).toBe(true);
    expect(result.models).toEqual([]);
    expect(result.message).toContain("手动填写");
  });
});
