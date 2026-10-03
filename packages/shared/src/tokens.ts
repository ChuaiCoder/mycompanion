import { z } from "zod";

const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** A local admission estimate; even a known BPE table does not fix server framing. */
export const tokenAccountingSchema = z.object({
  method: z.literal("tavern-compatibility"),
  model: z.string(), encoding: z.string(),
  estimated: z.literal(true), textEstimated: z.boolean(), framingEstimated: z.literal(true),
  mediaEstimated: z.boolean(), complete: z.boolean(),
  promptTokens: tokenCount, mediaTokens: tokenCount,
  reasons: z.array(z.enum(["message-framing", "unknown-model", "unsupported-text-encoding", "image-rule-estimate",
    "unknown-image-size", "unknown-image-model", "audio-not-counted", "unsupported-content-part", "tool-schema-estimate", "response-format-estimate"])).max(12),
});
/** Only allowlisted finite numeric fields from an actual provider response. */
export const providerTokenUsageSchema = z.object({
  source: z.literal("provider-reported"),
  protocol: z.enum(["openai", "claude", "gemini", "ollama"]).optional(),
  inputTokens: tokenCount.optional(), outputTokens: tokenCount.optional(), totalTokens: tokenCount.optional(),
  cachedInputTokens: tokenCount.optional(), reasoningTokens: tokenCount.optional(),
  nonCachedInputTokens: tokenCount.optional(), cacheCreationInputTokens: tokenCount.optional(),
  candidatesOutputTokens: tokenCount.optional(), toolInputTokens: tokenCount.optional(),
});
export type TokenAccounting = z.infer<typeof tokenAccountingSchema>;
export type ProviderTokenUsage = z.infer<typeof providerTokenUsageSchema>;
