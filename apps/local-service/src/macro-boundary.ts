import type { FastifyInstance, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import { browserMacroResultSchema } from "@mycompanion/shared";
import type { MacroEvaluationSession, NativeCharacterMacroEnvironment } from "./prompt-macros.js";
import { ModelRequestError } from "./model-request-error.js";
import { MacroVariableConflictError } from "./macro-variable-conflict.js";

export interface BrowserMacroCall {
  ordinal: number; content: string;
  context: { characterName?: string; userName?: string; model?: string; contextLimitTokens?: number;
    maxResponseTokens?: number; experimentalMacroEngine?: boolean; replaceCharacterCard?: boolean; original?: string; escapeRegex?: boolean };
  environment: NativeCharacterMacroEnvironment;
  local: Record<string, unknown>; global: Record<string, unknown>;
}
export interface BrowserMacroResult { content: string; local: Record<string, unknown>; global: Record<string, unknown> }
export type BrowserMacroResolver = (call: BrowserMacroCall) => Promise<BrowserMacroResult>;
class MacroBoundaryYield extends Error { constructor(readonly call: BrowserMacroCall) { super("Await browser macro boundary"); } }

/** Observe late rejections too: an extension resolver need not honor the signal. */
function resolveUnlessAborted<T>(result: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener("abort", aborted); reject(signal.reason); };
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(result).then(value => { signal.removeEventListener("abort", aborted); resolve(value); },
      error => { signal.removeEventListener("abort", aborted); reject(error); });
    if (signal.aborted) aborted();
  });
}

/** Suspend a synchronous data phase at each actual call ordinal. Replays use
 * that ordinal's output/draft, never rerun browser code and never deduplicate
 * by macro key or text. A budget stop remains a real traversal stop.
 */
export async function runMacroBoundary<T>(session: MacroEvaluationSession, signal: AbortSignal,
  resolve: BrowserMacroResolver, work: () => T | Promise<T>): Promise<T> {
  const snapshot = session.snapshotDraft(), originalEvaluate = session.evaluate, originalRandom = session.drawRandom;
  const completed: Array<{ call: BrowserMacroCall; result: BrowserMacroResult }> = [];
  const draws: number[] = [];
  let ordinal = 0, drawOrdinal = 0;
  session.drawRandom = (source = Math.random) => {
    signal.throwIfAborted();
    const index = drawOrdinal++;
    return index < draws.length ? draws[index]! : (draws[index] = source());
  };
  session.evaluate = (content, source) => {
    signal.throwIfAborted();
    const call: BrowserMacroCall = { ordinal: ordinal++, content, context: {
      ...(source.characterName === undefined ? {} : { characterName: source.characterName }),
      ...(source.userName === undefined ? {} : { userName: source.userName }),
      ...(source.model === undefined ? {} : { model: source.model }),
      ...(source.contextLimitTokens === undefined ? {} : { contextLimitTokens: source.contextLimitTokens }),
      ...(source.maxResponseTokens === undefined ? {} : { maxResponseTokens: source.maxResponseTokens }),
      ...(source.experimentalMacroEngine === undefined ? {} : { experimentalMacroEngine: source.experimentalMacroEngine }),
      ...(source.replaceCharacterCard === undefined ? {} : { replaceCharacterCard: source.replaceCharacterCard }),
      ...(typeof source.original === "string" ? { original: source.original } : {}),
      ...(source.postProcessFn ? { escapeRegex: true } : {}),
    }, environment: structuredClone(session.getCharacterEnvironment()), local: structuredClone(session.local), global: structuredClone(session.global) };
    const cached = completed[call.ordinal];
    if (!cached) throw new MacroBoundaryYield(call);
    if (JSON.stringify(call) !== JSON.stringify(cached.call)) throw new ModelRequestError("宏求值阶段在等待期间发生变化，请重试。", 409);
    session.replaceVariables(cached.result.local, cached.result.global);
    return cached.result.content;
  };
  try {
    for (;;) {
      signal.throwIfAborted(); session.restoreDraft(snapshot); ordinal = 0; drawOrdinal = 0;
      try { const value = await work(); signal.throwIfAborted(); return value; }
      catch (error) {
        if (!(error instanceof MacroBoundaryYield)) throw error;
        const result = await resolveUnlessAborted(resolve(error.call), signal); signal.throwIfAborted();
        completed.push({ call: error.call, result: structuredClone(result) });
      }
    }
  } catch (error) { session.restoreDraft(snapshot); throw error; }
  finally { session.evaluate = originalEvaluate; session.drawRandom = originalRandom; }
}

type MacroRpc = (signal: AbortSignal, publish: (requestId: string, call: BrowserMacroCall) => void) => BrowserMacroResolver;
const rpcByApp = new WeakMap<FastifyInstance, MacroRpc>();
export function createMacroBoundaryRpc(app: FastifyInstance): MacroRpc {
  const existing = rpcByApp.get(app); if (existing) return existing;
  const pending = new Map<string, { complete(value: BrowserMacroResult): void; fail(error: Error): void }>();
  app.post<{ Params: { id: string }; Body: { result?: unknown; error?: string } }>("/api/generation/macros/:id", { bodyLimit: 16 * 1024 * 1024 }, async (request, reply) => {
    const exchange = pending.get(request.params.id);
    if (!exchange) return reply.code(409).send({ error: { message: "宏求值请求已结束。" } });
    if (typeof request.body?.error === "string") { exchange.fail(new ModelRequestError(request.body.error, 400)); return { accepted: true }; }
    const parsed = browserMacroResultSchema.safeParse(request.body?.result);
    if (!parsed.success) { exchange.fail(new ModelRequestError("浏览器返回了无效的宏求值结果。", 400)); return reply.code(400).send({ error: { message: "浏览器返回了无效的宏求值结果。" } }); }
    exchange.complete(parsed.data); return { accepted: true };
  });
  app.addHook("preClose", async () => { for (const exchange of [...pending.values()]) exchange.fail(new Error("Service closed")); });
  const rpc: MacroRpc = (signal, publish) => async call => {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const clean = () => { pending.delete(id); clearTimeout(timer); signal.removeEventListener("abort", aborted); };
      const fail = (error: Error) => { clean(); reject(error); };
      const aborted = () => fail(signal.reason);
      const timer = setTimeout(() => fail(new ModelRequestError("浏览器宏求值超时。", 504)), 120_000);
      pending.set(id, { complete: value => { clean(); resolve(value); }, fail }); signal.addEventListener("abort", aborted, { once: true });
      try { publish(id, call); } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
  };
  rpcByApp.set(app, rpc); return rpc;
}

export function beginMacroStream(reply: FastifyReply): (event: unknown) => void {
  reply.hijack(); reply.raw.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
  return event => { reply.raw.write(`data: ${JSON.stringify(event)}\n\n`); };
}

export async function completeMacroApi<T>(app: FastifyInstance, reply: FastifyReply,
  target: { conversationId: string | null; branchId: string | null }, session: MacroEvaluationSession,
  enabled: boolean, work: (signal?: AbortSignal) => T | Promise<T>, finish?: (result: T) => T | FastifyReply): Promise<T | FastifyReply> {
  if (!enabled) { const result = await work(); return finish ? finish(result) : result; }
  const send = beginMacroStream(reply), controller = new AbortController();
  const closed = () => { if (!reply.raw.writableFinished) controller.abort(); };
  reply.raw.on("close", closed);
  const resolver = createMacroBoundaryRpc(app)(controller.signal, (requestId, call) => send({ type: "macro_request", requestId,
    ...target, evaluation: call }));
  try {
    const result = await runMacroBoundary(session, controller.signal, resolver, () => work(controller.signal));
    controller.signal.throwIfAborted(); send({ type: "macro_result", result: finish ? finish(result) : result });
  } catch (error) {
    if (!controller.signal.aborted) send({ type: "error", message: error instanceof ModelRequestError || error instanceof MacroVariableConflictError
      ? error.message : "浏览器宏求值失败。" });
  } finally { reply.raw.off("close", closed); reply.raw.end(); }
  return reply;
}
