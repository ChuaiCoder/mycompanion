/** Project-owned invocation and cancellation adapter around the fixed upstream
 * ToolManager. The original registry, callbacks and slash commands run unchanged. */
export const toolRuntimeAdapterSource = String.raw`
import {ToolManager} from '/scripts/tool-calling.js';
import {getContext} from '/plugin-runtime/compat-runtime.js';
let initialized=false;
export {ToolManager};
export function initializeToolRuntime(){
  getContext().ToolManager=ToolManager;
  if(!initialized){ToolManager.initToolSlashCommands();initialized=true;}
}
async function abortable(work,signal){
  signal?.throwIfAborted();
  if(!signal)return work();
  let aborted;
  const stop=new Promise((_,reject)=>{
    aborted=()=>reject(signal.reason??new Error('工具执行已取消。'));
    signal.addEventListener('abort',aborted,{once:true});
  });
  try{const value=await Promise.race([Promise.resolve().then(work),stop]);signal.throwIfAborted();return value;}
  finally{signal.removeEventListener('abort',aborted);}
}
export async function registerNativeTools(type,data,settings,signal){
  initializeToolRuntime();signal?.throwIfAborted();
  if(data.json_schema||data.response_format?.type==='json_schema'||!ToolManager.canPerformToolCalls(type,settings,data.model))return;
  await abortable(()=>ToolManager.registerFunctionToolsOpenAI(data),signal);
}
export async function runToolEffect(event,signal){
  signal?.throwIfAborted();const calls=event.evaluation.payload.state?.toolCalls;
  if(!Array.isArray(calls)||calls.some(call=>!call?.id||!call.function?.name)||new Set(calls.map(call=>call.id)).size!==calls.length)
    throw new Error('模型返回了无效或重复的工具调用标识。');
  const result={invocations:[],stealthCalls:[],errors:[]};
  for(const call of calls){
    // One upstream invocation per ordinal retains its sequential behavior and
    // prevents a stopped callback from dispatching later tools in the batch.
    signal?.throwIfAborted();
    const one=await abortable(()=>ToolManager.invokeFunctionTools([[call]],{
      reasoningText:event.evaluation.payload.state.reasoning||null,
    }),signal);
    result.invocations.push(...one.invocations);result.stealthCalls.push(...one.stealthCalls);
    result.errors.push(...one.errors.map(error=>({message:error.message,cause:typeof error.cause==='string'?error.cause:undefined})));
  }
  signal?.throwIfAborted();return result;
}
`;
