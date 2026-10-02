import { eventBusSource } from './plugin-runtime-events.js';
export const libShimSource = `export { $, lodash, DOMPurify, Popper, toastr, Handlebars, Cropper, hljs, default } from '/plugin-runtime/libraries.js';`;
export { utilityRuntimeSource as utilityShimSource } from './plugin-runtime-utils.js';

export const compatibilityRuntimeSource = `
import { extension_settings, saveSettings, saveSettingsDebounced, onExtensionSettingsSaved } from '/plugin-runtime/settings.js';
import { bindChatContext, applyChatContext, saveChatConditional, saveMetadata, saveMetadataDebounced } from '/plugin-runtime/chat.js';
import { MacrosParser, substituteParams, substituteParamsExtended } from '/plugin-runtime/macros.js';
import * as variableRuntime from '/plugin-runtime/variables.js';
export { substituteParams, substituteParamsExtended };
export { saveChatConditional, saveMetadata, saveMetadataDebounced };
export { extension_settings, saveSettings, saveSettingsDebounced };
const commands = new Map();
let slashRegistrar, slashExecutor;
export function bindSlashCommands(register, execute) {
  slashRegistrar = register; slashExecutor = execute;
  for (const command of new Set(commands.values())) if (command.callback) register(command);
}
const prompts = new Map();
export let extension_prompts = {};
export const MAX_INJECTION_DEPTH = 10000;
export const extension_prompt_types = { IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2, NONE: -1 };
export const extension_prompt_roles = { SYSTEM: 0, USER: 1, ASSISTANT: 2 };
export function getExtensionPromptRoleByName(value) { return [0, 1, 2].includes(value) ? value : Math.max(0, ['system', 'user', 'assistant'].indexOf(value)); }
let loadingExtension = '';
let contributionPublisher;
let openExtensions;
export const setLoadingExtension = id => { loadingExtension = id; };
export const setContributionPublisher = callback => { contributionPublisher = callback; };
export const setOpenExtensions = callback => { openExtensions = callback; };
export const openThirdPartyExtensionMenu = () => openExtensions?.();
function extensionCaller() {
  const match = new Error().stack?.match(/\\/scripts\\/extensions\\/third-party\\/([^/]+)\\//);
  return match ? decodeURIComponent(match[1]) : loadingExtension;
}
const context = {
  get variables() { return variableRuntime.variableStores; },
  get extensionPrompts() { return extension_prompts; },
  set extensionPrompts(value) { extension_prompts = value ?? {}; },
  chat: [], characters: [], characterId: undefined, characterUuid: null, groupId: null,
  name1: 'User', name2: '', extensionSettings: extension_settings, chatMetadata: {},
  saveSettings, saveSettingsDebounced, saveChat: saveChatConditional, saveMetadata, saveMetadataDebounced,
  substituteParams, substituteParamsExtended,
  registerMacro: (...args) => MacrosParser.registerMacro(...args), unregisterMacro: (...args) => MacrosParser.unregisterMacro(...args),
};
bindChatContext(context);
const contextListeners = new Set();
export const subscribeHostContext = callback => { contextListeners.add(callback); return () => contextListeners.delete(callback); };
export const extensionTypes = {};
export const extensionNames = [];

${eventBusSource}

export const eventSource = new EventBus(['app_ready', 'app_initialized']);
export const event_types = Object.freeze({
  APP_READY: 'app_ready', APP_INITIALIZED: 'app_initialized', CHAT_CHANGED: 'chat_id_changed', MESSAGE_SENT: 'message_sent',
  ONLINE_STATUS_CHANGED: 'online_status_changed',
  MESSAGE_EDITED: 'message_edited', MESSAGE_UPDATED: 'message_updated', MESSAGE_DELETED: 'message_deleted',
  MESSAGE_RECEIVED: 'message_received', CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
  USER_MESSAGE_RENDERED: 'user_message_rendered', GENERATION_STARTED: 'generation_started', GENERATION_AFTER_COMMANDS: 'generation_after_commands',
  GENERATION_ENDED: 'generation_ended', SETTINGS_UPDATED: 'settings_updated',
  GENERATION_STOPPED: 'generation_stopped',
  CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
  CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready',
  OAI_PRESET_CHANGED_BEFORE: 'oai_preset_changed_before', OAI_PRESET_CHANGED_AFTER: 'oai_preset_changed_after',
  PRESET_CHANGED: 'preset_changed', OAI_PRESET_IMPORT_READY: 'oai_preset_import_ready',
  EXTENSION_SETTINGS_LOADED: 'extension_settings_loaded',
  WORLDINFO_UPDATED: 'worldinfo_updated', WORLDINFO_SETTINGS_UPDATED: 'worldinfo_settings_updated',
  WORLD_INFO_ACTIVATED: 'world_info_activated',
  CHARACTER_EDITED: 'character_edited', CHARACTER_DELETED: 'character_deleted', CHAT_DELETED: 'chat_deleted',
  PERSONA_CHANGED: 'persona_changed', PERSONA_CREATED: 'persona_created', PERSONA_UPDATED: 'persona_updated', PERSONA_DELETED: 'persona_deleted',
});
const stopSettingsListener = onExtensionSettingsSaved(() => eventSource.emit(event_types.SETTINGS_UPDATED));
window.addEventListener('pagehide', stopSettingsListener, { once: true });
export const modules = [];
export const getContext = () => context;
let selectedUserName = '';
export function setUserName(value, _options = {}) {
  selectedUserName = String(value || 'User');
  context.name1 = selectedUserName;
  for (const callback of contextListeners) callback(context);
}
// Extras is a separate service, not our local model API.
export const getApiUrl = () => extension_settings.apiUrl || 'http://localhost:5100';
export const getRequestHeaders = () => ({ 'Content-Type': 'application/json' });
export function publishContributions(owner) {
  contributionPublisher?.(owner, {
    systemPrompt: '',
    commands: [...new Set(commands.values())].filter(command => command.owner === owner)
      .map(({ name, description, prompt }) => ({ name, description, prompt })),
  });
}
export function setOwnedPrompt(owner, key, value, position = 0, depth = 0, scan = false, role = 0, filter = null) {
  prompts.set(String(key), { owner });
  Object.defineProperty(extension_prompts, String(key), { value: { value: String(value), position: Number(position), depth: Number(depth), scan: !!scan, role: Number(role ?? 0), filter }, writable: true, enumerable: true, configurable: true });
  publishContributions(owner);
}
export function setExtensionPrompt(key, value, position, depth, scan = false, role = 0, filter = null) { setOwnedPrompt(prompts.get(String(key))?.owner || extensionCaller(), key, value, Number(position), Number(depth), scan, role, filter); }
export async function snapshotExtensionPrompts(macroOptions = {}, excludedKeys = [], { scanOnly = false, skipScan = false } = {}) {
  const entries = Object.entries(extension_prompts).filter(([key]) => !excludedKeys.includes(key)).map(([key, prompt]) => [key, { ...prompt }]);
  const result = [];
  for (const [key, prompt] of entries) {
    const scan = !!prompt.scan && !skipScan;
    if (!prompt.value || (scanOnly && !scan)) continue;
    let position = [-1, 0, 1, 2].includes(prompt.position) ? prompt.position : -1;
    let depth = position === 1 ? prompt.depth : 0;
    if (!Number.isInteger(depth) || depth < 0 || depth > MAX_INJECTION_DEPTH) {
      if (!scan) continue;
      position = -1; depth = 0;
    }
    if (position === -1 && !scan) continue;
    if (typeof prompt.filter === 'function' && !await prompt.filter()) continue;
    // Preserve raw values. Scanning and PromptManager's sorted depth/role
    // buckets own their separate substitution passes in the same request draft.
    result.push({ key, value: String(prompt.value), position, depth, scan,
      role: getExtensionPromptRoleByName(prompt.role), macrosResolved: false });
  }
  return result;
}
export function clearExtensionPrompts() {
  const owners = new Set([...prompts.values()].map(prompt => prompt.owner));
  prompts.clear(); extension_prompts = {}; for (const owner of owners) publishContributions(owner);
}
export function registerCommand(command, owner = extensionCaller()) {
  if (!command || typeof command.name !== 'string') throw new Error('Invalid command name');
  command.owner = owner;
  if (slashRegistrar) slashRegistrar(command);
  else recordSlashCommand(command);
  return command;
}
export function recordSlashCommand(command) {
  command.owner ??= extensionCaller();
  command.description ??= String(command.helpString || '');
  command.prompt ??= '{{args}}';
  commands.set(command.name, command);
  for (const alias of command.aliases ?? []) commands.set(alias, command);
  if (command.owner) publishContributions(command.owner);
}
export const registeredCommand = name => commands.get(String(name)) ?? null;

export const $ = globalThis.jQuery;

export { renderExtensionTemplate, renderExtensionTemplateAsync } from '/plugin-runtime/templates.js';
export const doExtrasFetch = (url, options = {}) => fetch(url, options);

export function applyHostContext(next) {
  const previousChat = context.chat.map(message => ({ ...message }));
  const previousChatId = context.conversationId;
  const { chat, chatMetadata, characters, variables, extensionTypes: types, ...fields } = next || {};
  // Preserve arrays already imported by extensions; replacing them leaves stale
  // exported chat/characters references even when getContext() shows new data.
  applyChatContext(next || {});
  if (characters) context.characters.splice(0, context.characters.length, ...characters);
  if (types) {
    for (const key of Object.keys(extensionTypes)) delete extensionTypes[key];
    Object.assign(extensionTypes, types);
    extensionNames.splice(0, extensionNames.length, ...Object.keys(types));
  }
  Object.assign(context, fields);
  if (selectedUserName) context.name1 = selectedUserName;
  if (previousChatId !== context.conversationId) clearExtensionPrompts();
  const selectedIndex = context.characters.findIndex(character => character.id === context.characterUuid);
  context.characterId = selectedIndex < 0 ? undefined : selectedIndex;
  for (const callback of contextListeners) callback(context);
  const events = [];
  if (previousChatId !== context.conversationId) events.push([event_types.CHAT_CHANGED, context.conversationId || null]);
  else if (chat) {
    // React can publish an unchanged, older snapshot while an extension is
    // updating the canonical array. Emit only changes that survived the merge.
    if (context.chat.length < previousChat.length) events.push([event_types.MESSAGE_DELETED, context.chat.length]);
    context.chat.forEach((message, index) => {
      const previous = previousChat.find(item => item.id === message.id);
      const rendered = message.is_user ? event_types.USER_MESSAGE_RENDERED : event_types.CHARACTER_MESSAGE_RENDERED;
      if (!previous && message.is_user) events.push([event_types.MESSAGE_SENT, index], [rendered, index]);
      else if (!message.is_user && message.mes && message.status !== 'streaming' && message.status !== 'failed' && (!previous || previous.status === 'streaming')) {
        events.push([event_types.MESSAGE_RECEIVED, index], [rendered, index]);
      } else if (previous && previous.status !== 'streaming' && message.status !== 'streaming' && previous.mes !== message.mes) {
        events.push([event_types.MESSAGE_EDITED, index], [event_types.MESSAGE_UPDATED, index]);
      }
    });
  }
  // Called by the React host after commit; listeners see the real rendered DOM.
  return (async () => { for (const event of events) await eventSource.emit(...event); })();
}

export async function executeCommand(name, args) {
  const command = commands.get(String(name));
  if (!command?.callback) return null;
  if (!slashExecutor) throw new Error('Slash runtime is not initialized');
  return (await slashExecutor('/' + name + ' ' + String(args ?? ''), { handleParserErrors: false, handleExecutionErrors: false }))?.pipe;
}
`;

export const extensionsShimSource = `
export { $, doExtrasFetch, eventSource, event_types, extension_settings, extensionTypes, extensionNames, getApiUrl, getContext, modules, openThirdPartyExtensionMenu, registerCommand, renderExtensionTemplate, renderExtensionTemplateAsync, saveMetadataDebounced } from '/plugin-runtime/compat-runtime.js';
export class ModuleWorkerWrapper { constructor(callback) { this.callback = callback; } update(...args) { return this.callback(...args); } }
export { connectedToApi } from '/plugin-runtime/provider-status.js';
export { writeExtensionField } from '/plugin-runtime/character-fields.js';
`;

export const scriptShimSource = `
export { baseChatReplace, getCharacterCardFields, getCharacterCardFieldsLazy, parseMesExamples, getMaxContextSize, countOccurrences, isOdd, getBiasStrings, default_avatar, system_avatar, system_message_types } from '/plugin-runtime/script-data.js';
export { cleanUpMessage } from '/plugin-runtime/message-cleanup.js';
export { user_avatar } from '/scripts/personas.js';
export { activateSendButtons, deactivateSendButtons, showSwipeButtons, setGenerationProgress, stopGeneration, is_send_press } from '/plugin-runtime/generation-controls.js';
export { saveCharacterDebounced, selectCharacterById, deleteCharacter } from '/plugin-runtime/character-editor.js';
export { getCharacters, getOneCharacter, unshallowCharacter, getThumbnailUrl, getPastCharacterChats, printCharacters } from '/plugin-runtime/characters.js';
export { eventSource, event_types, getRequestHeaders, saveSettings, saveSettingsDebounced, setExtensionPrompt, substituteParams, substituteParamsExtended } from '/plugin-runtime/compat-runtime.js';
export { setUserName } from '/plugin-runtime/compat-runtime.js';
export const default_user_avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9rS3lGQAAAABJRU5ErkJggg==';
// All native providers use the Chat Completion request path.
export const main_api = 'openai';
export { online_status } from '/plugin-runtime/provider-status.js';
import { getContext, subscribeHostContext } from '/plugin-runtime/compat-runtime.js';
export const characters = getContext().characters;
export const characters_list = getContext().characters;
export let character_group = getContext().groupId;
export const chat = getContext().chat;
export const chat_metadata = getContext().chatMetadata;
export let name1 = getContext().name1;
export let name2 = getContext().name2;
export let this_chid = getContext().characterId;
subscribeHostContext(context => { character_group = context.groupId; name1 = context.name1; name2 = context.name2; this_chid = context.characterId; });
export { Generate } from '/plugin-runtime/generate.js';
export const animation_duration = 0;
export { extension_prompts, extension_prompt_types, extension_prompt_roles, MAX_INJECTION_DEPTH, getExtensionPromptRoleByName } from '/plugin-runtime/compat-runtime.js';
export const getCurrentChatId = () => getContext().conversationId || '';
export { saveChatConditional, saveMetadata, isChatSaving, reloadCurrentChat } from '/plugin-runtime/chat.js';
export { updateMessageBlock, messageFormatting, reloadMarkdownProcessor, scrollChatToBottom, addOneMessage, clearChat, printMessages } from '/plugin-runtime/message-rendering.js';
export { cancelDebouncedChatSave } from '/plugin-runtime/chat.js';
export { generateQuietPrompt } from '/plugin-runtime/quiet-generation.js';
export { generateRaw, generateRawData, createRawPrompt } from '/plugin-runtime/raw-generation.js';
`;





export const popupShimSource = `export { Popup, PopupUtils, POPUP_TYPE, POPUP_RESULT, callGenericPopup, getTopmostModalLayer, fixToastrForDialogs } from '/plugin-runtime/popup.js';`;
export const i18nShimSource = `export { t, translate, getCurrentLocale, addLocaleData, applyLocale, initLocales } from '/plugin-runtime/i18n.js';`;
