// The browser-facing Tavern Generate entry delegates ordinary foreground turns
// to the application's existing React/SSE workflow. Unsupported modes reject
// explicitly instead of returning an empty successful result.
export const generateRuntimeSource = String.raw`
import { getContext } from '/plugin-runtime/compat-runtime.js';
import { generateQuietPrompt } from '/plugin-runtime/quiet-generation.js';

export async function Generate(type, options = {}, dryRun = false) {
  if (type === 'quiet') return generateQuietPrompt({
    quietPrompt: options.quiet_prompt ?? '', quietToLoud: options.quietToLoud ?? false,
    skipWIAN: options.skipWIAN ?? false, quietImage: options.quietImage ?? null,
    quietName: options.quietName ?? null, forceChId: options.force_chid ?? null,
    jsonSchema: options.jsonSchema ?? null, dryRun, signal: options.signal,
  });
  const foreground = getContext().nativeGenerate;
  if (!foreground) throw new Error('原生对话界面尚未连接。');
  if (options.quiet_prompt || options.quietImage || options.force_chid != null || options.depth) {
    throw new Error('当前前台生成尚不支持附加 quiet 提示词、图片、群组强制角色或深度续写。');
  }
  if (type === 'normal') {
    const input = document.getElementById('send_textarea')?.value?.trim() || '';
    return foreground.send(input, {allowEmpty:true, dryRun, signal:options.signal});
  }
  if (type === 'regenerate' || type === 'swipe') return foreground.regenerate({dryRun, signal:options.signal});
  throw new Error('尚未实现该生成模式：' + String(type));
}
`;
