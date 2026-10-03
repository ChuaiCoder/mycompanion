import { createWorldInfoRuntime } from "./world-info-upstream-runtime.js";

// The same extracted class runs in each realm. Only data/state crosses RPC.
export const worldInfoScannerBrowserSource = `import {parseRegexFromString} from '/plugin-runtime/world-info-data.js';\nexport ${createWorldInfoRuntime.toString()}\n`;
export const worldInfoEventsBrowserSource = String.raw`
import {eventSource,event_types} from '/plugin-runtime/compat-runtime.js';
import {encodeWorldInfoGraph,decodeWorldInfoGraph} from '/plugin-runtime/world-info-graph.js';
import {createWorldInfoRuntime} from '/plugin-runtime/world-info-scanner.js';
import {withQuickReplyWorldInfoSignal} from '/plugin-runtime/quick-reply.js';
const invocations=new Map();
const externalActivations=new Map();
eventSource.on(event_types.WORLDINFO_FORCE_ACTIVATE,entries=>{
  for(const entry of entries) {
    if(!Object.hasOwn(entry,'world')||!Object.hasOwn(entry,'uid'))console.error('[WI] WORLDINFO_FORCE_ACTIVATE requires all entries to have both world and uid fields, entry IGNORED',entry);
    else externalActivations.set(entry.world+'.'+entry.uid,entry);
  }
});
const getScope=call=>{
  let scopes=invocations.get(call.invocationId);if(!scopes){scopes=new Map();invocations.set(call.invocationId,scopes);}
  let scope=scopes.get(call.payload.scope);if(!scope){scope={objects:[]};scopes.set(call.payload.scope,scope);}return scope;
};
export function endWorldInfoInvocation(id){invocations.delete(id);}
export async function runWorldInfoEffect(event,signal,mountTimers) {
  signal.throwIfAborted();const call=event.evaluation,scope=getScope(call);
  if(call.kind==='world-info-start')return {graph:encodeWorldInfoGraph({externalActivations},scope.objects)};
  if(call.kind==='world-info-force'){await eventSource.emitWithSignal(signal,event_types.WORLDINFO_FORCE_ACTIVATE,call.payload.entries);return {};}
  if(call.kind==='world-info-end'){externalActivations.clear();return {};}
  if(call.kind==='world-info-activated'){
    const timers=mountTimers(call.payload.timedWorldInfo??{});
    await withQuickReplyWorldInfoSignal(call.payload.entries,signal,()=>eventSource.emitWithSignal(signal,event_types.WORLD_INFO_ACTIVATED,call.payload.entries));
    return {timedWorldInfo:structuredClone(timers)};
  }
  if(call.kind!=='world-info-scan')throw new Error('未知的世界书执行阶段：'+call.kind);
  const root=decodeWorldInfoGraph(call.payload.graph,scope.objects);
  root.metadata.timedWorldInfo=mountTimers(root.metadata.timedWorldInfo??{});
  if(!scope.runtime)scope.runtime=createWorldInfoRuntime({settings:call.payload.settings,metadata:root.metadata,console});
  if(!scope.timedEffects)scope.timedEffects=new scope.runtime.WorldInfoTimedEffects([],[],true);
  scope.timedEffects.__restoreForBridge(root.timedState);
  root.args.timedEffects=scope.timedEffects;
  try {await eventSource.emitWithSignal(signal,event_types.WORLDINFO_SCAN_DONE,root.args);}
  finally {delete root.args.timedEffects;}
  signal.throwIfAborted();
  root.timedState=scope.timedEffects.__snapshotForBridge();root.externalActivations=externalActivations;
  return {graph:encodeWorldInfoGraph(root,scope.objects)};
}
`;
