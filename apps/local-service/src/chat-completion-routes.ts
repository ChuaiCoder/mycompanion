import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { FastifyInstance } from "fastify";
import { MAX_CONTEXT_TOKENS } from "@mycompanion/shared";
import { measureChatCompletionRequest, assertChatCompletionBudget } from "./chat-completion-budget.js";
import { normalizeChatCompletionRequest } from "./chat-completion-request.js";
import { ModelRequestError, requestChatCompletion } from "./model-client.js";
import type { RuntimeRepository } from "./runtime-repository.js";
import { providerHttpError, providerPayloadError } from "./provider-errors.js";
import { ProviderErrorStream } from "./provider-error-stream.js";
import { requestProviderCompletion } from "./provider-transport.js";
import { tavernProviderReply } from "./provider-response.js";

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
      const transport = normalizeChatCompletionRequest(input, settings, encrypted ? unseal?.(encrypted) : undefined);
      const { body } = transport;
      const budget = measureChatCompletionRequest(body, settings, input._mycompanion_context_limit as number | undefined);
      assertChatCompletionBudget(budget);
      signal.throwIfAborted();
      const response = await requestProviderCompletion(transport, signal);
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw providerHttpError(response.status); }
      const isSse = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") ?? false;
      if (!isSse) {
        const text = await response.text();
        let data: unknown;
        try { data = JSON.parse(text); } catch { throw new ModelRequestError("模型返回了不兼容的响应格式。", 502); }
        const providerError = providerPayloadError(data);
        if (providerError) throw providerError;
        return reply.status(response.status).header("Cache-Control", "no-store").type("application/json").send(transport.protocol === "openai" ? text : JSON.stringify(tavernProviderReply(transport.protocol,data,body)));
      }
      if (!response.body) throw new ModelRequestError("模型返回了空响应。", 502);
      reply.hijack();
      reply.raw.writeHead(response.status, { "Content-Type": response.headers.get("content-type") || (body.stream ? "text/event-stream" : "application/json"), "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
      await pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), new ProviderErrorStream(), reply.raw, { signal });
      return reply;
    } catch (error) {
      if (reply.raw.headersSent || reply.raw.destroyed) { reply.raw.destroy(); return reply; }
      return reply.status(controller.signal.aborted ? 499 : timeout.aborted ? 504 : error instanceof ModelRequestError ? error.statusCode : 502).send({ error: { message: error instanceof ModelRequestError ? error.message : "无法连接或读取模型服务。" } });
    } finally { active.delete(controller); reply.raw.off("close", disconnected); }
  });
}
