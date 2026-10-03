// Legacy macro contracts evaluated in the real extension document. This is
// not the experimental nested/scoped MacroRegistry engine.
export const macrosRuntimeSource = String.raw`
import {getContext} from '/plugin-runtime/compat-runtime.js';
import {getVariableMacros} from '/plugin-runtime/variables.js';
import {getChatCompletionModel,oai_settings} from '/plugin-runtime/openai-settings.js';
import {expandTavernRandom} from '/plugin-runtime/random-macros.js';
import {tavernTimeValue} from '/plugin-runtime/time-macros.js';
import {getCurrentLocale} from '/plugin-runtime/i18n.js';
import {MacroEngine,MacroRegistry,MacroEnvironmentBuilder,env_provider_order} from '/plugin-runtime/vendor/macro-engine.js';
import {getCharacterCardFields,getCharacterCardFieldsLazy,parseMesExamples} from '/plugin-runtime/script-data.js';
import {power_user} from '/scripts/power-user.js';
import {getLocalVariable,getGlobalVariable,variableStores} from '/plugin-runtime/variables.js';
const escapeRegex=value=>String(value).replace(/[.*+?^$\{\}()|[\]\\]/g,'\\$&');
const keyName=key=>{if(typeof key!=='string'||!key.trim())throw new Error('Macro key must be a nonempty string');return key.trim();};
export function getOutletPrompt(key){return getContext().extensionPrompts?.['customWIOutlet_'+key]?.value||'';}
export function withWorldInfoOutlets(outlets,work){
  if(outlets===undefined)return work();
  const prompts=getContext().extensionPrompts, prefix='customWIOutlet_',before={};
  if(!prompts)return work();
  for(const key of Object.keys(prompts))if(key.startsWith(prefix)){
    Object.defineProperty(before,key,{value:Object.getOwnPropertyDescriptor(prompts,key),enumerable:true});delete prompts[key];
  }
  for(const [key,value] of Object.entries(outlets))Object.defineProperty(prompts,prefix+key,
    {value:{value,position:-1,depth:0,scan:false,role:0},writable:true,enumerable:true,configurable:true});
  try{return work();}finally{
    for(const key of Object.keys(prompts))if(key.startsWith(prefix))delete prompts[key];
    Object.defineProperties(prompts,before);
  }
}
export class MacrosParser{
  static #values=new Map();
  static #descriptions=new Map();
  static get(key){return this.#values.get(key);}
  static has(key){return this.#values.has(key);}
  static registerMacro(key,value,description=''){
    this.registerLegacyMacro(key,value,description);
    key=keyName(key);
    MacroRegistry.registerMacro(key,{description,handler:({env})=>typeof value==='function'?value(env.extra.nonce):this.sanitizeMacroValue(value)});
  }
  static registerLegacyMacro(key,value,description=''){
    key=keyName(key);
    if(key.startsWith('{{')||key.endsWith('}}'))throw new Error('Macro key must not include surrounding braces');
    this.#values.set(key,typeof value==='function'?value:this.sanitizeMacroValue(value));
    if(typeof description==='string'&&description)this.#descriptions.set(key,description);
  }
  static unregisterMacro(key){key=keyName(key);this.#values.delete(key);this.#descriptions.delete(key);MacroRegistry.unregisterMacro(key);}
  static *[Symbol.iterator](){for(const key of this.#values.keys())yield {key,description:this.#descriptions.get(key)};}
  static populateEnv(env){
    if(!env||typeof env!=='object')return;
    for(const [key,value] of this.#values)Object.defineProperty(env,key,{value,enumerable:true,writable:true,configurable:true});
  }
  static sanitizeMacroValue(value){
    if(value==null||typeof value==='function'||value instanceof Promise)return '';
    if(value instanceof Date)return value.toISOString();
    return typeof value==='object'?JSON.stringify(value):String(value);
  }
}
export function getLastMessageId({exclude_swipe_in_propress=true,filter=null}={}){
  const chat=getContext().chat;
  for(let index=chat.length-1;index>=0;index--){
    const message=chat[index];
    if(exclude_swipe_in_propress&&message.swipes&&message.swipe_id>=message.swipes.length)continue;
    if(!filter||filter(message))return index;
  }
  return null;
}
export function evaluateMacros(content,env,postProcessFn,macroEnv){
  if(!content)return '';
  content=String(content);
  const post=typeof postProcessFn==='function'?postProcessFn:value=>value;
  macroEnv??=createBrowserMacroEnvironment(content,{name1Override:typeof env.user==='string'?env.user:undefined,name2Override:typeof env.char==='string'?env.char:undefined,groupOverride:typeof env.group==='string'?env.group:undefined,dynamicMacros:env});
  MacrosParser.populateEnv(env);
  const nonce=macroEnv.extra.nonce,chat=getContext().chat,now=new Date(),locale=getCurrentLocale();
  const value=key=>typeof env[key]==='function'?env[key]():env[key];
  const message=filter=>chat[getLastMessageId({filter})]?.mes??'';
  const lastSwipe=()=>chat[getLastMessageId({exclude_swipe_in_propress:false})];
  const steps=[
    ...[['USER','user'],['BOT','char'],['CHAR','char'],['CHARIFNOTGROUP','group'],['GROUP','group']].map(([tag,key])=>({regex:new RegExp('<'+tag+'>','gi'),replace:()=>value(key)})),
    ...getVariableMacros(),
    {regex:/{{newline}}/gi,replace:()=>'\n'},
    {regex:/(?:\r?\n)*{{trim}}(?:\r?\n)*/gi,replace:()=>''},
    {regex:/{{noop}}/gi,replace:()=>''},
    {regex:/{{input}}/gi,replace:()=>String(document.querySelector('#send_textarea')?.value??'')},
    ...Object.keys(env).map(key=>({regex:new RegExp('{{'+escapeRegex(key)+'}}','gi'),replace:()=>MacrosParser.sanitizeMacroValue(typeof env[key]==='function'?env[key](nonce,macroEnv):env[key])})),
    ...Object.entries({
      maxPrompt:()=>oai_settings.openai_max_context-oai_settings.openai_max_tokens,
      maxPromptTokens:()=>oai_settings.openai_max_context-oai_settings.openai_max_tokens,
      maxContext:()=>oai_settings.openai_max_context,maxContextTokens:()=>oai_settings.openai_max_context,
      maxResponse:()=>oai_settings.openai_max_tokens,maxResponseTokens:()=>oai_settings.openai_max_tokens,
      lastMessage:()=>message(null),lastMessageId:()=>getLastMessageId()??'',
      lastUserMessage:()=>message(item=>item.is_user&&!item.is_system),
      lastCharMessage:()=>message(item=>!item.is_user&&!item.is_system),
      firstIncludedMessageId:()=>getContext().chatMetadata.lastInContextMessageId??'',
      firstDisplayedMessageId:()=>document.querySelector('#chat .mes')?.getAttribute('mesid')??'',
      lastSwipeId:()=>lastSwipe()?.swipes?.length??'',
      currentSwipeId:()=>lastSwipe()?.swipe_id==null?'':lastSwipe().swipe_id+1,
      allChatRange:()=>chat.length?'0-'+(chat.length-1):'',
    }).map(([key,read])=>({regex:new RegExp('{{'+key+'}}','gi'),replace:()=>String(read())})),
    ...['time','date','weekday','isotime','isodate'].map(key=>({regex:new RegExp('{{'+key+'}}','gi'),replace:()=>tavernTimeValue(key,now,locale)})),
    {regex:/{{reverse:(.+?)}}/gi,replace:(_,value)=>Array.from(value).reverse().join('')},
    {regex:/\{\{\/\/([\s\S]*?)\}\}/gm,replace:()=>''},
    {regex:/{{outlet::(.+?)}}/gi,replace:(_,key)=>getOutletPrompt(key.trim())||''},
  ];
  for(const step of steps){
    if(!content)break;
    try{content=content.replace(step.regex,(...args)=>post(step.replace(...args)));}
    catch(error){console.warn('Macro replacement failed; original pass retained',step.regex,error);}
  }
  return expandTavernRandom(content);
}
export function substituteParams(content,options,...legacy){
  if(!content)return '';
  if(!options||typeof options!=='object'||Array.isArray(options)){
    const [name2Override,original,groupOverride,replaceCharacterCard,dynamicMacros,postProcessFn]=legacy;
    options={name1Override:options,name2Override,original,groupOverride,replaceCharacterCard,dynamicMacros,postProcessFn};
  }
  if(power_user.experimental_macro_engine)return MacroEngine.evaluate(String(content),createBrowserMacroEnvironment(String(content),options));
  const context=getContext(),env=Object.create(null);
  const macroEnv=createBrowserMacroEnvironment(String(content),options);
  if(typeof options.original==='string'){
    env.original=macroEnv.functions.original;
  }
  // Legacy substitution eagerly resolves the whole card even for plain text.
  // baseChatReplace opts out while resolving each field to prevent recursion.
  if(options.replaceCharacterCard??true){
    const fields=getCharacterCardFields();
    env.charPrompt=fields.system||'';
    env.charInstruction=env.charJailbreak=fields.jailbreak||'';
    env.description=fields.description||'';
    env.personality=fields.personality||'';
    env.scenario=fields.scenario||'';
    env.persona=fields.persona||'';
    env.mesExamples=()=>parseMesExamples(fields.mesExamples).join('');
    env.mesExamplesRaw=fields.mesExamples||'';
    env.charVersion=env.char_version=fields.version||'';
    env.charDepthPrompt=fields.charDepthPrompt||'';
    env.creatorNotes=fields.creatorNotes||'';
  }
  env.user=options.name1Override??context.name1;
  env.char=options.name2Override??context.name2;
  env.group=env.charIfNotGroup=env.groupNotMuted=options.groupOverride??env.char;
  env.notChar=env.user;
  env.model=getChatCompletionModel();
  if(options.dynamicMacros&&typeof options.dynamicMacros==='object')Object.assign(env,options.dynamicMacros);
  return evaluateMacros(String(content),env,options.postProcessFn,macroEnv);
}
export const MacroEnvBuilder=new MacroEnvironmentBuilder(()=>{
  const context=getContext();
  return {name1:context.name1,name2:context.name2,characters:context.characters,
    selected_group:context.groupId,groups:context.groups??(context.groupId?[{id:context.groupId,members:context.groupMembers,disabled_members:context.disabledGroupMembers??[]}]:[]),
    getGeneratingModel:getChatCompletionModel,getCharacterCardFieldsLazy};
});
MacroEnvBuilder.registerProvider(env=>{
  const context=getContext(),chat=context.chat,now=new Date(),locale=getCurrentLocale();
  const last=filter=>chat[getLastMessageId({filter})]?.mes??'';
  const swipe=chat[getLastMessageId({exclude_swipe_in_propress:false})];
  Object.assign(env.extra,{nonce:crypto.randomUUID(),model:env.system.model,input:document.querySelector('#send_textarea')?.value??'',
      maxPrompt:oai_settings.openai_max_context-oai_settings.openai_max_tokens,maxContext:oai_settings.openai_max_context,maxResponse:oai_settings.openai_max_tokens,
      lastMessage:last(null),lastMessageId:getLastMessageId()??'',lastUserMessage:last(message=>message.is_user&&!message.is_system),lastCharMessage:last(message=>!message.is_user&&!message.is_system),
      firstIncludedMessageId:context.chatMetadata.lastInContextMessageId??'',firstDisplayedMessageId:document.querySelector('#chat .mes')?.getAttribute('mesid')??'',
      lastSwipeId:swipe?.swipes?.length??'',currentSwipeId:swipe?.swipe_id==null?'':swipe.swipe_id+1,allChatRange:chat.length?'0-'+(chat.length-1):'',
      ...Object.fromEntries(['date','time','weekday','isodate','isotime'].map(key=>[key,()=>tavernTimeValue(key,now,locale)])),
      // The desktop provider uses chat completion (main_api = 'openai').
      parseMesExamples,isInstruct:false,
      getOutletPrompt,
      readVariable:(key,global)=>(global?getGlobalVariable:getLocalVariable)(key),variables:variableStores,
  });
},env_provider_order.EARLIEST);
export function createBrowserMacroEnvironment(content,options={}){
  return MacroEnvBuilder.buildFromRawEnv({...options,replaceCharacterCard:options.replaceCharacterCard??true,content});
}
export function substituteParamsExtended(content,additionalMacro={},postProcessFn){return substituteParams(content,{dynamicMacros:additionalMacro,postProcessFn});}
`;
