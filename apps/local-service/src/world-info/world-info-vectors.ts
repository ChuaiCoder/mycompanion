import type { ChatMessage } from "@mycompanion/shared";
import type { MacroEvaluationSession } from "../prompt/prompt-macros.js";
import type { EmbeddingSelection } from "../memory/semantic-memory.js";
import type { ScanEntry } from "./worldbook-engine.js";
import { createWorldInfoRuntime } from "../world-info-upstream-runtime.js";
import { createWorldInfoVectorRuntime, createVectorMultiQuery } from "../world-info-vector-upstream.js";
import { VectorCollectionSession, type VectorCollectionRepository } from "../providers/vector-collections.js";
import { EmbeddingRequestError } from "../providers/embedding-client.js";

export interface WorldInfoVectorSettings {enabled_world_info:boolean;enabled_for_all:boolean;query:number;max_entries:number;score_threshold:number}
export interface WorldInfoVectorActivation {entries:ScanEntry[];diagnostics:string[]}
const hash=createWorldInfoRuntime({settings:{},metadata:{}}).getStringHash as (value:string)=>number;
export function worldInfoVectorSettings(extensionSettings:Record<string,unknown>):WorldInfoVectorSettings {
  const value=extensionSettings.vectors&&typeof extensionSettings.vectors==="object"?extensionSettings.vectors as Record<string,unknown>:{};
  const number=(key:string,fallback:number)=>typeof value[key]==="number"&&Number.isFinite(value[key])?Number(value[key]):fallback;
  return {enabled_world_info:value.enabled_world_info===true&&!(Array.isArray(extensionSettings.disabledExtensions)&&extensionSettings.disabledExtensions.includes("vectors")),
    enabled_for_all:value.enabled_for_all===true,query:Math.max(0,Math.floor(number("query",2))),max_entries:Math.max(1,Math.floor(number("max_entries",5))),score_threshold:number("score_threshold",.25)};
}
/** Pinned getQueryText performs two real substitution occurrences per message;
 * its discarded hash pass is intentionally not coalesced with the text pass. */
export function worldInfoVectorQueryText(messages:ChatMessage[],settings:WorldInfoVectorSettings,session:MacroEvaluationSession,
  context:Parameters<MacroEvaluationSession["evaluate"]>[1]):Promise<string> {
  return createWorldInfoVectorRuntime({settings,getStringHash:hash,substituteParams:(value:string)=>session.evaluate(value,context),
    collapseNewlines:(value:string)=>value.replace(/\n+/g,"\n")}).getQueryText(messages.map(message=>({mes:message.content,extra:message.extensionData})),"world-info");
}
export async function activateWorldInfoVectors(collections:VectorCollectionRepository,settings:WorldInfoVectorSettings,entries:ScanEntry[],queryText:string,
  selection:EmbeddingSelection|null,signal:AbortSignal,unavailable=false):Promise<WorldInfoVectorActivation> {
  const result:WorldInfoVectorActivation={entries:[],diagnostics:[]};signal.throwIfAborted();
  if(!settings.enabled_world_info||!entries.some(entry=>entry.world&&!entry.disable&&entry.content&&(entry.vectorized||settings.enabled_for_all)))return result;
  if(unavailable){result.diagnostics.push("Embedding 配置或密钥不可用，本轮未执行世界书向量激活。");return result;}
  if(!selection){result.diagnostics.push("尚未为 Embedding 任务选择模型，本轮未执行世界书向量激活。");return result;}
  try {
    const session=new VectorCollectionSession(collections,selection,signal),queryMultipleCollections=createVectorMultiQuery(session);
    const runtime=createWorldInfoVectorRuntime({settings,queryText,getStringHash:hash,getSortedEntries:async()=>entries,
      getSavedHashes:async(id:string)=>session.list(id),insertVectorItems:(id:string,items:any[])=>session.insert(id,items),
      deleteVectorItems:async(id:string,hashes:number[])=>session.remove(id,hashes),queryMultipleCollections,
      forceActivate:async(activated:ScanEntry[])=>{signal.throwIfAborted();result.entries=activated;}});
    await runtime.activateWorldInfo([]);signal.throwIfAborted();
  }catch(error){
    signal.throwIfAborted();
    result.diagnostics.push(error instanceof EmbeddingRequestError&&error.code==="HTTP_ERROR"?`Embedding 服务拒绝了请求（HTTP ${error.status}），本轮未执行世界书向量激活。`
      :error instanceof EmbeddingRequestError&&error.code==="UNSUPPORTED_PROVIDER"?"所选连接不支持 Embedding，本轮未执行世界书向量激活。":"世界书向量索引或查询失败，本轮未执行向量激活。");
  }
  return result;
}
