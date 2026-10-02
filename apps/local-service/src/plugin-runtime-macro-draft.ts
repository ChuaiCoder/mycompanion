// Invocation-owned browser execution scope. Third-party closures/providers stay
// in their original realm; only draft values cross the loopback RPC boundary.
export const macroDraftSource = String.raw`
let depth = 0;
export const isMacroDraftActive = () => depth > 0;
export function runInMacroDraft(work) { depth++; try { return work(); } finally { depth--; } }
`;

export const macroBoundaryBrowserSource = String.raw`
import {getContext,substituteParams} from '/plugin-runtime/compat-runtime.js';
import {extension_settings} from '/plugin-runtime/settings.js';
import {power_user} from '/scripts/power-user.js';
import {oai_settings} from '/plugin-runtime/openai-settings.js';
import {withCharacterMacroSources} from '/plugin-runtime/script-data.js';
import {runInMacroDraft} from '/plugin-runtime/macro-draft.js';
const clone=value=>structuredClone(value);
const isRecord=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const restoreRecord=(record,descriptors)=>{
  for(const key of Reflect.ownKeys(record))if(!Object.hasOwn(descriptors,key))delete record[key];
  Object.defineProperties(record,descriptors);
};
const restoreProperty=(record,key,descriptor)=>{if(descriptor)Object.defineProperty(record,key,descriptor);else delete record[key];};
const installDraftTree=(record,draft,restorers,visited=new WeakSet())=>{
  visited.add(record);const before=Object.getOwnPropertyDescriptors(record),next=Object.getOwnPropertyDescriptors(draft);
  restorers.push(()=>restoreRecord(record,before));
  for(const key of Reflect.ownKeys(next)){
    const current=before[key]?.value,value=next[key].value;
    if(isRecord(current)&&isRecord(value)||Array.isArray(current)&&Array.isArray(value)){
      if(!visited.has(current)){installDraftTree(current,value,restorers,visited);next[key].value=current;}
    }
  }
  restoreRecord(record,next);
};
const escapeRegex=value=>String(value).replace(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/g, token=>
  ({'\n':'\\n','\r':'\\r','\t':'\\t','\v':'\\v','\f':'\\f','\0':'\\0'}[token]??'\\'+token));
export function evaluateBrowserMacro(event) {
  const context=getContext(),call=event.evaluation;
  if((context.conversationId??null)!==event.conversationId || (context.branchId??null)!==event.branchId)
    throw new Error('故事已切换，已取消旧请求的宏求值。');
  const names={name1:context.name1,name2:context.name2},metadata=context.chatMetadata,variables=extension_settings.variables;
  const variablesDescriptor=Object.getOwnPropertyDescriptor(extension_settings,'variables'),restorers=[];
  const mount=(owner,key,draft)=>{
    const descriptor=Object.getOwnPropertyDescriptor(owner,key),record=isRecord(owner[key])?owner[key]:{};
    restorers.push(()=>restoreProperty(owner,key,descriptor));
    installDraftTree(record,draft,restorers);
    Object.defineProperty(owner,key,{value:record,writable:true,enumerable:true,configurable:true});
  };
  const experimental=power_user.experimental_macro_engine,collapse=power_user.collapse_newlines;
  const provider={openai_max_context:oai_settings.openai_max_context,openai_max_tokens:oai_settings.openai_max_tokens};
  const draftLocal=clone(call.local),draftGlobal=clone(call.global),options=call.context??{};
  const modelField=oai_settings.chat_completion_source==='makersuite'?'google_model':String(oai_settings.chat_completion_source)+'_model';
  const modelDescriptor=Object.getOwnPropertyDescriptor(oai_settings,modelField);
  try {
    // Preserve imported chat_metadata and cached variable-map references. The
    // synchronous scope changes their values, then restores the same objects.
    const metadataRecord=isRecord(metadata)?metadata:{};
    context.chatMetadata=metadataRecord;mount(metadataRecord,'variables',draftLocal);
    const variablesRecord=isRecord(variables)?variables:{};
    Object.defineProperty(extension_settings,'variables',{value:variablesRecord,writable:true,enumerable:true,configurable:true});
    mount(variablesRecord,'global',draftGlobal);
    if(options.userName!==undefined)context.name1=options.userName;
    if(options.characterName!==undefined)context.name2=options.characterName;
    if(options.experimentalMacroEngine!==undefined)power_user.experimental_macro_engine=options.experimentalMacroEngine;
    if(call.environment?.collapseNewlines!==undefined)power_user.collapse_newlines=call.environment.collapseNewlines;
    if(options.contextLimitTokens!==undefined)oai_settings.openai_max_context=options.contextLimitTokens;
    if(options.maxResponseTokens!==undefined)oai_settings.openai_max_tokens=options.maxResponseTokens;
    if(options.model!==undefined)oai_settings[modelField]=options.model;
    const content=runInMacroDraft(()=>withCharacterMacroSources(call.environment?.characterFieldSources,()=>substituteParams(call.content,{
      name1Override:context.name1,name2Override:context.name2,replaceCharacterCard:options.replaceCharacterCard??true,
      ...(typeof options.original==='string'?{original:options.original}:{}),
      ...(options.escapeRegex?{postProcessFn:escapeRegex}:{}),
      ...(options.model?{dynamicMacros:{model:options.model}}:{}),
    })));
    return {content,local:clone(context.chatMetadata.variables??{}),global:clone(extension_settings.variables?.global??{})};
  } finally {
    for(const restore of restorers.reverse())restore();
    context.chatMetadata=metadata;restoreProperty(extension_settings,'variables',variablesDescriptor);Object.assign(context,names);
    power_user.experimental_macro_engine=experimental;power_user.collapse_newlines=collapse;Object.assign(oai_settings,provider);
    if(modelDescriptor)Object.defineProperty(oai_settings,modelField,modelDescriptor);else delete oai_settings[modelField];
  }
}
export async function respondToMacroRequest(event,signal) {
  signal?.throwIfAborted();
  let result,error;
  try {result=evaluateBrowserMacro(event);} catch(cause) {error=cause instanceof Error?cause.message:String(cause);}
  signal?.throwIfAborted();
  const response=await fetch('/api/generation/macros/'+encodeURIComponent(event.requestId),{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(error?{error}:{result}),...(signal?{signal}: {})});
  if(!response.ok)throw new Error((await response.json().catch(()=>null))?.error?.message||'宏求值已结束。');
  if(error)throw new Error(error);
}
export async function readMacroResult(response,signal) {
  if(!response.ok)throw new Error((await response.json().catch(()=>null))?.error?.message||'宏求值请求失败。');
  if(!response.headers.get('content-type')?.includes('text/event-stream'))return response.json();
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',result,finished=false;
  const aborted=()=>{void reader.cancel(signal.reason).catch(()=>{});};
  signal?.addEventListener('abort',aborted,{once:true});
  try {
    for(;;){signal?.throwIfAborted();const chunk=await reader.read();signal?.throwIfAborted();if(chunk.done){finished=true;break;}buffer+=decoder.decode(chunk.value,{stream:true});
      let delimiter;
      while((delimiter=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,delimiter);buffer=buffer.slice(delimiter+2);
        for(const line of frame.split('\n'))if(line.startsWith('data:')){const event=JSON.parse(line.slice(5));
          if(event.type==='macro_request')await respondToMacroRequest(event,signal);
          else if(event.type==='macro_result')result=event.result;
          else if(event.type==='error')throw new Error(event.message);
        }
      }
    }
    if(result===undefined)throw new Error('宏求值未返回结果。');return result;
  }finally{signal?.removeEventListener('abort',aborted);if(!finished)await reader.cancel().catch(()=>{});reader.releaseLock();}
}
`;
