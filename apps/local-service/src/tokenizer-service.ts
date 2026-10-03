import type { FastifyInstance } from "fastify";
import { modelToEncodingMap } from "gpt-tokenizer/mapping";
import * as modelCatalog from "gpt-tokenizer/models";
import * as cl100k from "gpt-tokenizer/encoding/cl100k_base";
import * as o200k from "gpt-tokenizer/encoding/o200k_base";
import { contentTokenCost } from "./content-token-cost.js";
import type { RuntimeRepository } from "./runtime-repository.js";

export function tokenizerDescriptor(model: string) {
  // The package's model map lists encoding exceptions; catalog models absent
  // from that map use o200k_base (the same default as GptEncoding).
  const mapped = Object.hasOwn(modelToEncodingMap, model) ? modelToEncodingMap[model as keyof typeof modelToEncodingMap]
    : Object.hasOwn(modelCatalog, model) ? "o200k_base" : undefined;
  // Harmony uses the same ordinary-text ranks as o200k; its special framing
  // stays an estimate in the compatibility message-count contract.
  const encoding = mapped === "o200k_base" || mapped === "o200k_harmony" ? "o200k_base" : "cl100k_base";
  return { encoding, estimated: mapped !== encoding && mapped !== "o200k_harmony", knownModel: mapped !== undefined } as const;
}

/** Same BPE table as the extension token-count endpoint, usable by sync budgets. */
export function countTextTokens(text: string, model = ""): number {
  if (!text) return 0;
  const tokenizer = tokenizerDescriptor(model).encoding === "o200k_base" ? o200k : cl100k;
  return tokenizer.countTokens(text, { disallowedSpecial: new Set() });
}

export async function tokenizerFor(model: string) {
  const { encoding, estimated } = tokenizerDescriptor(model);
  const tokenizer = encoding === "o200k_base" ? await import("gpt-tokenizer/encoding/o200k_base") : await import("gpt-tokenizer/encoding/cl100k_base");
  return { encoding, estimated,
    count: (text: string) => tokenizer.countTokens(text, { disallowedSpecial: new Set() }) };
}

function countMessages(messages: Array<Record<string, unknown>>, model: string, full: boolean, count: (text: string) => number) {
  const legacy = model === "gpt-3.5-turbo-0301";
  let tokens = 0;
  // Tavern's browser counts each message separately (each with the endpoint's
  // reply padding), then subtracts two for non-full calls. Keep that contract.
  for (const message of messages) {
    tokens += (legacy ? 4 : 3) + 3 + (legacy ? 9 : 0);
    for (const [key, value] of Object.entries(message)) {
      if (typeof value === "string") tokens += count(value);
      else if (key === "content" && Array.isArray(value)) {
        tokens += contentTokenCost(value, model, count).tokens;
      } else if (value != null) tokens += count(JSON.stringify(value));
      if (key === "name" && value != null) tokens += legacy ? -1 : 1;
    }
  }
  return tokens - (full ? 0 : 2);
}

/** Request assembly uses the same framing calculation as the extension API. */
export function countCompatibilityMessagesSync(messages: Array<Record<string, unknown>>, model: string, full = false): number {
  return countMessages(messages, model, full, text => countTextTokens(text, model));
}

export async function countCompatibilityMessages(messages: Array<Record<string, unknown>>, model: string, full = false) {
  const tokenizer = await tokenizerFor(model);
  return { token_count: countMessages(messages, model, full, tokenizer.count), model, encoding: tokenizer.encoding,
    estimated: true, textEstimated: tokenizer.estimated, framingEstimated: true };
}

export function registerTokenizerRoutes(app: FastifyInstance, runtime: RuntimeRepository): void {
  app.post<{ Body: { text?: string; messages?: Array<Record<string, unknown>>; full?: boolean; model?: string } }>("/api/extensions/token-count", {
    schema: { body: { type: "object", properties: { text: { type: "string" },
      messages: { type: "array", items: { type: "object", additionalProperties: true } }, full: { type: "boolean" }, model: { type: "string" },
    }, oneOf: [{ required: ["text"] }, { required: ["messages"] }] } },
  }, async request => {
    const { text, messages, full } = request.body;
    const model = request.body.model ?? runtime.getProvider().model;
    if (messages) return countCompatibilityMessages(messages, model, full);
    const tokenizer = await tokenizerFor(model);
    return { token_count: tokenizer.count(text!), model, encoding: tokenizer.encoding, estimated: tokenizer.estimated };
  });
}
