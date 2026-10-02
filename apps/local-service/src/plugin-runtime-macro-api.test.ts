import {runInNewContext} from "node:vm";
import {expect,it,vi} from "vitest";
import {macroApiSource} from "./plugin-runtime-macro-api.js";

function deferred<T>(){
  let resolve!:(value:T)=>void;
  const promise=new Promise<T>(done=>{resolve=done;});
  return {promise,resolve};
}

it.each(["conversationId","branchId"])("rejects a late macro result after %s changes, while synchronizing committed deltas",async field=>{
  const context={conversationId:"story-A",branchId:"branch-A"};
  const response=deferred<unknown>(),started=deferred<void>();
  const changes=[{scope:"global",key:"count",before:0,after:1}];
  const local=vi.fn(),global=vi.fn(),worldInfo=vi.fn();
  const api=runInNewContext(macroApiSource.replace(/^import .*;\r?\n/gm,"").replace(/^export /gm,"")+
    "\n;({requestMacroEvaluation})",{
    getContext:()=>context,getRequestHeaders:()=>({}),flushChatSaves:async()=>{},saveSettings:async()=>{},
    applyLocalMacroChanges:local,applyGlobalMacroChanges:global,applyWorldInfoState:worldInfo,
    readMacroResult:(reply:{json:()=>Promise<unknown>})=>reply.json(),
    fetch:async()=>({ok:true,json:()=>{started.resolve();return response.promise;}}),
  });
  const request=api.requestMacroEvaluation("/api/worldinfo/prompt",()=>({}));
  const rejected=expect(request).rejects.toThrow("故事已切换");
  await started.promise;
  context[field as keyof typeof context]="other";
  response.resolve({macroChanges:changes,worldInfoState:{timedWorldInfo:{sticky:{accepted:true}}},report:{block:"old story content"}});
  await rejected;
  expect(local).toHaveBeenCalledWith("story-A",changes);
  expect(global).toHaveBeenCalledWith(changes);
  expect(worldInfo).not.toHaveBeenCalled();
  // A rejected old operation must not poison the next story's queue.
  const recovered=await api.requestMacroEvaluation("/api/worldinfo/prompt",()=>({}));
  expect(recovered.report.block).toBe("old story content");
  expect(worldInfo).toHaveBeenCalledWith({conversationId:context.conversationId,branchId:context.branchId},{timedWorldInfo:{sticky:{accepted:true}}});
});
