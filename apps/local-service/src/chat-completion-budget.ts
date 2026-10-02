import { nativeCompletionRequestSchema, type ProviderSettings } from "@mycompanion/shared";
import { CONTEXT_RESERVE_TOKENS } from "./prompt-budget.js";
import { countCompatibilityMessagesSync, countTextTokens } from "./tokenizer-service.js";
import { ModelRequestError } from "./model-request-error.js";

/** Measure the normalized outgoing payload, after extension/custom-body edits. */
export function measureChatCompletionRequest(body: Record<string, unknown>, settings: ProviderSettings,
  contextLimitTokens = settings.contextLimitTokens) {
  const parsed = nativeCompletionRequestSchema.safeParse({ model: settings.model, stream: false, ...body });
  if (!parsed.success) throw new ModelRequestError("扩展返回了无效的模型请求。", 400);
  const request = parsed.data;
  const responseTokens = Math.max(request.max_completion_tokens ?? 0, request.max_tokens ?? 0) || settings.maxTokens;
  const reserveTokens = responseTokens + CONTEXT_RESERVE_TOKENS;
  let promptTokens = countCompatibilityMessagesSync(request.messages, request.model, true);
  for (const field of ["tools", "response_format"] as const) {
    if (request[field]) promptTokens += countTextTokens(JSON.stringify(request[field]), request.model);
  }
  return { request, contextLimitTokens, reserveTokens,
    availableTokens: Math.max(0, contextLimitTokens - reserveTokens), totalTokens: promptTokens + reserveTokens };
}

export function assertChatCompletionBudget(budget: { totalTokens: number; contextLimitTokens: number }): void {
  if (budget.totalTokens > budget.contextLimitTokens)
    throw new ModelRequestError("最终提示词与回复预留超出上下文上限，请缩短提示词或调整预算。", 400);
}
