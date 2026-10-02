export interface ReasoningExtractionOptions {
  mainApi?: string | null;
  textGenType?: string | null;
  chatCompletionSource?: string | null;
  ignoreShowThoughts?: boolean;
  showThoughts?: boolean;
}

// Independent response-data adapter. Kept self-contained so the service can
// expose the same implementation to extensions without provider credentials.
export function extractReasoningFromData(data: unknown, options: ReasoningExtractionOptions = {}): string {
  const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
  const text = (value: unknown): string => typeof value === "string" ? value : "";
  const response = record(data);
  const choice = record(list(response.choices)[0]);
  const message = record(choice.message);
  const api = options.mainApi ?? "openai";
  if (api === "textgenerationwebui") {
    if (options.textGenType === "ollama") return text(response.thinking);
    if (options.textGenType === "openrouter") return text(choice.reasoning);
    return "";
  }
  if (api !== "openai" || (options.showThoughts === false && !options.ignoreShowThoughts)) return "";
  const source = options.chatCompletionSource ?? "custom";
  if (source === "claude") {
    return list(response.content).map(record).filter(part => part.type === "thinking").map(part => text(part.thinking)).join("\n\n");
  }
  if (source === "makersuite" || source === "vertexai") {
    return list(record(response.responseContent).parts).map(record).filter(part => part.thought === true).map(part => text(part.text)).join("\n\n");
  }
  if (source === "mistralai") {
    return list(record(list(message.content)[0]).thinking).map(record).map(part => text(part.text)).filter(Boolean).join("\n\n");
  }
  if (source === "deepseek" || source === "xai") return text(message.reasoning_content);
  if (source === "openrouter") return text(message.reasoning ?? message.reasoning_content);
  const compatible = ["aimlapi", "pollinations", "moonshot", "cometapi", "chutes", "electronhub", "nanogpt", "siliconflow", "zai", "workers_ai", "fireworks", "custom"];
  return compatible.includes(source) ? text(message.reasoning_content ?? message.reasoning) : "";
}
