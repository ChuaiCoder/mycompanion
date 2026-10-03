import { createHash } from "node:crypto";
import { VectraMetric } from "./vector-metric-upstream.js";

/** ST batch request shapes; source/adaptations in ../vector-upstream.json. */
export interface EmbeddingProvider { kind: string; baseUrl: string; model: string }
export const MAX_VECTOR_DIMENSIONS = 16_384;
export const EMBEDDING_BATCH_SIZE = 32;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export class EmbeddingRequestError extends Error {
  constructor(readonly code: "UNSUPPORTED_PROVIDER" | "INVALID_ADDRESS" | "HTTP_ERROR" | "INVALID_RESPONSE" | "UNAVAILABLE", readonly status?: number) {
    super(`Embedding ${code}${status ? ` (${status})` : ""}`);
    this.name = "EmbeddingRequestError";
  }
}
export function validVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_VECTOR_DIMENSIONS
    && value.every(item => typeof item === "number" && Number.isFinite(item))
    && Number.isFinite(VectraMetric.normalize(value)) && VectraMetric.normalize(value) > 0;
}
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || !validVector(a) || !validVector(b)) throw new EmbeddingRequestError("INVALID_RESPONSE");
  return Math.max(-1, Math.min(1, VectraMetric.normalizedCosineSimilarity(a,VectraMetric.normalize(a),b,VectraMetric.normalize(b))));
}
export function embeddingEndpoint(settings: EmbeddingProvider): string {
  let url: URL;
  try { url = new URL(settings.baseUrl); }
  catch { throw new EmbeddingRequestError("INVALID_ADDRESS"); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new EmbeddingRequestError("INVALID_ADDRESS");
  const base = settings.baseUrl.replace(/\/$/, "");
  if (settings.kind === "ollama") return base.replace(/\/(?:v1|api)$/, "") + "/api/embed";
  if (settings.kind === "openai" || settings.kind === "openai-compatible" || settings.kind === "custom") return base + "/embeddings";
  throw new EmbeddingRequestError("UNSUPPORTED_PROVIDER");
}
export function embeddingSignature(settings: EmbeddingProvider, profileId = ""): string {
  return createHash("sha256").update(JSON.stringify([profileId,settings.kind,embeddingEndpoint(settings),settings.model])).digest("hex");
}
export function vectorContentFingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
async function readResponse(response: Response): Promise<unknown> {
  if (!response.ok) { await response.body?.cancel(); throw new EmbeddingRequestError("HTTP_ERROR",response.status); }
  if (!response.body) throw new EmbeddingRequestError("INVALID_RESPONSE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new EmbeddingRequestError("INVALID_RESPONSE"); }
      chunks.push(next.value);
    }
    try { return JSON.parse(Buffer.concat(chunks,length).toString("utf8")); }
    catch { throw new EmbeddingRequestError("INVALID_RESPONSE"); }
  } finally { reader.releaseLock(); }
}
export async function embedTexts(settings: EmbeddingProvider, texts: string[], options: { apiKey?: string | undefined; signal?: AbortSignal | undefined; fetch?: typeof fetch } = {}): Promise<number[][]> {
  options.signal?.throwIfAborted();
  if (!settings.model || !texts.length || texts.length > EMBEDDING_BATCH_SIZE || texts.some(text=>typeof text!=="string" || text.length > 64_000))
    throw new EmbeddingRequestError("INVALID_RESPONSE");
  const endpoint = embeddingEndpoint(settings);
  const signal = AbortSignal.any([AbortSignal.timeout(20_000),...(options.signal ? [options.signal] : [])]);
  let data: unknown;
  try {
    const response = await (options.fetch ?? fetch)(endpoint, { method:"POST",redirect:"error",signal,
      headers:{ "Content-Type":"application/json", ...(options.apiKey ? {Authorization:`Bearer ${options.apiKey}`} : {}) },
      body:JSON.stringify({model:settings.model,input:texts,...(settings.kind === "ollama" ? {truncate:false} : {})}) });
    data = await readResponse(response);
    signal.throwIfAborted();
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof EmbeddingRequestError) throw error;
    throw new EmbeddingRequestError("UNAVAILABLE");
  }
  const result = data as {data?: Array<{index:unknown;embedding:unknown}>;embeddings?: unknown[]};
  let vectors: unknown[];
  if (settings.kind === "ollama") vectors = result?.embeddings ?? [];
  else {
    if (!Array.isArray(result?.data) || result.data.length !== texts.length) throw new EmbeddingRequestError("INVALID_RESPONSE");
    const indices = new Set<number>();
    for (const row of result.data) {
      if (!row || !Number.isInteger(row.index) || Number(row.index) < 0 || Number(row.index) >= texts.length || indices.has(Number(row.index)))
        throw new EmbeddingRequestError("INVALID_RESPONSE");
      indices.add(Number(row.index));
    }
    vectors = [...result.data].sort((a,b)=>Number(a.index)-Number(b.index)).map(row=>row.embedding);
  }
  if (!Array.isArray(vectors) || vectors.length!==texts.length || !vectors.every(validVector)
    || vectors.some(vector=>vector.length !== (vectors[0] as number[]).length)) throw new EmbeddingRequestError("INVALID_RESPONSE");
  return vectors;
}
