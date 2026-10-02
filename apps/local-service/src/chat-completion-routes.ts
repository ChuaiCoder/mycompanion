import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { FastifyInstance } from "fastify";
import { MAX_CONTEXT_TOKENS } from "@mycompanion/shared";
import { measureChatCompletionRequest, assertChatCompletionBudget } from "./chat-completion-budget.js";
import { normalizeChatCompletionRequest } from "./chat-completion-request.js";
import { ModelRequestError, requestChatCompletion } from "./model-client.js";
import type { RuntimeRepository } from "./runtime-repository.js";

// Own provider transport for the endpoint used directly by original extensions.
// Relaying provider bytes preserves tool/reasoning events and multi-choice data.
export function registerChatCompletionRoutes(app: FastifyInstance, runtime: RuntimeRepository, unseal?: (value: string) => string): void {
  const active = new Set<AbortController>();
  app.addHook("preClose", async () => { for (const controller of active) controller.abort(); });
  app.post<{ Body: Record<string, unknown> }>("/api/backends/chat-completions/generate", {
    schema: { body: { type: "object", required: ["messages"], properties: {
      messages: { type: "array", minItems: 1, items: { type: "object", additionalProperties: true } },
      stream: { type: "boolean" }, model: { type: "string" }, chat_completion_source: { type: "string" },
      reverse_proxy: { type: "string" }, proxy_password: { type: "string" }, custom_url: { type: "string" },
      _mycompanion_context_limit: { type: "integer", minimum: 1, maximum: MAX_CONTEXT_TOKENS },
    }, additionalProperties: true } },
  }, async (request, reply) => {
    const controller = new AbortController(), timeout = AbortSignal.timeout(120_000);
    const signal = AbortSignal.any([controller.signal, timeout]);
    const disconnected = () => { if (!reply.raw.writableFinished) controller.abort(); };
    active.add(controller); reply.raw.on("close", disconnected);
    try {
      const input = request.body, settings = runtime.getProvider();
      const encrypted = runtime.getEncryptedApiKey();
      const { baseUrl, apiKey, body, extraHeaders } = normalizeChatCompletionRequest(input, settings, encrypted ? unseal?.(encrypted) : undefined);
      const budget = measureChatCompletionRequest(body, settings, input._mycompanion_context_limit as number | undefined);
      assertChatCompletionBudget(budget);
      signal.throwIfAborted();
      const response = await requestChatCompletion(baseUrl, body, signal, apiKey, extraHeaders);
      if (!response.body) throw new ModelRequestError("模型返回了空响应。", 502);
      reply.hijack();
      reply.raw.writeHead(response.status, { "Content-Type": response.headers.get("content-type") || (body.stream ? "text/event-stream" : "application/json"), "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
      await pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), reply.raw, { signal });
      return reply;
    } catch (error) {
      if (reply.raw.headersSent || reply.raw.destroyed) { reply.raw.destroy(error instanceof Error ? error : undefined); return reply; }
      return reply.status(controller.signal.aborted ? 499 : timeout.aborted ? 504 : error instanceof ModelRequestError ? error.statusCode : 502).send({ error: { message: error instanceof Error ? error.message : "模型请求失败。" } });
    } finally { active.delete(controller); reply.raw.off("close", disconnected); }
  });
}
