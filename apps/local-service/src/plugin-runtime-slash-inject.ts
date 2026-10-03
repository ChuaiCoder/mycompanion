// Original injection callbacks use the existing chat metadata and prompt store.
// Only per-invocation ownership and delayed execution cancellation live here.
export const slashInjectSource = String.raw`
import {getContext,subscribeHostContext,setExtensionPrompt,extension_prompt_types,extension_prompt_roles,eventSource,event_types} from '/plugin-runtime/compat-runtime.js';
import {saveMetadataDebounced} from '/plugin-runtime/chat.js';
import {SlashCommandAbortController} from '/scripts/slash-commands/SlashCommandAbortController.js';
import {createSlashCommandReturnHelper} from '/scripts/slash-commands/SlashCommandReturnHelper.js';
import {trackSlashExecution,sendSystemMessage} from '/plugin-runtime/slash-adapter.js';
import {runSlashPopupCommand} from '/plugin-runtime/slash-popup.js';
const ephemeralByKey=new Map();
const target=()=>JSON.stringify([getContext().conversationId??null,getContext().branchId??null]);
const forget=key=>{const entry=ephemeralByKey.get(key);if(!entry)return;entry.dispose();ephemeralByKey.delete(key);};
const forgetAll=()=>{for(const key of [...ephemeralByKey.keys()])forget(key);};
let restore;
let contextKey=target();
subscribeHostContext(()=>{
  const next=target();if(next===contextKey)return;
  const old=JSON.parse(contextKey),current=JSON.parse(next);contextKey=next;forgetAll();
  // Story changes emit CHAT_CHANGED below; a branch changes in the same story
  // still needs to recreate filters from that branch's canonical metadata.
  if(old[0]===current[0])restore?.();
});
window.addEventListener('pagehide',forgetAll);
export function initializeScriptInjects(callback){
  if(restore)return;restore=callback;
  eventSource.on(event_types.CHAT_CHANGED,()=>{forgetAll();restore();});
  restore();
}
function createFilter(closure,originalClosureToFilter){
  return async (evaluation={})=>{
    const controller=new SlashCommandAbortController(),origin=target();
    const signal=evaluation.signal;
    const aborted=()=>controller.abort('Injection filter evaluation stopped',true);
    const release=trackSlashExecution(controller);
    if(signal?.aborted)aborted();else signal?.addEventListener('abort',aborted,{once:true});
    try{
      // The pristine helper still owns copying, progress reset, execution,
      // boolean conversion and its error-to-false behavior. Each evaluation
      // supplies a fresh controller instead of inheriting a finished /inject.
      const scoped=Object.create(closure);
      scoped.getCopy=()=>{const copy=closure.getCopy();copy.abortController=controller;return copy;};
      if(controller.signal.aborted)return false;
      const value=await originalClosureToFilter(scoped)();
      return !controller.signal.aborted&&origin===target()&&value;
    }finally{signal?.removeEventListener('abort',aborted);release();}
  };
}
function dependencies(originalClosureToFilter){
  const origin=target();
  let currentKey;
  const listeners=[];
  const active=()=>origin===target();
  const dispose=()=>{for(const [name,listener] of listeners)eventSource.removeListener(name,listener);listeners.length=0;};
  const scopedEventSource={once(name,callback){
    const entry={dispose,origin};
    if(!currentKey)return;
    const previous=ephemeralByKey.get(currentKey);
    // Both original once registrations share this invocation. A later inject
    // with the same ID invalidates its old listener pair before creating one.
    if(previous&&previous.dispose!==dispose)forget(currentKey);
    ephemeralByKey.set(currentKey,entry);
    const key=currentKey;
    const listener=()=>{
      if(!active()||ephemeralByKey.get(key)?.dispose!==dispose){dispose();return;}
      forget(key);callback();
    };
    listeners.push([name,listener]);eventSource.on(name,listener);
  }};
  return {chat_metadata:getContext().chatMetadata,extension_prompt_types,extension_prompt_roles,event_types,getContext,
    setExtensionPrompt:(key,...args)=>{if(!active())return;forget(key);currentKey=key;setExtensionPrompt(key,...args);},
    saveMetadataDebounced:()=>{if(active())saveMetadataDebounced();},eventSource:scopedEventSource,
    closureToFilter:closure=>createFilter(closure,originalClosureToFilter),
    slashCommandReturnHelper:createSlashCommandReturnHelper({sendSystemMessage:(...args)=>{if(active())sendSystemMessage(...args);}})};
}
export function restoreScriptInjects(createCallbacks,originalClosureToFilter){
  return createCallbacks(dependencies(originalClosureToFilter)).processChatSlashCommands();
}
export function runScriptInjectCommand(name,args,value,createCallbacks,originalClosureToFilter){
  if(args._abortController?.signal.aborted)return '';
  if(!getContext().conversationId)throw new Error('Open a story before editing script injections');
  if(name==='listInjectsCallback')return runSlashPopupCommand(name,args,value,({callGenericPopup})=>{
    const bindings=dependencies(originalClosureToFilter);
    bindings.slashCommandReturnHelper=createSlashCommandReturnHelper({callGenericPopup,
      sendSystemMessage:(...options)=>{if(!args._abortController?.signal.aborted)sendSystemMessage(...options);}});
    return createCallbacks(bindings);
  });
  return createCallbacks(dependencies(originalClosureToFilter))[name](args,value);
}
`;
