// Independent implementation of the chat-completion raw-generation contract.
// Full cleanUpMessage/power-user/regex and text-completion backends are separate
// contracts; do not advertise them via empty successful responses.
import { normalizeStructuredOutput } from './structured-output.js';

export const rawGenerationSource = String.raw`
import { eventSource, event_types, getContext, substituteParams } from '/plugin-runtime/compat-runtime.js';
import {sendOpenAIRequest} from '/plugin-runtime/openai-transport.js';
import {getRegexedString,regex_placement} from '/plugin-runtime/regex.js';

${normalizeStructuredOutput.toString()}

export function createRawPrompt(prompt, api = 'openai', instructOverride = false, quietToLoud = false, systemPrompt = '', prefill = '') {
  if (api && api !== 'openai') throw new Error('尚未实现该生成后端：' + api);
  if (typeof prompt === 'string') prompt = [{ role: 'user', content: prompt.trim() }];
  if (!Array.isArray(prompt) || (!prompt.length && !systemPrompt)) throw new Error('No messages provided');
  const messages = prompt.map(message => ({ ...message, content: Array.isArray(message.content)
    ? message.content.map(part => part.type === 'text' ? { ...part, text: substituteParams(part.text) } : structuredClone(part))
    : message.content === null && message.tool_calls ? null : substituteParams(message.content ?? '') }));
  if (systemPrompt) messages.unshift({ role: 'system', content: substituteParams(systemPrompt).trim() });
  if (prefill) messages.push({ role: 'assistant', content: substituteParams(prefill) });
  return messages;
}

export async function generateRawData({ prompt = '', api = null, instructOverride = false, quietToLoud = false, systemPrompt = '', responseLength = null, prefill = '', jsonSchema = null } = {}) {
  const chat = createRawPrompt(prompt, api, instructOverride, quietToLoud, systemPrompt, prefill);
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Cancelled by stop event'));
  eventSource.on(event_types.GENERATION_STOPPED, stop);
  window.addEventListener('pagehide', stop);
  try {
    const event = { chat, dryRun: false };
    await eventSource.emitChecked(event_types.CHAT_COMPLETION_PROMPT_READY, event);
    controller.signal.throwIfAborted();
    const data = await sendOpenAIRequest('quiet',event.chat,controller.signal,{jsonSchema,responseLength});
    if (!jsonSchema) return data;
    const text = data.choices?.[0]?.message?.content ?? '';
    return normalizeStructuredOutput(text, jsonSchema.returnInvalid === true);
  } finally {
    eventSource.removeListener(event_types.GENERATION_STOPPED, stop);
    window.removeEventListener('pagehide', stop);
  }
}

export async function generateRaw(options = {}, ...legacy) {
  if (typeof options !== 'object') {
    const [api, instructOverride, quietToLoud, systemPrompt, responseLength, trimNames, prefill, jsonSchema] = legacy;
    options = { prompt: options, api, instructOverride, quietToLoud, systemPrompt, responseLength, trimNames, prefill, jsonSchema };
  }
  const names = { user: getContext().name1, character: getContext().name2 };
  const data = await generateRawData(options);
  if (options.jsonSchema) return data;
  let text = data.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new Error('No message generated');
  text = text.replace(/[^\S\r\n]+$/gm, '');
  const end = text.indexOf('<|endoftext|>');
  if (end >= 0) text = text.slice(0, end);
  if (options.trimNames !== false) {
    if (names.user && text.startsWith(names.user + ':')) text = '';
    const wrong = names.user ? text.indexOf('\n' + names.user + ':') : -1;
    if (wrong >= 0) text = text.slice(0, wrong);
    if (names.character) text = text.split('\n').map(line => line.startsWith(names.character + ':') ? line.slice(names.character.length + 1).trimStart() : line).join('\n');
  }
  text = text.trim();
  text = getRegexedString(text,regex_placement.AI_OUTPUT);
  if (!text) throw new Error('No message generated');
  return text;
}
`;
