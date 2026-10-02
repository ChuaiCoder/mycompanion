// Chat history and example conversion used by the browser compatibility API.
// Keep the input contract separate from prompt assembly: extensions may inspect
// or override these arrays before the final budgeted request is constructed.
export const openAIConversionSource = String.raw`
import { getContext } from '/plugin-runtime/compat-runtime.js';
import { oai_settings, getChatCompletionModel } from '/plugin-runtime/openai-settings.js';
import { power_user } from '/scripts/power-user.js';
import {parseCompletionExample} from '/plugin-runtime/prompt-manager-core.js';

const ignored = Symbol.for('ignore');
const narrator = 'narrator';
const names = () => {
  const context = getContext();
  return { user: context.name1 || 'User', character: context.name2 || 'Assistant', group: Boolean(context.groupId) };
};

export function setOpenAIMessages(chat) {
  if (!Array.isArray(chat)) throw new TypeError('Chat history must be an array');
  const { user, character, group } = names();
  const api = oai_settings.chat_completion_source;
  const model = getChatCompletionModel();
  const messages = [];
  for (const item of chat) {
    if (!item || item.extra?.[ignored]) continue;
    const isNarrator = item.extra?.type === narrator;
    const role = isNarrator ? 'system' : item.is_user ? 'user' : 'assistant';
    const name = typeof item.name === 'string' && item.name ? item.name : (item.is_user ? user : character);
    let content = typeof item.mes === 'string' ? item.mes : '';
    const behavior = Number(oai_settings.names_behavior);
    if (behavior === 2 && !isNarrator) content = name + ': ' + content;
    else if (behavior === 0 && name !== user && (group || (item.force_avatar && !isNarrator))) content = name + ': ' + content;
    content = content.replace(/\r/g, '');
    const sameModel = item.extra?.api === api && item.extra?.model === model;
    const otherGroupMember = group && name !== character;
    const keepThought = sameModel && !otherGroupMember;
    const invocations = Array.isArray(item.extra?.tool_invocations)
      ? item.extra.tool_invocations.map(call => {
          if (keepThought || !call || typeof call !== 'object') return call;
          const copy = structuredClone(call);
          delete copy.signature; delete copy.reasoning;
          return copy;
        }) : undefined;
    const display = item.extra?.media_display || power_user.media_display;
    const mediaDisplay = display === 'gallery' ? 'gallery' : 'list';
    const requestedIndex = Number(item.extra?.media_index);
    const mediaIndex = Array.isArray(item.extra?.media) && Number.isInteger(requestedIndex) &&
      requestedIndex >= 0 && requestedIndex < item.extra.media.length ? requestedIndex : 0;
    messages.push({ role, content, name, media: item.extra?.media,
      mediaDisplay, mediaIndex,
      invocations, signature: keepThought ? item.extra?.reasoning_signature ?? null : null,
      reasoning: keepThought ? String(item.extra?.reasoning ?? '') : '' });
  }
  return messages.reverse();
}

export function setOpenAIMessageExamples(blocks) {
  if (!Array.isArray(blocks)) throw new TypeError('Message examples must be an array');
  const { user, character, group } = names();
  return blocks.map(block => {
    if (typeof block !== 'string') throw new TypeError('Message example must be text');
    return parseCompletionExample(block, user, character, getContext().groupMembers ?? [], true, group);
  });
}
`;
