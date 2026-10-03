// Browser-side adapter for Tavern's OpenAI prompt entry. The model-bound
// assembly and budget remain in model-client.ts, shared with native chat.
export const openAIPromptSource = String.raw`
import { getContext, eventSource, event_types, snapshotExtensionPrompts } from '/plugin-runtime/compat-runtime.js';
import { oai_settings } from '/plugin-runtime/openai-settings.js';
import {captureMacroApiTarget,requestMacroEvaluation} from '/plugin-runtime/macro-api.js';
import {substituteParams} from '/plugin-runtime/macros.js';
import {PromptManager,readPromptManagerSettings,chatCompletionDefaultPrompts,promptManagerDefaultPromptOrder} from '/plugin-runtime/prompt-manager-core.js';

let renderTimer;
let lastReport = null;
const render = () => {
  const mount = document.getElementById('extensions_settings');
  if (!mount || !lastReport) return;
  let panel = document.getElementById('mycompanion-prompt-manager');
  if (!panel) {
    panel = document.createElement('details');
    panel.id = 'mycompanion-prompt-manager';
    const heading = document.createElement('summary');
    heading.textContent = '本轮提示词';
    const body = document.createElement('pre');
    panel.append(heading, body);
    mount.append(panel);
  }
    panel.querySelector('pre').textContent = lastReport.messages.map(message =>
    '[' + message.role + (message.name ? ' · ' + message.name : '') + '] ' + (Array.isArray(message.content)?message.content.filter(part=>part.type==='text').map(part=>part.text).join('\n'):message.content)).join('\n\n') +
    '\n\nToken：' + lastReport.totalTokens + '/' + lastReport.contextLimitTokens +
    (lastReport.diagnostics.length ? '\n' + lastReport.diagnostics.join('\n') : '');
};
const renderDebounced = () => {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 150);
};

const initialSettings=readPromptManagerSettings({__mycompanion_openai:{settings:oai_settings}}) || {...oai_settings,
  prompts:structuredClone(chatCompletionDefaultPrompts.prompts),prompt_order:[{character_id:100001,order:structuredClone(promptManagerDefaultPromptOrder)}]};
export const promptManager = Object.assign(new PromptManager(initialSettings,(content,original)=>substituteParams(content??'',
  typeof original==='string'?{original}:{})), {
  messages: null,
  tokenHandler: { counts: {} },
  error: null,
  render,
  renderDebounced,
  setChatCompletion(completion) { this.messages = completion?.getMessages?.() ?? completion?.messages ?? null; },
  getChatCompletion() { return this.messages; },
  async saveServiceSettings() { await (await import('/script.js')).saveSettings(); },
});

export function setupChatCompletionPromptManager(settings = oai_settings) {
  promptManager.serviceSettings = readPromptManagerSettings({__mycompanion_openai:{settings}}) || {...settings,
    prompts:structuredClone(chatCompletionDefaultPrompts.prompts),prompt_order:[{character_id:100001,order:structuredClone(promptManagerDefaultPromptOrder)}]};
  promptManager.activeCharacter = getContext().characterId===undefined?null:{id:100001};
  return promptManager;
}

export async function prepareOpenAIMessages(messageData, dryRun = false) {
  if (!messageData || typeof messageData !== 'object') throw new TypeError('Prompt data is required');
  setupChatCompletionPromptManager(oai_settings);
  const conversationId = getContext().conversationId;
  const target=captureMacroApiTarget();
  if (!conversationId) throw new Error('请先选择一个故事，再组装提示词。');
  const extensionPrompts = Array.isArray(messageData.extensionPrompts)
    ? messageData.extensionPrompts : await snapshotExtensionPrompts();
  const messages = (messageData.messages || []).map(message => ({...message,
    ...(Number(oai_settings.names_behavior) === 1 ? {} : {name:undefined})}));
  const optionalText = value => typeof value === 'string' ? value : undefined;
  const payload = { messages, extensionPrompts,imageQuality:oai_settings.inline_image_quality||'auto',
    messageExamples: Array.isArray(messageData.messageExamples) ? messageData.messageExamples : [],
    name2: optionalText(messageData.name2),
    charDescription: optionalText(messageData.charDescription),
    charPersonality: optionalText(messageData.charPersonality),
    scenario: optionalText(messageData.scenario), Scenario: optionalText(messageData.Scenario),
    worldInfoBefore: optionalText(messageData.worldInfoBefore),
    worldInfoAfter: optionalText(messageData.worldInfoAfter),
    systemPromptOverride: optionalText(messageData.systemPromptOverride),
    jailbreakPromptOverride: optionalText(messageData.jailbreakPromptOverride),
    personaDescription: optionalText(messageData.personaDescription),
    bias: optionalText(messageData.bias), quietPrompt: optionalText(messageData.quietPrompt), quietImage: optionalText(messageData.quietImage),
    cyclePrompt: optionalText(messageData.cyclePrompt), type: optionalText(messageData.type) || 'normal',
    contextLimitTokens: Number(oai_settings.openai_max_context) || 32768,
    maxTokens: Number(oai_settings.openai_max_tokens) || 1024 };
  let result;
  try{result=await requestMacroEvaluation('/api/conversations/' + encodeURIComponent(conversationId) + '/extension-prompt-assembly',()=>payload,target);}
  catch(error){promptManager.error=error.message;throw error;}
  promptManager.error = null;
  lastReport = result;
  const { Message, MessageCollection, ChatCompletion } = await import('/scripts/openai.js');
  const completion = new ChatCompletion();
  const collection = new MessageCollection('root');
  for (const [index, source] of result.messages.entries()) {
    const message = await Message.createAsync(source.role, source.content, index === 0 ? 'main' : 'chat_history-' + index);
    if (source.name) await message.setName(source.name);
    collection.add(message);
  }
  completion.messages = collection;
  completion.setTokenBudget(Number(oai_settings.openai_max_context), Number(oai_settings.openai_max_tokens));
  completion.reserveBudget(collection.getTokens());
  promptManager.setChatCompletion(completion);
  promptManager.tokenHandler.counts = Object.fromEntries(result.regions.map(region => [region.key, region.tokens]));
  promptManager.tokenUsage = result.totalTokens;
  const eventData = { chat: result.messages, dryRun };
  await eventSource.emitChecked(event_types.CHAT_COMPLETION_PROMPT_READY, eventData);
  if (!dryRun) promptManager.render(false);
  return [eventData.chat, promptManager.tokenHandler.counts];
}
`;
