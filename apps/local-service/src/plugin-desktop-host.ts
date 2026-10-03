// Runs extensions in our real application document. This is a loader, not a
// surrogate chat surface or an embedded upstream application.
export const desktopHostSource = String.raw`
import * as runtime from '/plugin-runtime/compat-runtime.js';
import { loadExtensionSettings, saveSettings, setSettingsErrorHandler, applyGlobalMacroChanges } from '/plugin-runtime/settings.js';
import { connectChatPersistence, flushChatSaves, applyLocalMacroChanges, applyWorldInfoState } from '/plugin-runtime/chat.js';
import { connectMessageRendering } from '/plugin-runtime/message-rendering.js';
import { connectGenerationControls } from '/plugin-runtime/generation-controls.js';
import { generateRaw } from '/plugin-runtime/raw-generation.js';
import { executeSlashCommandsWithOptions } from '/plugin-runtime/scripts/slash-commands.js';
import {loadOpenAISettings,oai_settings,refreshOpenAISettings} from '/plugin-runtime/openai-settings.js';
import {buildChatCompletionRequest} from '/plugin-runtime/openai-transport.js';
import {initializeToolRuntime,registerNativeTools} from '/plugin-runtime/tools.js';
export {respondToMacroRequest,respondToEffectRequest,endEffectInvocation,readMacroResult} from '/plugin-runtime/macro-boundary.js';
import {syncAuthorNote} from '/scripts/authors-note.js';
import {loadPowerUser} from '/scripts/power-user.js';
import {loadPresets,flushPresetWrites} from '/plugin-runtime/scripts/preset-manager.js';
import {formatRegexDisplay,getRegexDisplayKey} from '/plugin-runtime/regex.js';
import {flushCharacterFieldWrites} from '/plugin-runtime/character-fields.js';
export { stopGeneration } from '/plugin-runtime/generation-controls.js';
import { loadWorldInfoState, flushWorldInfoWrites } from '/plugin-runtime/world-info.js';
import { connectCharacterState, syncCharacterSummaries, loadCharacterState } from '/plugin-runtime/characters.js';
import { connectCharacterEditorHost, flushCharacterSaves, selectCharacterById } from '/plugin-runtime/character-editor.js';
import {loadQuickReplies} from '/plugin-runtime/quick-reply.js';
import {connectQuickReplyDocument} from '/plugin-runtime/quick-reply-document.js';
let callbacks;
let started;
let descriptors = [];
const statuses = new Map();
const modules = new Map();
const pendingContributions = new Map();
const contributionRevisions = new Map();
let contributionTimer;
let contributionWrites = Promise.resolve();
function status(id, value) { statuses.set(id, value); callbacks?.status(id, value); }
export const getStatuses = () => Object.fromEntries(statuses);
export function connect(next) {
  callbacks = next;
  connectQuickReplyDocument({input:value=>callbacks.input(value),send:value=>callbacks.generateNative(value),error:error=>status('host','快捷回复失败：'+error.message)});
  runtime.getContext().generateRaw = generateRaw;
  runtime.getContext().nativeGenerate = { send: (value, options) => callbacks.generateNative(value, options), regenerate: options => callbacks.regenerateNative(options), continue: options => callbacks.continueNative(options), impersonate: options => callbacks.impersonateNative(options), quiet: options => callbacks.generateQuietNative(options) };
  runtime.getContext().oaiSettings = oai_settings;
  connectMessageRendering({...next,regexDisplayKey:getRegexDisplayKey});
  next.configureRegexFormatting(formatRegexDisplay);
  connectGenerationControls({ busy: value => callbacks.generationBusy(value), stop: () => callbacks.stopGeneration(), error: error => status('host', error.message) });
  connectCharacterState({ refresh: () => callbacks.refreshCharacters() });
  connectCharacterEditorHost({ select: (id, switchMenu) => callbacks.selectCharacter(id, switchMenu), clear: () => callbacks.clearCharacterSelection(), error: error => status('host', error.message) });
  connectChatPersistence({ render: (conversation, state, reloaded) => callbacks.renderChat(conversation, state, reloaded),
    syncMetadata: (conversationId,metadata) => callbacks?.syncMacroMetadata?.(conversationId,metadata),
    error: error => status('host', '聊天保存失败：' + error.message),
    changed: id => runtime.eventSource.emit(runtime.event_types.CHAT_CHANGED, id),
  });
  for (const [id, value] of statuses) callbacks.status(id, value);
}
export async function completeNativeImpersonation(conversationId, text, signal) {
  signal.throwIfAborted();
  if (runtime.getContext().conversationId !== conversationId) return;
  await runtime.eventSource.emitWithSignal(signal, runtime.event_types.IMPERSONATE_READY, text);
}
export function updateContext(context) {
  const { characters, characterId, ...fields } = context;
  void runtime.applyHostContext({ ...fields, characterUuid: characterId }).catch(error => status('host', '扩展事件失败：' + error.message));
  syncAuthorNote();
  void syncCharacterSummaries(characters).catch(error => status('host', '角色加载失败：' + error.message));
}
function publish(id, contribution) {
  const revision = (contributionRevisions.get(id) || 0) + 1;
  contributionRevisions.set(id, revision);
  pendingContributions.set(id, { value: contribution, revision });
  clearTimeout(contributionTimer);
  contributionTimer = setTimeout(() => { void flushContributions().catch(error => status(id, '保存扩展贡献失败：' + error.message)); }, 300);
}
function flushContributions() {
  clearTimeout(contributionTimer);
  const entries = [...pendingContributions]; pendingContributions.clear();
  const operation = contributionWrites.catch(() => {}).then(async () => {
    for (const [index, [id, entry]] of entries.entries()) {
      if (!descriptors.some(item => item.id === id && item.enabled)) continue;
      try { await callbacks.contributions(id, entry.value); }
      catch (error) {
        for (const [pendingId, pendingEntry] of entries.slice(index)) {
          if (contributionRevisions.get(pendingId) === pendingEntry.revision) pendingContributions.set(pendingId, pendingEntry);
        }
        throw error;
      }
    }
  });
  contributionWrites = operation;
  return operation;
}
export async function flush() { await loadExtensionSettings(); await started; await flushCharacterSaves(); await flushCharacterFieldWrites(); await flushChatSaves(); await flushContributions(); await flushWorldInfoWrites(); await flushPresetWrites(); await saveSettings(); }
export async function runSlashCommand(input) {
  await started;
  try { return await executeSlashCommandsWithOptions(input, { handleParserErrors: false,handleExecutionErrors: true }); }
  catch (error) { return {pipe:'',isError:true,errorMessage:error?.message || String(error),isAborted:false}; }
  finally { await flush(); }
}
export async function beginNativeGeneration(type, options = {}) {
  await started;
  options.signal?.throwIfAborted();
  await runtime.eventSource.emitChecked(runtime.event_types.GENERATION_STARTED, type, options, Boolean(options.dryRun));
  options.signal?.throwIfAborted();
  await runtime.eventSource.emitChecked(runtime.event_types.GENERATION_AFTER_COMMANDS, type, options, Boolean(options.dryRun));
  options.signal?.throwIfAborted();
}
export async function prepareNativeCompletion(request, dryRun, signal, type = 'normal', providerSnapshot) {
  const settings = structuredClone(await refreshOpenAISettings(signal));
  if(providerSnapshot){
    settings.temp_openai=providerSnapshot.temperature;settings.openai_max_tokens=providerSnapshot.maxTokens;
    settings.openai_max_context=providerSnapshot.contextLimitTokens;
    if(providerSnapshot.kind==='anthropic'){settings.chat_completion_source='claude';settings.claude_model=providerSnapshot.model;settings.reverse_proxy=providerSnapshot.baseUrl;}
    else if(providerSnapshot.kind==='gemini'){settings.chat_completion_source='makersuite';settings.google_model=providerSnapshot.model;settings.reverse_proxy=providerSnapshot.baseUrl;}
    else if(['claude','makersuite'].includes(settings.chat_completion_source))settings.chat_completion_source='custom';
    if(settings.chat_completion_source==='custom'){settings.custom_model=providerSnapshot.model;settings.custom_url=providerSnapshot.baseUrl;}
    else if(settings.chat_completion_source==='openai'){settings.openai_model=providerSnapshot.model;settings.reverse_proxy=providerSnapshot.baseUrl;}
  }
  signal.throwIfAborted();
  const event = {chat: request.messages, dryRun};
  await runtime.eventSource.emitChecked(runtime.event_types.CHAT_COMPLETION_PROMPT_READY, event);
  signal.throwIfAborted();
  // ST emits this after PromptManager and before building provider parameters.
  // The original Helper uses this stage for its >=1.13.5 MacroLike listener.
  const generateData = {prompt:event.chat};
  await runtime.eventSource.emitChecked(runtime.event_types.GENERATE_AFTER_DATA, generateData, dryRun);
  signal.throwIfAborted();
  const completion = buildChatCompletionRequest(type, generateData.prompt, settings, request.max_tokens, request.json_schema);
  await registerNativeTools(type,completion,settings,signal);
  if (!dryRun) await runtime.eventSource.emitChecked(runtime.event_types.CHAT_COMPLETION_SETTINGS_READY, completion);
  signal.throwIfAborted();
  // Listener writes must reach storage before the native draft is committed;
  // otherwise a queued save could hide a conflicting edit until after dispatch.
  await flushChatSaves();await saveSettings();signal.throwIfAborted();
  return completion;
}
export function applyNativeMacroVariables(event){
  applyLocalMacroChanges(event.conversationId,event.changes);applyGlobalMacroChanges(event.changes);
  const context=runtime.getContext();
  if(event.worldInfoState)applyWorldInfoState({conversationId:event.conversationId,branchId:event.branchId??context.branchId},event.worldInfoState);
  if((context.conversationId??null)===(event.conversationId??null))
    callbacks?.syncMacroMetadata?.(event.conversationId,structuredClone(context.chatMetadata));
}
function generationMacroOptions(options) {
  if (!(options.responseLength > 0)) return {};
  const maxContext = oai_settings.openai_max_context, maxResponse = options.responseLength;
  return { dynamicMacros: {maxPrompt:maxContext-maxResponse,maxPromptTokens:maxContext-maxResponse,
    maxContext,maxContextTokens:maxContext,maxResponse,maxResponseTokens:maxResponse} };
}
export function prepareQuietPrompt(value, _options) { return String(value??''); }
export async function prepareExtensionPrompts(options = {}) {
  await started; await flushWorldInfoWrites(); await saveSettings(); await flushContributions();
  return runtime.snapshotExtensionPrompts(generationMacroOptions(options), options.skipWIAN ? ['2_floating_prompt'] : [], { skipScan: !!options.skipWIAN, signal:options.signal });
}
export async function editCharacter(id) {
  await loadCharacterState();
  const index = runtime.getContext().characters.findIndex(character => character.id === id);
  if (index >= 0) await selectCharacterById(index);
}

function diagnostics(start) {
  return performance.getEntriesByType('resource').filter(item => item.startTime >= start && item.responseStatus >= 400)
    .map(item => item.name + '（HTTP ' + item.responseStatus + '）').join('；');
}
function addStyle(id, href) {
  return new Promise((resolve, reject) => {
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = href; link.dataset.extensionId = id;
    link.onload = resolve; link.onerror = () => reject(new Error('扩展 CSS 无法加载：' + href));
    document.head.append(link);
  });
}
function legacyApi(descriptor) {
  let root = document.getElementById('mc-extension-' + descriptor.id);
  if (!root) {
    root = document.createElement('section'); root.id = 'mc-extension-' + descriptor.id; root.dataset.extensionId = descriptor.id;
    document.getElementById('plugin-root').append(root);
  }
  return { getContext: runtime.getContext, eventSource: runtime.eventSource, eventTypes: runtime.event_types,
    extensionSettings: runtime.extension_settings, root,
    registerCommand: (name, options = {}) => runtime.registerCommand({ name, ...options }, descriptor.id),
    setSystemPrompt: value => runtime.setOwnedPrompt(descriptor.id, 'legacy-' + descriptor.id, value),
  };
}
async function loadModule(descriptor) {
  if (modules.has(descriptor.id)) return modules.get(descriptor.id);
  const promise = (async () => {
    const start = performance.now();
    const base = '/scripts/extensions/third-party/' + encodeURIComponent(descriptor.extensionName || descriptor.id) + '/';
    try {
      status(descriptor.id, '正在加载…');
      if (descriptor.css) await addStyle(descriptor.id, base + descriptor.css);
      globalThis.MyCompanionPlugin = legacyApi(descriptor);
      runtime.setLoadingExtension(descriptor.id);
      let module = {};
      if (descriptor.js) {
        const entry = base + descriptor.js;
        const response = await fetch(entry);
        if (!response.ok) throw new Error('扩展入口无法访问（HTTP ' + response.status + '）：' + entry);
        if (!/javascript|ecmascript/i.test(response.headers.get('content-type') || '')) throw new Error('扩展入口 MIME 类型错误：' + entry);
        module = await import(entry);
      }
      // jQuery ready callbacks queued by the extension must run before APP_READY.
      await new Promise(resolve => $(resolve));
      return module;
    } catch (error) {
      await new Promise(resolve => setTimeout(resolve, 0));
      const failed = diagnostics(start);
      status(descriptor.id, '加载失败：' + (error?.message || String(error)) + (failed ? '；失败资源：' + failed : ''));
      throw error;
    } finally { runtime.setLoadingExtension(''); }
  })();
  modules.set(descriptor.id, promise);
  return promise;
}
export async function callHook(id, hook) {
  if (!descriptors.some(item => item.id === id)) descriptors = (await fetch('/api/code-plugins/runtime').then(response => response.json())).items;
  const descriptor = descriptors.find(item => item.id === id);
  const hookName = descriptor?.hooks?.[hook];
  if (!hookName) return true;
  let timer;
  try {
    const module = await loadModule(descriptor);
    if (typeof module[hookName] !== 'function') throw new Error('扩展未导出钩子：' + hookName);
    await Promise.race([Promise.resolve(module[hookName]()), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('扩展钩子超时：' + hook)), 5000); })]);
    return true;
  } catch (error) { status(id, '扩展钩子失败：' + error.message); console.error(error); return false; }
  finally { clearTimeout(timer); }
}
export function start() {
  return started ??= (async () => {
    runtime.setContributionPublisher(publish);
    setSettingsErrorHandler(error => status('host', '扩展设置保存失败：' + error.message));
    await loadExtensionSettings();
    await loadPowerUser();
    syncAuthorNote();
    await loadOpenAISettings();
    initializeToolRuntime();
    await loadPresets();
    await loadWorldInfoState();
    await loadCharacterState();
    await loadQuickReplies();
    globalThis.SillyTavern = { getContext: runtime.getContext, eventSource: runtime.eventSource,
      eventTypes: runtime.event_types, extensionSettings: runtime.extension_settings,
      getRequestHeaders: runtime.getRequestHeaders, getApiUrl: runtime.getApiUrl };
    Object.assign(runtime.getContext(), { eventSource: runtime.eventSource, eventTypes: runtime.event_types });
    $(document).on('input.mc-host', '#send_textarea', event => callbacks.input(event.target.value));
    runtime.setOpenExtensions(() => callbacks.openSettings());
    const response = await fetch('/api/code-plugins/runtime');
    if (!response.ok) throw new Error('无法读取扩展运行清单：' + response.status);
    descriptors = (await response.json()).items;
    for (const descriptor of descriptors.filter(item => item.enabled)) {
      // Dynamic prompts are rebuilt by the running extension, never restored
      // from the old flattened contribution cache after a page reload.
      runtime.publishContributions(descriptor.id);
      try { await loadModule(descriptor); if (await callHook(descriptor.id, 'activate')) status(descriptor.id, '扩展已运行'); }
      catch { /* Detailed failure was already reported; independent extensions continue. */ }
    }
    for (const event of [runtime.event_types.EXTENSION_SETTINGS_LOADED, runtime.event_types.APP_INITIALIZED, runtime.event_types.APP_READY]) {
      try { await runtime.eventSource.emit(event); }
      catch (error) { status('host', '扩展事件失败（' + event + '）：' + error.message); console.error(error); }
    }
    try { await flushContributions(); }
    catch (error) { status('host', '扩展贡献保存失败：' + error.message); }
  })();
}
`;
