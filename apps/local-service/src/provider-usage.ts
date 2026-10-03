import type { ProviderTokenUsage } from "@mycompanion/shared";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const sum = (...values: number[]): number | undefined => count(values.reduce((total, value) => total + value, 0));
type UsageProtocol = NonNullable<ProviderTokenUsage["protocol"]>;

/** Covers OpenAI JSON/SSE, Claude start/delta, Gemini metadata and Ollama totals.
 * Stream counters are cumulative snapshots; never sum repeated frames. */
export function readProviderTokenUsage(payload: unknown, previous?: ProviderTokenUsage, protocol?: UsageProtocol): ProviderTokenUsage | undefined {
  const data = object(payload);
  const usage = object(data.usage ?? object(data.message).usage ?? data.usageMetadata);
  const promptDetails = object(usage.prompt_tokens_details ?? usage.input_tokens_details);
  const outputDetails = object(usage.completion_tokens_details ?? usage.output_tokens_details);
  const detectedProtocol = protocol ?? previous?.protocol ?? (data.usageMetadata ? "gemini"
    : data.type === "message_start" || data.type === "message_delta" || "cache_read_input_tokens" in usage || "cache_creation_input_tokens" in usage ? "claude"
    : "prompt_eval_count" in data || "eval_count" in data ? "ollama" : undefined);
  const values = {
    inputTokens: count(usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount ?? data.prompt_eval_count),
    outputTokens: count(usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount ?? data.eval_count),
    totalTokens: count(usage.total_tokens ?? usage.totalTokenCount),
    cachedInputTokens: count(promptDetails.cached_tokens ?? usage.cache_read_input_tokens ?? usage.cachedContentTokenCount ?? data.prompt_eval_cached_count),
    reasoningTokens: count(outputDetails.reasoning_tokens ?? usage.thoughtsTokenCount),
    ...(detectedProtocol === "claude" ? {
      nonCachedInputTokens: count(usage.input_tokens), cacheCreationInputTokens: count(usage.cache_creation_input_tokens),
    } : {}),
    ...(detectedProtocol === "gemini" ? {
      candidatesOutputTokens: count(usage.candidatesTokenCount), toolInputTokens: count(usage.toolUsePromptTokenCount),
    } : {}),
  };
  const valid = Object.entries(values).filter(([,value]) => value !== undefined);
  if (!valid.length) return previous;
  const result = { ...(previous ?? {}), source: "provider-reported", ...Object.fromEntries(valid),
    ...(detectedProtocol ? {protocol: detectedProtocol} : {}) } as ProviderTokenUsage;
  // Claude reports disjoint non-cached/read/create input counters. Keep their
  // cumulative components so a later cache-only delta cannot double-add input.
  if (detectedProtocol === "claude" && result.nonCachedInputTokens !== undefined) {
    const input = sum(result.nonCachedInputTokens, result.cachedInputTokens ?? 0, result.cacheCreationInputTokens ?? 0);
    if (input === undefined) delete result.inputTokens; else result.inputTokens = input;
  }
  // Gemini's candidate output excludes thoughts; the reported total also
  // includes server tool-result input, which remains a separate breakdown.
  if (detectedProtocol === "gemini" && result.candidatesOutputTokens !== undefined) {
    const output = sum(result.candidatesOutputTokens, result.reasoningTokens ?? 0);
    if (output === undefined) delete result.outputTokens; else result.outputTokens = output;
  }
  return result;
}

/** The provider count is for input only; response reserve is never compared. */
export function providerInputDifference(promptTokens: number, usage: ProviderTokenUsage): number | undefined {
  return usage.inputTokens === undefined ? undefined : usage.inputTokens - promptTokens;
}

/** Separate multi-request diagnostics. A missing request or missing category
 * cannot be presented as zero, and these totals never compare to one prompt. */
export function sumProviderTokenUsages(usages: Array<ProviderTokenUsage | undefined>): ProviderTokenUsage | undefined {
  if (!usages.length || usages.some(usage => !usage)) return undefined;
  const records = usages as ProviderTokenUsage[];
  const fields = ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "reasoningTokens",
    "nonCachedInputTokens", "cacheCreationInputTokens", "candidatesOutputTokens", "toolInputTokens"] as const;
  const totals: Partial<ProviderTokenUsage> = {};
  for (const field of fields) {
    if (!records.every(usage => count(usage[field]) !== undefined)) continue;
    const total = sum(...records.map(usage => usage[field]!));
    if (total !== undefined) totals[field] = total;
  }
  if (!Object.keys(totals).length) return undefined;
  const protocol = records[0]!.protocol;
  return {source: "provider-reported", ...totals, ...(protocol && records.every(usage => usage.protocol === protocol) ? {protocol} : {})};
}
