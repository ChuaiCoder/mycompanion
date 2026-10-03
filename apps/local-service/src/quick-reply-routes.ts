import type { FastifyInstance } from "fastify";
import type { RuntimeRepository } from "./runtime-repository.js";
import {deleteQuickReplyPreset,quickReplyPresets,saveQuickReplyPreset} from "./quick-reply-repository.js";
import {sendError} from "./http-errors.js";
export function registerQuickReplyRoutes(app:FastifyInstance,runtime:RuntimeRepository):void {
  app.get("/api/quick-replies/list",async(_request,reply)=>reply.header("Cache-Control","no-store").send(quickReplyPresets(runtime)));
  app.post<{Body:unknown}>("/api/quick-replies/save",async(request,reply)=>{
    const value=request.body;if(!value||typeof value!=="object"||Array.isArray(value)||typeof (value as any).name!=="string"||!(value as any).name.trim())
      return sendError(reply,400,"INVALID_QUICK_REPLY_SET","快捷回复集需要名称。");
    const data=value as Record<string,unknown>;
    if(!Array.isArray(data.qrList)&&!Array.isArray(data.quickReplySlots))return sendError(reply,400,"INVALID_QUICK_REPLY_SET","快捷回复集需要回复列表。");
    saveQuickReplyPreset(runtime,data);return reply.code(200).send();
  });
  app.post<{Body:unknown}>("/api/quick-replies/delete",async(request,reply)=>{
    const name=request.body&&typeof request.body==="object"?(request.body as any).name:undefined;
    if(typeof name!=="string"||!name.trim())return sendError(reply,400,"INVALID_QUICK_REPLY_SET","快捷回复集需要名称。");
    deleteQuickReplyPreset(runtime,name);return reply.code(200).send();
  });
}
