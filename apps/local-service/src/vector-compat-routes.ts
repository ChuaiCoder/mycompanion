import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RuntimeRepository } from "./runtime-repository.js";
import type { SecretCodec } from "./route-types.js";
import { EmbeddingRequestError } from "./embedding-client.js";
import { VectorCollectionSession, VectorCollectionChangedError } from "./vector-collections.js";
import { createVectorMultiQuery } from "./world-info-vector-upstream.js";
import { sendError } from "./http-errors.js";
import type { EmbeddingSelection } from "./semantic-memory.js";

export function resolveVectorEmbeddingSelection(runtime: RuntimeRepository, secretCodec?: SecretCodec): EmbeddingSelection | undefined {
  const selected=runtime.resolveTaskProvider("embedding");if(!selected)return undefined;
  const encrypted=runtime.getEncryptedApiKey(selected.profileId);
  if(encrypted&&!secretCodec)throw new Error("系统安全存储不可用，无法读取 Embedding API Key。");
  let apiKey:string|undefined;
  if(encrypted){try{apiKey=secretCodec!.unseal(encrypted);}catch{throw new Error("已保存的 Embedding API Key 无法读取，请重新填写。");}}
  return {profileId:selected.profileId,settings:selected.settings,...(apiKey?{apiKey}:{})};
}
const collectionSchema=z.string().min(1).max(1000);
const itemSchema=z.object({hash:z.number().finite(),text:z.string(),index:z.union([z.string(),z.number().finite()])});
const listSchema=z.object({collectionId:collectionSchema}).passthrough();
const querySchema=listSchema.extend({searchText:z.string().min(1),topK:z.coerce.number().int().min(1).max(100_000).default(10),threshold:z.coerce.number().finite().default(0)});
const multiSchema=querySchema.omit({collectionId:true}).extend({collectionIds:z.array(collectionSchema)});

/** Tavern request/response shapes, using the user's assigned embedding profile.
 * Legacy source/model fields do not silently forward a different profile's key. */
export function registerVectorCompatibilityRoutes(app: FastifyInstance, runtime: RuntimeRepository, secretCodec?: SecretCodec): void {
  const shutdown=new AbortController();app.addHook("preClose",async()=>{shutdown.abort();});
  const route=<T>(path:string,schema:z.ZodType<T>,work:(value:T,session:VectorCollectionSession)=>Promise<unknown>|unknown,needsModel=true)=>{
    app.post<{Body:unknown}>("/api/vector/"+path,async(request,reply)=>{
      const parsed=schema.safeParse(request.body);if(!parsed.success)return sendError(reply,400,"INVALID_VECTOR_REQUEST","向量请求参数无效。");
      const controller=new AbortController(),closed=()=>{if(!reply.raw.writableFinished)controller.abort();};reply.raw.on("close",closed);
      const signal=AbortSignal.any([controller.signal,shutdown.signal]);
      try {
        let selection:EmbeddingSelection|undefined;
        try{if(needsModel)selection=resolveVectorEmbeddingSelection(runtime,secretCodec);}catch(error){return sendError(reply,503,"VECTOR_CREDENTIAL_UNAVAILABLE",(error as Error).message);}
        if(needsModel&&!selection)return sendError(reply,503,"VECTOR_MODEL_NOT_CONFIGURED","请在模型设置中为 Embedding 任务选择连接。");
        const session=selection?new VectorCollectionSession(runtime.vectorCollections,selection,signal):undefined;
        const result=await work(parsed.data,session!);signal.throwIfAborted();return result??{ok:true};
      }catch(error){
        if(signal.aborted)return sendError(reply,499,"VECTOR_REQUEST_CANCELLED","向量请求已取消。");
        if(error instanceof EmbeddingRequestError)return sendError(reply,error.status??502,"VECTOR_EMBEDDING_FAILED",
          error.code==="UNSUPPORTED_PROVIDER"?"所选连接不支持 Embedding。":error.code==="HTTP_ERROR"?`Embedding 服务拒绝了请求（HTTP ${error.status}）。`:"Embedding 服务没有返回有效向量。");
        if(error instanceof VectorCollectionChangedError)return sendError(reply,409,"VECTOR_COLLECTION_CHANGED",error.message);
        return sendError(reply,500,"VECTOR_OPERATION_FAILED","无法完成向量操作，请重试。");
      }finally{reply.raw.off("close",closed);}
    });
  };
  route("list",listSchema,(value,session)=>session.list(value.collectionId));
  route("insert",listSchema.extend({items:z.array(itemSchema)}),async(value,session)=>{await session.insert(value.collectionId,value.items);});
  route("delete",listSchema.extend({hashes:z.array(z.coerce.number().finite())}),(value,session)=>session.remove(value.collectionId,value.hashes));
  route("query-multi",multiSchema,(value,session)=>createVectorMultiQuery(session)(value.collectionIds,value.searchText,value.topK,value.threshold));
  route("query",querySchema,async(value,session)=>{
    const results=await createVectorMultiQuery(session)([value.collectionId],value.searchText,value.topK,value.threshold);
    return results[value.collectionId]??{hashes:[],metadata:[]};
  });
  route("purge",listSchema,value=>runtime.vectorCollections.purge(value.collectionId),false);
  route("purge-all",z.object({}).passthrough(),()=>runtime.vectorCollections.purge(),false);
}
