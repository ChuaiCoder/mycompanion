import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { nativeCompletionRequestSchema, type NativeCompletionRequest } from "@mycompanion/shared";
import { ModelRequestError } from "./model-request-error.js";

// Each exchange belongs to one live generation. The model request is held until
// its browser listeners finish; closing/stopping that stream releases the wait.
export function createGenerationPreflight(app: FastifyInstance) {
  const pending = new Map<string, { complete(value: NativeCompletionRequest): void; fail(error: Error): void }>();
  app.post<{ Params: { id: string }; Body: { request?: unknown; error?: string } }>("/api/generation/preflight/:id", async (request, reply) => {
    const exchange = pending.get(request.params.id);
    if (!exchange) return reply.code(409).send({ error: { message: "生成预处理已结束。" } });
    if (typeof request.body?.error === "string") {
      exchange.fail(new ModelRequestError(request.body.error, 400));
      return { accepted: true };
    }
    const parsed = nativeCompletionRequestSchema.safeParse(request.body?.request);
    if (!parsed.success) {
      exchange.fail(new ModelRequestError("扩展返回了无效的模型请求。", 400));
      return reply.code(400).send({ error: { message: "扩展返回了无效的模型请求。" } });
    }
    exchange.complete(parsed.data);
    return { accepted: true };
  });
  return (signal: AbortSignal, publish: (requestId: string) => void): Promise<NativeCompletionRequest> => {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const clean = () => { pending.delete(id); clearTimeout(timer); signal.removeEventListener("abort", aborted); };
      const fail = (error: Error) => { clean(); reject(error); };
      const aborted = () => fail(signal.reason);
      const timer = setTimeout(() => fail(new ModelRequestError("扩展生成预处理超时。", 504)), 120_000);
      pending.set(id, { complete: value => { clean(); resolve(value); }, fail });
      signal.addEventListener("abort", aborted, { once: true });
      try { publish(id); } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
  };
}
