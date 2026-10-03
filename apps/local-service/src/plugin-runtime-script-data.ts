// Independently implemented script.js data helpers. Browser extensions read the
// same live character, persona and provider state used by the native service.
export const scriptDataSource = String.raw`
import { getContext, substituteParams } from '/plugin-runtime/compat-runtime.js';
import { power_user } from '/scripts/power-user.js';
import { oai_settings } from '/plugin-runtime/openai-settings.js';
import { createCharacterMacroFieldsLazy, readCharacterMacroFields } from '/plugin-runtime/character-macro-fields.js';

export const system_message_types = Object.freeze({
  HELP:'help', WELCOME:'welcome', EMPTY:'empty', GENERIC:'generic', NARRATOR:'narrator',
  COMMENT:'comment', SLASH_COMMANDS:'slash_commands', FORMATTING:'formatting',
  HOTKEYS:'hotkeys', MACROS:'macros', WELCOME_PROMPT:'welcome_prompt',
  ASSISTANT_NOTE:'assistant_note', ASSISTANT_MESSAGE:'assistant_message',
});
const avatarSvg = (background, foreground, label) => 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">' +
  '<rect width="64" height="64" rx="16" fill="' + background + '"/>' +
  '<text x="32" y="43" text-anchor="middle" font-size="32" font-family="sans-serif" fill="' + foreground + '">' + label + '</text></svg>');
export const default_avatar = avatarSvg('#d9e5ee', '#263849', 'M');
export const system_avatar = avatarSvg('#e8e3ef', '#46395d', '✦');

export function baseChatReplace(value, name1Override = null, name2Override = null) {
  if (typeof value !== 'string' || !value) return value;
  let result = substituteParams(value, { name1Override, name2Override, replaceCharacterCard: false });
  if (power_user.collapse_newlines) result = result.replace(/\n+/g, '\n');
  return result.replace(/\r/g, '');
}

export function getCharacterCardFields({ chid } = {}) {
  return readCharacterMacroFields(getCharacterCardFieldsLazy({chid}));
}
let characterMacroSources;
export function beginCharacterMacroSources(sources) { const before=characterMacroSources;characterMacroSources=sources;let left=false;
  return ()=>{if(!left){left=true;characterMacroSources=before;}}; }
export function withCharacterMacroSources(sources,work) { const leave=beginCharacterMacroSources(sources);
  try{return work();}finally{leave();} }
export function getCharacterCardFieldsLazy({ chid } = {}) {
  if(characterMacroSources && chid===undefined)return createCharacterMacroFieldsLazy(characterMacroSources,text=>baseChatReplace(text));
  const context = getContext();
  const character = context.characters[chid ?? context.characterId];
  const data = character?.data || {};
  const metadata = context.chatMetadata || {};
  // Source getters preserve lazy reads of this captured live card/metadata.
  return createCharacterMacroFieldsLazy({
    get system(){return power_user.prefer_character_prompt !== false ? metadata.system_prompt || data.system_prompt : '';},
    get mesExamples(){return metadata.mes_example || character?.mes_example || data.mes_example;},
    get description(){return character?.description || data.description;},
    get personality(){return character?.personality || data.personality;},
    get persona(){return power_user.persona_description;},
    get scenario(){return metadata.scenario || character?.scenario || data.scenario;},
    get jailbreak(){return power_user.prefer_character_jailbreak !== false ? data.post_history_instructions : '';},
    get version(){return data.character_version;},
    get charDepthPrompt(){return data.extensions?.depth_prompt?.prompt;},
    get creatorNotes(){return data.creator_notes;},
    get firstMessage(){return character?.first_mes || data.first_mes;},
    get alternateGreetings(){return Array.isArray(data.alternate_greetings) ? data.alternate_greetings : [];},
  }, text => baseChatReplace(text));
}

export function parseMesExamples(value, isInstruct = false) {
  if (typeof value !== 'string' || !value.trim() || value.trim() === '<START>') return [];
  const source = /^<START>/i.test(value) ? value : '<START>\n' + value.trim();
  const heading = isInstruct || oai_settings.chat_completion_source
    ? '<START>\n' : power_user.context?.example_separator ? baseChatReplace(power_user.context.example_separator) + '\n' : '';
  return source.split(/<START>/gi).slice(1).map(block => heading + block.trim() + '\n');
}

// The native prompt budget reserves response tokens and a fixed 512-token
// framing margin. The helper's world-info preparation must see that same limit.
export function getMaxContextSize() {
  const context = Number(oai_settings.openai_max_context);
  const response = Number(oai_settings.openai_max_tokens);
  if (!Number.isFinite(context) || !Number.isFinite(response)) return 0;
  return Math.max(0, Math.floor(context) - Math.min(Math.floor(response), Math.floor(context)) - 512);
}

export function countOccurrences(text, needle) {
  if (!needle) return 0;
  return String(text).split(String(needle)).length - 1;
}
export function isOdd(value) { return Number(value) % 2 !== 0; }

function extractBias(text) {
  if (typeof text !== 'string' || !text) return '';
  const matches = [...text.matchAll(/\{\{\s*bias(?:::|\s+)([^{}]*?)\s*\}\}/gi)]
    .map(match => match[1].trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_, double, single) => double ?? single ?? ''))
    .filter(Boolean);
  return matches.length ? ' ' + matches.join(' ') : '';
}
export function getBiasStrings(input, type = 'normal') {
  if (type === 'impersonate' || type === 'continue') return { messageBias:'', promptBias:'', isUserPromptBias:false };
  const context = getContext();
  const messageBias = extractBias(input);
  let previousBias = '';
  if (!input) for (let index = context.chat.length - 1; index >= 0; index--) {
    if (type === 'swipe' && index === context.chat.length - 1) continue;
    const item = context.chat[index];
    if (item?.is_user || item?.is_system || item?.extra?.type === system_message_types.NARRATOR) {
      previousBias = typeof item.extra?.bias === 'string' ? item.extra.bias : '';
      break;
    }
  }
  const configured = typeof power_user.user_prompt_bias === 'string' ? power_user.user_prompt_bias : '';
  const promptBias = messageBias || previousBias || configured;
  return { messageBias: substituteParams(messageBias), promptBias: substituteParams(promptBias),
    isUserPromptBias: !!configured && promptBias === configured };
}
`;
