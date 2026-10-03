import {isModelImageInliningSupported} from "./model-prompt-image.js";

// Embed a parenthesized, dependency-free function expression so the browser
// and native request snapshot use the same capability rule after compilation.
export const openAISettingsSource = `const isModelImageInliningSupported = (${isModelImageInliningSupported.toString()});\n` + String.raw`
import {extension_settings,loadExtensionSettings,registerSettingsParticipant} from '/plugin-runtime/settings.js';
import {chatCompletionPromptDefaults} from '/plugin-runtime/prompt-manager-core.js';
const storageKey = '__mycompanion_openai';
export const chat_completion_sources = Object.freeze({
  OPENAI:'openai', CLAUDE:'claude', OPENROUTER:'openrouter', AI21:'ai21',
  MAKERSUITE:'makersuite', VERTEXAI:'vertexai', MISTRALAI:'mistralai',
  CUSTOM:'custom', COHERE:'cohere', PERPLEXITY:'perplexity', GROQ:'groq',
  ELECTRONHUB:'electronhub', CHUTES:'chutes', NANOGPT:'nanogpt',
  DEEPSEEK:'deepseek', AIMLAPI:'aimlapi', XAI:'xai', POLLINATIONS:'pollinations',
  MOONSHOT:'moonshot', FIREWORKS:'fireworks', COMETAPI:'cometapi',
  AZURE_OPENAI:'azure_openai', ZAI:'zai', SILICONFLOW:'siliconflow',
  WORKERS_AI:'workers_ai', MINIMAX:'minimax',
});
export const openai_max_stop_strings = 4;
export const custom_prompt_post_processing_types = Object.freeze({NONE:'',CLAUDE:'claude',MERGE:'merge',MERGE_TOOLS:'merge_tools',SEMI:'semi',SEMI_TOOLS:'semi_tools',STRICT:'strict',STRICT_TOOLS:'strict_tools',SINGLE:'single'});
export let model_list = [];
export const oai_settings = {
  chat_completion_source:'custom', stream_openai:true, show_thoughts:true, media_inlining:true, inline_image_quality:'auto',
  temp_openai:0.8, freq_pen_openai:0, pres_pen_openai:0, top_p_openai:1, top_k_openai:0,
  openai_max_tokens:1024, openai_max_context:32768, custom_model:'', openai_model:'', custom_url:'',
  custom_include_body:'',custom_exclude_body:'',custom_include_headers:'',reverse_proxy:'',proxy_password:'',
  seed:-1,n:1,function_calling:false,custom_prompt_post_processing:'',...chatCompletionPromptDefaults,squash_system_messages:false,
  prompts:[],prompt_order:[],extensions:{},
};
export const proxies = [];
let ready, initialized=false, mirror={}, previousCapture, refreshRevision=0, readRevision=0, appliedReadRevision=0;
const clone = value => JSON.parse(JSON.stringify(value));
const fields = {temperature:'temp_openai',maxTokens:'openai_max_tokens',contextLimitTokens:'openai_max_context'};
const modelField = source => source==='makersuite' ? 'google_model' : String(source)+'_model';
export function getChatCompletionModel(settings = null) {
  const source = settings || oai_settings;
  const value = source[modelField(source.chat_completion_source)];
  return source.chat_completion_source === 'openrouter' && value === 'OR_Website' ? null : value;
}
function mapping() {
  return {...fields,...(['custom','openai','claude','makersuite'].includes(oai_settings.chat_completion_source) ? {model:modelField(oai_settings.chat_completion_source)} : {}),
    ...(oai_settings.chat_completion_source==='custom'?{baseUrl:'custom_url'}:['claude','makersuite'].includes(oai_settings.chat_completion_source)?{baseUrl:'reverse_proxy'}:{})};
}
function projection() {return Object.fromEntries(Object.entries(mapping()).map(([key,property])=>[key,oai_settings[property]]));}
function applyProvider(provider, captured, mapped=mapping()) {
  if(!mirror.kind || provider.kind!==mirror.kind){
    if(provider.kind==='anthropic')oai_settings.chat_completion_source='claude';
    else if(provider.kind==='gemini')oai_settings.chat_completion_source='makersuite';
    else if(['claude','makersuite'].includes(oai_settings.chat_completion_source))oai_settings.chat_completion_source='custom';
    mapped=mapping();captured=null;
  }
  for(const [key,property] of Object.entries(mapped)) if(!captured || oai_settings[property]===captured[key]) oai_settings[property]=provider[key];
  mirror={...provider};
}
async function readProvider(signal) {
  const response=await fetch('/api/settings/provider',{signal});if(!response.ok)throw new Error('Cannot load provider settings');return response.json();
}
export async function loadOpenAISettings() {
  return ready ??= (async()=>{
    await loadExtensionSettings();
    const stored=extension_settings[storageKey];
    if(stored?.settings && typeof stored.settings==='object') Object.defineProperties(oai_settings,Object.getOwnPropertyDescriptors(clone(stored.settings)));
    if(Array.isArray(stored?.proxies)) proxies.splice(0,proxies.length,...clone(stored.proxies));
    const provider=await readProvider();applyProvider(provider);
    if(!oai_settings.openai_model)oai_settings.openai_model=provider.model;
    initialized=true;
  })().catch(error=>{ready=undefined;throw error;});
}
export async function refreshOpenAISettings(signal) {
  await loadOpenAISettings();
  const generation=refreshRevision, revision=++readRevision, provider=await readProvider(signal);
  if(generation===refreshRevision && revision>=appliedReadRevision) {appliedReadRevision=revision;applyProvider(provider,{...mirror});}
  return oai_settings;
}
registerSettingsParticipant('openai',()=>{
  if(!initialized)return async()=>{};
  extension_settings[storageKey]={settings:clone(oai_settings),proxies:clone(proxies)};
  const mapped=mapping(),values=clone(projection()),state={expected:{...mirror},applied:{},result:null},previous=previousCapture;
  previousCapture=state;
  return async()=>{
    const baseline={...state.expected};
    for(const key of Object.keys(values)) if(previous?.applied[key] && baseline[key]===previous.expected[key]) baseline[key]=previous.result[key];
    const response=await fetch('/api/settings/provider/extension-patch',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({values,baseline})});
    const data=await response.json();if(!response.ok)throw new Error(data.error?.message || 'Cannot save provider settings');
    state.result=data.provider;
    for(const key of Object.keys(values))state.applied[key]=!data.conflicts.includes(key);
    const connectionUnchanged=['kind','baseUrl','model','hasApiKey'].every(key=>mirror[key]===data.provider[key]);
    ++refreshRevision;applyProvider(data.provider,values,mapped);
    window.dispatchEvent(new CustomEvent('mycompanion:provider-saved',{detail:{...data.provider,connectionUnchanged}}));
  };
});
export function isImageInliningSupported() {
  return isModelImageInliningSupported(oai_settings.chat_completion_source,getChatCompletionModel(),oai_settings.media_inlining);
}
`;
