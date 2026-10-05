/** Preserve text through regex/macro/PromptManager phases. Only budget and
 * transport copies materialize the picture as canonical multimodal content. */
export function materializePromptImage<T extends {content:string;image?:string;imageDetail?:string}>(message:T) {
  const {image,imageDetail,...canonical}=message;
  return !image?canonical:{...canonical,content:[{type:"text",text:message.content},
    {type:"image_url",image_url:{url:image,detail:imageDetail??"auto"}}]};
}

/** Same capability rule as the existing browser OpenAI settings bridge. Use
 * the selected request snapshot; custom-compatible models declare their own
 * capabilities, while known native families follow the configured media flag. */
export function isModelImageInliningSupported(source: unknown, model: unknown, mediaInlining: unknown = true): boolean {
  if (!mediaInlining) return false;
  if (source === "custom") return true;
  if (["gpt-4-turbo-preview", "o1-mini", "o3-mini"].some(name => String(model ?? "").includes(name))) return false;
  return /^(gpt-4o|gpt-4\.1|gpt-4\.5|gpt-4-turbo|gpt-4-vision|gpt-5|gpt-6|chatgpt-4o|o1|o3|o4-mini|claude-3|claude-(?:opus|sonnet|haiku)-[45]|gemini-|gemma-[34]|pixtral|mistral-(?:small|medium|large)|grok-)/i.test(String(model ?? ""));
}
