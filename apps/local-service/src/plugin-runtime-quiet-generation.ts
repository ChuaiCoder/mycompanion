// Runs a quiet turn against the real selected story without adding chat rows.
// Uses the same renderer SSE/preflight exchange as foreground generation.
// Image and group overrides remain unsupported by the service.
export const quietGenerationSource = String.raw`
import { eventSource, event_types, getContext } from '/plugin-runtime/compat-runtime.js';

function trimToSentence(text) {
  const characters = Array.from(text);
  const punctuation = new Set(['.', '!', '?', '。', '！', '？', '”', '）', '】', '’', '」']);
  for (let i = characters.length - 1; i >= 0; i--) {
    if (punctuation.has(characters[i])) return characters.slice(0, i + 1).join('').trimEnd();
  }
  return text.trimEnd();
}

export async function generateQuietPrompt(options = {}, ...legacy) {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    const [quietToLoud, skipWIAN, quietImage, quietName, responseLength, forceChId, jsonSchema] = legacy;
    options = { quietPrompt: options, quietToLoud, skipWIAN, quietImage, quietName, responseLength, forceChId, jsonSchema };
  }
  const conversationId = getContext().conversationId;
  if (!conversationId) throw new Error('请先打开一个故事，再运行后台生成。');
  const controller = new AbortController();
  const stop = () => controller.abort();
  const abort = () => controller.abort(options.signal.reason);
  if (options.signal?.aborted) abort(); else options.signal?.addEventListener("abort", abort, {once:true});
  eventSource.on(event_types.GENERATION_STOPPED, stop);
  window.addEventListener('pagehide', stop, { once: true });
  try {
    const bridge = getContext().nativeGenerate;
    if (!bridge?.quiet) throw new Error('原生后台生成尚未连接。');
    let text = await bridge.quiet({
      quietPrompt: String(options.quietPrompt ?? ''), quietToLoud: Boolean(options.quietToLoud), skipWIAN: Boolean(options.skipWIAN),
      quietImage: options.quietImage ?? null, quietName: options.quietName ?? null,
      responseLength: options.responseLength ?? null, forceChId: options.forceChId ?? null,
      jsonSchema: options.jsonSchema ?? null, dryRun: Boolean(options.dryRun), signal: controller.signal,
    });
    if (text === undefined) return undefined;
    if (options.removeReasoning !== false) text = text.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, '');
    if (options.trimToSentence) text = trimToSentence(text);
    return text;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    eventSource.removeListener(event_types.GENERATION_STOPPED, stop);
    window.removeEventListener('pagehide', stop);
    // Like Tavern's Generate finalizer, notify without making completion depend
    // on extension listeners. A pending listener must not swallow cancellation.
    void eventSource.emit(event_types.GENERATION_ENDED, getContext().chat.length).catch(error => console.error(error));
  }
}
`;
