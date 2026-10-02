// Public Tavern assembly APIs publish macro effects at their own call boundary,
// not at a later provider request. No generation is inferred from string data.
export const macroApiSource = String.raw`
import {getContext,getRequestHeaders} from '/plugin-runtime/compat-runtime.js';
import {flushChatSaves,applyLocalMacroChanges,applyWorldInfoState} from '/plugin-runtime/chat.js';
import {saveSettings,applyGlobalMacroChanges} from '/plugin-runtime/settings.js';
import {readMacroResult} from '/plugin-runtime/macro-boundary.js';
let operations=Promise.resolve();
export function captureMacroApiTarget(){
  const context=getContext();
  return {conversationId:context.conversationId??null,branchId:context.branchId??null};
}
function assertTarget(target){
  const current=captureMacroApiTarget();
  if(current.conversationId!==target.conversationId || current.branchId!==target.branchId)
    throw new Error('故事已切换，请重新组装提示词。');
}
export async function requestMacroEvaluation(path,makePayload,target=captureMacroApiTarget()){
  // Save listeners and other extension callbacks run outside our RPC queue.
  // In particular, a WORLD_INFO_ACTIVATED listener may reenter this API.
  await flushChatSaves();await saveSettings();
  const operation=operations.catch(()=>{}).then(async()=>{
    assertTarget(target);
    const context=getContext();
    const response=await fetch(path,{method:'POST',headers:getRequestHeaders(),body:JSON.stringify({...makePayload(context),commitVariables:true,browserMacros:true})});
    const result=await readMacroResult(response);
    if(!response.ok)throw new Error(result?.error?.message || '无法求值扩展提示词：HTTP '+response.status);
    if(result.macroChanges?.length){
      applyLocalMacroChanges(target.conversationId,result.macroChanges);
      applyGlobalMacroChanges(result.macroChanges);
    }
    // The service has already committed these effects. Synchronize them first
    // (local deltas have their own story guard), but never publish a stale prompt
    // to a caller now displaying a different story or branch.
    assertTarget(target);
    if(result.worldInfoState)applyWorldInfoState(target,result.worldInfoState);
    return result;
  });
  operations=operation;
  return operation;
}
`;
