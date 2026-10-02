import type { FastifyInstance } from "fastify";
import { updateProviderSettingsSchema } from "@mycompanion/shared";
import type { RuntimeRepository } from "./runtime-repository.js";

export function registerProviderPatchRoutes(app: FastifyInstance, runtime: RuntimeRepository): void {
  const properties = { model: {type:"string"}, baseUrl: {type:"string"}, temperature: {type:"number"}, maxTokens: {type:"integer"}, contextLimitTokens: {type:"integer"} };
  app.patch<{Body:{values:Record<string,unknown>;baseline:Record<string,unknown>}}>("/api/settings/provider/extension-patch", {
    schema:{body:{type:"object",required:["values","baseline"],properties:{
      values:{type:"object",properties,additionalProperties:false},baseline:{type:"object",properties,additionalProperties:false},
    }}},
  }, async (request,reply) => {
    const current = runtime.getProvider(), merged: Record<string,unknown> = {...current};
    const conflicts: string[] = [];
    for (const [key,value] of Object.entries(request.body.values)) {
      if (request.body.baseline[key] !== current[key as keyof typeof current]) conflicts.push(key);
      else merged[key] = value;
    }
    const parsed = updateProviderSettingsSchema.safeParse(merged);
    if (!parsed.success) return reply.status(400).send({error:{message:"扩展模型参数无效。",details:parsed.error.issues}});
    try {const url=new URL(parsed.data.baseUrl);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error();}
    catch {return reply.status(400).send({error:{message:"模型地址无效。"}});}
    // One synchronous read/validate/write sequence preserves unrelated fields
    // and credentials for the same target; newer values win field by field.
    return {provider:runtime.saveProvider(parsed.data),conflicts};
  });
}
