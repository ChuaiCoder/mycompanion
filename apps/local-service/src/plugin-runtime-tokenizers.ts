export const tokenizersSource = String.raw`
import {refreshOpenAISettings,getChatCompletionModel} from '/plugin-runtime/openai-settings.js';
async function count(body) {
  await refreshOpenAISettings();body.model=getChatCompletionModel();
  const response = await fetch('/api/extensions/token-count', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || data.message || 'Token count failed');
  return data.token_count;
}
export async function countTokensOpenAIAsync(messages, full = false) {
  return count({ messages: Array.isArray(messages) ? messages : [messages], full });
}
export async function getTokenCountAsync(text, padding) {
  if (typeof text !== 'string' || !text.length) return 0;
  // In Tavern's chat-completion path, the wrapper counts a content-only
  // message with reply framing and ignores the text-backend padding argument.
  return countTokensOpenAIAsync({ content: text }, true);
}
`;
