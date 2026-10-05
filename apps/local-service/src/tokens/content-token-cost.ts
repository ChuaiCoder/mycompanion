import type { TokenAccounting } from "@mycompanion/shared";
import { imageTokenCost } from "./image-token-cost.js";

type Reason = TokenAccounting["reasons"][number];
interface ContentCost { tokens: number; mediaTokens: number; mediaEstimated: boolean; complete: boolean; reasons: Reason[] }
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Counts canonical and native content without treating base64 media as text.
 * Native text still uses the declared approximate text table. Unknown content
 * stays explicitly incomplete; this is not a provider billing tokenizer. */
export function contentTokenCost(raw: unknown, model: string, count: (text: string) => number, depth = 0): ContentCost {
  const result: ContentCost = {tokens: 0, mediaTokens: 0, mediaEstimated: false, complete: true, reasons: []};
  const addText = (value: unknown) => {if (typeof value === "string") result.tokens += count(value);};
  const json = (value: unknown) => {if (value !== undefined) result.tokens += count(JSON.stringify(value));};
  const incomplete = (reason: Reason) => {result.complete = false; result.reasons.push(reason);};
  const merge = (cost: ContentCost) => {
    result.tokens += cost.tokens; result.mediaTokens += cost.mediaTokens;
    result.mediaEstimated ||= cost.mediaEstimated; result.complete &&= cost.complete; result.reasons.push(...cost.reasons);
  };
  const image = (part: Record<string, unknown>) => {
    const cost = imageTokenCost(part, model); result.tokens += cost.tokens; result.mediaTokens += cost.tokens;
    result.mediaEstimated = true; result.complete &&= cost.complete; result.reasons.push(cost.reason);
  };
  if (typeof raw === "string") {addText(raw); return result;}
  if (depth >= 64) {incomplete("unsupported-content-part"); return result;}
  if (Array.isArray(raw)) {for (const part of raw) merge(contentTokenCost(part, model, count, depth + 1)); return result;}
  const part = record(raw);
  if (part.type === "provider_native") return contentTokenCost(part.part, model, count, depth + 1);
  if (part.type === "text" || (part.type === undefined && typeof part.text === "string")) {addText(part.text); return result;}
  if (part.type === "image_url") {image(part); return result;}
  if (part.type === "image") {
    const source = record(part.source);
    image({image_url: {url: source.type === "base64" ? `data:${source.media_type};base64,${source.data}` : source.url}}); return result;
  }
  if (part.type === "thinking") {addText(part.thinking); addText(part.signature); return result;}
  if (part.type === "tool_use") {addText(part.id); addText(part.name); json(part.input); return result;}
  if (part.type === "tool_result") {addText(part.tool_use_id); merge(contentTokenCost(part.content, model, count, depth + 1)); return result;}
  if (part.functionCall) {const call = record(part.functionCall); addText(call.id); addText(call.name); json(call.args); return result;}
  if (part.functionResponse) {const response = record(part.functionResponse); addText(response.id); addText(response.name); json(response.response); return result;}
  const data = record(part.inlineData ?? part.inline_data), mime = data.mimeType ?? data.mime_type;
  if (typeof data.data === "string" && typeof mime === "string") {
    if (mime.startsWith("image/")) image({image_url: {url: `data:${mime};base64,${data.data}`}});
    else {result.mediaEstimated = true; incomplete(mime.startsWith("audio/") ? "audio-not-counted" : "unsupported-content-part");}
    return result;
  }
  result.mediaEstimated = true;
  incomplete(["input_audio", "audio_url"].includes(String(part.type)) ? "audio-not-counted" : "unsupported-content-part");
  return result;
}
