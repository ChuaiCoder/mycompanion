import type { NativeCompletionRequest, TokenAccounting } from "@mycompanion/shared";
import { countCompatibilityMessagesSync, countTextTokens, tokenizerDescriptor } from "./tokenizer-service.js";
import { contentTokenCost } from "./content-token-cost.js";

/** Keeps ST's token-count API/admission convention; publishes every known
 * approximation instead of presenting a BPE lookup as exact billed usage. */
export function accountCompletionTokens(request: Pick<NativeCompletionRequest,"model"|"messages"> & Record<string,unknown>): TokenAccounting {
  const descriptor = tokenizerDescriptor(request.model);
  const reasons = new Set<TokenAccounting["reasons"][number]>(["message-framing"]);
  if (!descriptor.knownModel) reasons.add("unknown-model");
  else if (descriptor.estimated) reasons.add("unsupported-text-encoding");
  let mediaTokens=0,complete=true,mediaEstimated=false;
  for (const message of request.messages) if (Array.isArray(message.content)) {
    const cost=contentTokenCost(message.content,request.model,text=>countTextTokens(text,request.model));
    mediaTokens+=cost.mediaTokens;mediaEstimated ||= cost.mediaEstimated;complete &&= cost.complete;
    for(const reason of cost.reasons)reasons.add(reason);
  }
  let promptTokens=countCompatibilityMessagesSync(request.messages,request.model,true);
  for (const key of ["tools","response_format"] as const) if (request[key]) {
    promptTokens+=countTextTokens(JSON.stringify(request[key]),request.model);
    reasons.add(key==="tools" ? "tool-schema-estimate" : "response-format-estimate");
  }
  return {method:"tavern-compatibility",model:request.model,encoding:descriptor.encoding,estimated:true,textEstimated:descriptor.estimated,
    framingEstimated:true,mediaEstimated,complete,promptTokens,mediaTokens,reasons:[...reasons]};
}
