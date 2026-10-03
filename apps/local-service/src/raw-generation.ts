import type { FastifyInstance } from "fastify";
import type { RuntimeRepository } from "./runtime-repository.js";
import { completeRawChat, ModelRequestError } from "./model-client.js";

export interface RawChatRequest {
  messages: Array<{ role: "system" | "user" | "assistant" | "tool" | "developer";
    content: string | Array<Record<string, unknown>> | null; name?: string; tool_calls?: Array<Record<string, unknown>>;
    tool_call_id?: string; signature?: string; reasoning?: string }>;
  responseLength?: number | null;
  jsonSchema?: { name: string; value: Record<string, unknown>; description?: string; strict?: boolean; returnInvalid?: boolean } | null;
}

// Requests are deliberately separate from conversations: no message, memory or
// provider-setting writes are performed for background extension generations.
export function registerRawGeneration(app: FastifyInstance, runtime: RuntimeRepository, unseal?: (value: string) => string): void {
  const active = new Set<AbortController>();
  app.addHook("preClose", async () => { for (const controller of active) controller.abort(); });
  app.post<{ Body: RawChatRequest }>("/api/extensions/generate-raw", {
    schema: { body: { type: "object", required: ["messages"], properties: {
      messages: { type: "array", minItems: 1, items: { type: "object", required: ["role", "content"], properties: {
        role: { enum: ["system", "user", "assistant", "tool", "developer"] },
        content: { anyOf: [{ type: ["string", "null"] }, { type: "array", items: { type: "object", additionalProperties: true } }] },
        name: { type: "string" }, tool_call_id: { type: "string" }, signature: { type: "string" }, reasoning: { type: "string" },
        tool_calls: { type: "array", items: { type: "object", additionalProperties: true } },
      } } },
      responseLength: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
      jsonSchema: { anyOf: [{ type: "null" }, { type: "object", required: ["name", "value"], properties: {
        name: { type: "string", minLength: 1 }, value: { type: "object", additionalProperties: true },
        description: { type: "string" }, strict: { type: "boolean" }, returnInvalid: { type: "boolean" },
      } }] },
    } } },
  }, async (request, reply) => {
    const controller = new AbortController();
    const disconnected = () => { if (!reply.raw.writableFinished) controller.abort(); };
    active.add(controller);
    reply.raw.on("close", disconnected);
    try {
      const encrypted = runtime.getEncryptedApiKey();
      const apiKey = encrypted ? unseal?.(encrypted) : undefined;
      return await completeRawChat({ ...request.body, settings: runtime.getProvider(),
        ...(apiKey ? { apiKey } : {}), signal: controller.signal });
    } catch (error) {
      return reply.status(controller.signal.aborted ? 499 : error instanceof ModelRequestError ? error.statusCode : 502).send({
        error: { code: "RAW_GENERATION_FAILED", message: error instanceof ModelRequestError ? error.message : "模型生成失败。" },
      });
    } finally {
      active.delete(controller);
      reply.raw.off("close", disconnected);
    }
  });
}
