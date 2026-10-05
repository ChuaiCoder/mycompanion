import { describe,expect,it } from "vitest";
import { tokenAccountingSchema,providerTokenUsageSchema } from "@mycompanion/shared";
import { accountCompletionTokens } from "./token-accounting.js";
import { imageTokenCost } from "./image-token-cost.js";
import { readProviderTokenUsage,providerInputDifference,sumProviderTokenUsages } from "./provider-usage.js";
import { measureChatCompletionRequest } from "./chat-completion-budget.js";

const image=(width:number,height:number)=>{
  // Authored header fixture; the header-only parser does not decode pixels.
  const buffer=Buffer.alloc(33);Buffer.from([137,80,78,71,13,10,26,10]).copy(buffer);buffer.writeUInt32BE(13,8);
  buffer.write("IHDR",12);buffer.writeUInt32BE(width,16);buffer.writeUInt32BE(height,20);
  return `data:image/png;base64,${buffer.toString("base64")}`;
};
describe("request accounting and provider usage boundaries",()=>{
  it("keeps separate multi-round sums complete without inventing omitted counters or overflowing",()=>{
    const first=readProviderTokenUsage({usage:{prompt_tokens:4,completion_tokens:2,total_tokens:6}},undefined,"openai")!;
    const last=readProviderTokenUsage({usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}},undefined,"openai")!;
    expect(sumProviderTokenUsages([first,last])).toEqual({source:"provider-reported",protocol:"openai",inputTokens:11,outputTokens:5,totalTokens:16});
    expect(sumProviderTokenUsages([first,undefined])).toBeUndefined();
    expect(sumProviderTokenUsages([first,{source:"provider-reported",inputTokens:7}])).toEqual({source:"provider-reported",inputTokens:11});
    expect(sumProviderTokenUsages([{source:"provider-reported",inputTokens:Number.MAX_SAFE_INTEGER},{source:"provider-reported",inputTokens:1}])).toBeUndefined();
    expect(last.inputTokens).toBe(7);
  });
  it("keeps known BPE and unknown-model/framing estimates distinct, including Harmony ordinary text",()=>{
    const known=accountCompletionTokens({model:"gpt-4o",messages:[{role:"user",content:"你好"}]});
    expect(tokenAccountingSchema.parse(known)).toMatchObject({estimated:true,textEstimated:false,framingEstimated:true,complete:true,reasons:["message-framing"]});
    expect(accountCompletionTokens({model:"gpt-oss-20b",messages:[{role:"user",content:"你好"}]})).toMatchObject({encoding:"o200k_base",textEstimated:false});
    const unknown=accountCompletionTokens({model:"a-local-model",messages:[{role:"user",content:"你好"}]});
    expect(unknown).toMatchObject({estimated:true,textEstimated:true});expect(unknown.reasons).toContain("unknown-model");
  });
  it("uses tile rules and model-specific low detail without fetching remote images or tokenizing Base64",()=>{
    expect(imageTokenCost({image_url:{url:image(1024,1024),detail:"high"}},"gpt-4o")).toMatchObject({tokens:765,complete:true});
    expect(imageTokenCost({image_url:{url:image(2048,4096),detail:"high"}},"gpt-4o")).toMatchObject({tokens:1105,complete:true});
    expect(imageTokenCost({image_url:{url:image(128,128),detail:"auto"}},"gpt-4o")).toMatchObject({tokens:255,complete:true});
    expect(imageTokenCost({image_url:{url:"https://private.invalid/secret",detail:"low"}},"gpt-4o-mini").tokens).toBe(2833);
    const remote=accountCompletionTokens({model:"gpt-4o",messages:[{role:"user",content:[{type:"image_url",image_url:{url:"https://private.invalid/secret",detail:"high"}}]}]});
    expect(remote).toMatchObject({complete:false,mediaTokens:1445});expect(remote.reasons).toContain("unknown-image-size");
    expect(JSON.stringify(remote)).not.toContain("private.invalid");
    expect(imageTokenCost({image_url:{url:image(1024,1024)}},"claude-opus")).toMatchObject({complete:false,reason:"unknown-image-model"});
    expect(imageTokenCost({image_url:{url:"data:image/webp;base64,aA=="}},"gpt-4o")).toMatchObject({complete:false});
  });
  it("uses the official patch examples and preserves model/detail sizing boundaries",()=>{
    const cost=(width:number,height:number,model:string,detail="high")=>imageTokenCost({image_url:{url:image(width,height),detail}},model);
    expect(cost(1024,1024,"gpt-6-astra")).toMatchObject({tokens:1229,complete:true});
    expect(cost(2048,2048,"gpt-6-astra")).toMatchObject({tokens:3000,complete:true});
    expect(cost(4096,512,"gpt-6-astra")).toMatchObject({tokens:2458,complete:true});
    expect(cost(2048,2048,"gpt-5.4","low").tokens).toBe(4916);
    expect(cost(2048,2048,"gpt-5.4","high").tokens).toBe(3000);
    expect(cost(1024,1024,"gpt-4.1-mini-2025-04-14").tokens).toBe(1659);
    expect(cost(1,65535,"gpt-6-astra").tokens).toBe(2458);
    expect(cost(128,128,"gpt-6-astra","low").tokens).toBe(20);
    expect(cost(128,128,"gpt-6-astra","auto").tokens).toBe(20);
    expect(cost(1024,1024,"gpt-4.1-mini","original")).toMatchObject({complete:false});
    expect(cost(1024,1024,"gpt-6-astra-unverified")).toMatchObject({complete:false,reason:"unknown-image-model"});
    expect(imageTokenCost({image_url:{url:"https://private.invalid/patch",detail:"high"}},"gpt-6-astra")).toMatchObject({tokens:3000,complete:false,reason:"unknown-image-size"});
  });
  it("measures the final model/body/reserve and publishes uncovered audio/tools/format approximations",()=>{
    const measured=measureChatCompletionRequest({model:"other",max_completion_tokens:100,stream:false,tools:[{type:"function",function:{name:"foo",parameters:{type:"object"}}}],
      response_format:{type:"json_object"},messages:[{role:"user",content:[{type:"text",text:"hello"},{type:"input_audio",input_audio:{data:"secret-base64",format:"wav"}}]}]},
      {kind:"openai-compatible",baseUrl:"http://localhost/v1",model:"saved",hasApiKey:false,temperature:1,maxTokens:200,contextLimitTokens:4096});
    expect(measured.totalTokens).toBe(measured.tokenAccounting.promptTokens+measured.reserveTokens);
    expect(measured.tokenAccounting).toMatchObject({model:"other",estimated:true,complete:false});
    expect(measured.tokenAccounting.reasons).toEqual(expect.arrayContaining(["audio-not-counted","tool-schema-estimate","response-format-estimate"]));
    expect(JSON.stringify(measured.tokenAccounting)).not.toContain("secret-base64");
  });
  it("includes actual native tool-result text while excluding image and audio base64 from text counting",()=>{
    const text="tool result ".repeat(6000);
    const claude=accountCompletionTokens({model:"claude-sonnet-4-6",messages:[{role:"user",content:[{type:"tool_result",tool_use_id:"call_a",content:text}]}]});
    const gemini=accountCompletionTokens({model:"gemini-2.5-flash",messages:[{role:"user",content:[{type:"provider_native",part:{functionResponse:{name:"weather",response:{result:text}}}}]}]});
    expect(claude.promptTokens).toBeGreaterThan(12000);expect(gemini.promptTokens).toBeGreaterThan(12000);
    expect(claude.complete).toBe(true);expect(gemini.complete).toBe(true);
    const media=(data:string)=>accountCompletionTokens({model:"gemini-2.5-flash",messages:[{role:"assistant",content:[{type:"provider_native",part:{inlineData:{mimeType:"audio/wav",data}}}]}]});
    expect(media("x").promptTokens).toBe(media("x".repeat(100000)).promptTokens);
    expect(media("x")).toMatchObject({complete:false,mediaEstimated:true,reasons:expect.arrayContaining(["audio-not-counted"])});
  });
  it("retains only valid provider-reported numeric usage across partial/cumulative frames",()=>{
    const first=readProviderTokenUsage({message:{usage:{input_tokens:40,cache_read_input_tokens:10,key:"private"}}});
    const final=readProviderTokenUsage({usage:{output_tokens:7}},first)!;
    expect(providerTokenUsageSchema.parse(final)).toEqual({source:"provider-reported",protocol:"claude",inputTokens:50,nonCachedInputTokens:40,outputTokens:7,cachedInputTokens:10});
    expect(readProviderTokenUsage({usage:{output_tokens:7}},final)).toEqual(final);
    expect(readProviderTokenUsage({usage:{input_tokens:-1,output_tokens:"8",total_tokens:Infinity,key:"private"}})).toBeUndefined();
    expect(readProviderTokenUsage({usageMetadata:{promptTokenCount:18,candidatesTokenCount:4,totalTokenCount:28,thoughtsTokenCount:6}}))
      .toEqual({source:"provider-reported",protocol:"gemini",inputTokens:18,outputTokens:10,candidatesOutputTokens:4,totalTokens:28,reasoningTokens:6});
    expect(readProviderTokenUsage({prompt_eval_count:12,eval_count:3})).toEqual({source:"provider-reported",protocol:"ollama",inputTokens:12,outputTokens:3});
    expect(readProviderTokenUsage({usage:{prompt_tokens:9,completion_tokens:2,total_tokens:11,prompt_tokens_details:{cached_tokens:3},completion_tokens_details:{reasoning_tokens:1}}}))
      .toEqual({source:"provider-reported",inputTokens:9,outputTokens:2,totalTokens:11,cachedInputTokens:3,reasoningTokens:1});
    expect(providerInputDifference(32,final)).toBe(18);expect(providerInputDifference(32,{source:"provider-reported",outputTokens:7})).toBeUndefined();
  });
  it("normalizes disjoint Claude cache counters without summing cumulative frames twice",()=>{
    const start=readProviderTokenUsage({type:"message_start",message:{usage:{input_tokens:40,cache_read_input_tokens:10,cache_creation_input_tokens:5}}})!;
    expect(start).toMatchObject({inputTokens:55,nonCachedInputTokens:40,cachedInputTokens:10,cacheCreationInputTokens:5});
    const updated=readProviderTokenUsage({type:"message_delta",usage:{input_tokens:null,cache_read_input_tokens:12,cache_creation_input_tokens:null,output_tokens:7}},start)!;
    expect(updated).toMatchObject({inputTokens:57,outputTokens:7,nonCachedInputTokens:40,cachedInputTokens:12,cacheCreationInputTokens:5});
    expect(readProviderTokenUsage({type:"message_delta",usage:{cache_read_input_tokens:12,output_tokens:7}},updated)).toEqual(updated);
    expect(readProviderTokenUsage({usage:{input_tokens:4}},undefined,"claude")).toMatchObject({protocol:"claude",inputTokens:4,nonCachedInputTokens:4});
    expect(readProviderTokenUsage({usage:{input_tokens:Number.MAX_SAFE_INTEGER,cache_read_input_tokens:1}},undefined,"claude")).not.toHaveProperty("inputTokens");
  });
  it("retains Gemini candidate, reasoning and server-tool counters without inventing a provider total",()=>{
    const start=readProviderTokenUsage({usageMetadata:{promptTokenCount:18,cachedContentTokenCount:8,candidatesTokenCount:4,thoughtsTokenCount:6,toolUsePromptTokenCount:3,totalTokenCount:31}})!;
    expect(start).toMatchObject({inputTokens:18,cachedInputTokens:8,outputTokens:10,candidatesOutputTokens:4,reasoningTokens:6,toolInputTokens:3,totalTokens:31});
    expect(readProviderTokenUsage({usageMetadata:{candidatesTokenCount:4,thoughtsTokenCount:6}},start)).toEqual(start);
    const noTotal=readProviderTokenUsage({usageMetadata:{candidatesTokenCount:0,thoughtsTokenCount:0}})!;
    expect(noTotal.outputTokens).toBe(0);expect(noTotal).not.toHaveProperty("totalTokens");
    expect(readProviderTokenUsage({usageMetadata:{candidatesTokenCount:Number.MAX_SAFE_INTEGER,thoughtsTokenCount:1}})).not.toHaveProperty("outputTokens");
  });
});
