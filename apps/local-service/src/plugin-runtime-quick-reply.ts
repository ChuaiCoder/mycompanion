// Fixed QR execution and automation run on the native document and persistence.
export const quickReplyRuntimeSource=String.raw`
import {QuickReply,QuickReplySet,AutoExecuteHandler,loadSets,createQuickReplyNamedExecutor} from '/plugin-runtime/quick-reply-upstream.js';
import {getContext,eventSource,event_types} from '/plugin-runtime/compat-runtime.js';
import {extension_settings} from '/plugin-runtime/settings.js';
import {SlashCommandAbortController} from '/scripts/slash-commands/SlashCommandAbortController.js';
const activationSignals=new WeakMap(),preventAutoExecuteStack=[];
let ready=false,loading;
export async function loadQuickReplies(){
  if(loading)return loading;
  loading=(async()=>{QuickReplySet.list.length=0;await loadSets();ready=true;})().finally(()=>{loading=undefined;});
  return loading;
}
async function executeBound(set,qr,options,signal){
  signal?.throwIfAborted();
  const executionOptions={...options.executionOptions};
  const controller=executionOptions.abortController??new SlashCommandAbortController();executionOptions.abortController=controller;
  const cancel=()=>{if(!controller.signal.aborted)controller.abort(String(signal.reason?.message??'扩展执行已取消。'),true);};
  signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
  try{const result=await set.executeWithOptions(qr,{...options,executionOptions});signal?.throwIfAborted();return result;}
  finally{signal?.removeEventListener('abort',cancel);}
}
function bindSet(set,signal){
  if(!set)return null;
  const bound=Object.assign(new QuickReplySet(),set);
  bound.qrList=set.qrList.map(original=>{
    const qr=Object.assign(new QuickReply(),original);qr.onExecute=(_,options)=>executeBound(bound,qr,options,signal);return qr;
  });return bound;
}
function resolveConfig(config,signal){
  return {setList:Array.isArray(config?.setList)?config.setList.map(link=>({...link,set:bindSet(QuickReplySet.get(typeof link.set==='string'?link.set:link.set?.name),signal)})):[]};
}
function currentSettings(signal){
  const context=getContext(),value=extension_settings.quickReplyV2??{},character=context.characters?.[context.characterId];
  return {isEnabled:value.isEnabled===true&&!(Array.isArray(extension_settings.disabledExtensions)&&extension_settings.disabledExtensions.includes('quick-reply')),
    config:resolveConfig(value.config,signal),chatConfig:resolveConfig(context.chatMetadata?.quickReply,signal),
    charConfig:context.groupId?null:resolveConfig(value.characterConfigs?.[character?.avatar],signal)};
}
export async function executeQuickReplyByName(name,args={},options={}){
  if(!ready)await loadQuickReplies();
  // Named calls receive their parent's genuine slash controller through options.
  return createQuickReplyNamedExecutor(currentSettings())(name,args,options);
}
export async function runQuickReplyAutomation(method,entries,signal){
  if(!ready)return;
  const handler=new AutoExecuteHandler(currentSettings(signal));handler.preventAutoExecuteStack=preventAutoExecuteStack;
  await handler[method](entries);signal?.throwIfAborted();
}
export async function withQuickReplyWorldInfoSignal(entries,signal,operation){
  const previous=activationSignals.get(entries);activationSignals.set(entries,signal);
  try{return await operation();}finally{if(previous)activationSignals.set(entries,previous);else activationSignals.delete(entries);}
}
globalThis.executeQuickReplyByName=executeQuickReplyByName;
eventSource.on(event_types.WORLD_INFO_ACTIVATED,entries=>runQuickReplyAutomation('handleWIActivation',entries,activationSignals.get(entries)));
`;
