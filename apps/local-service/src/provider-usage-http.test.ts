import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect,it } from "vitest";
import { buildApp } from "./app.js";
import { parseSse } from "./test-helpers.js";
import { createTestCharacter } from "./native-fixtures.js";
import { streamReply } from "./model-client.js";
import { promptBudgetReportSchema,chatMessageSchema,characterDetailSchema,lorebookReportSchema,memoryRetrievalReportSchema,type ProviderTokenUsage } from "@mycompanion/shared";

it("records a usage-only final HTTP SSE frame separately from local budget and persists safe numeric usage through restart/export",async()=>{
  const provider=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=JSON.parse(Buffer.concat(chunks).toString());
    if (!body.stream) {res.end(JSON.stringify({choices:[{message:{content:"[]"}}]}));return;}
    res.writeHead(200,{"Content-Type":"text/event-stream"});
    res.write('data: {"choices":[{"delta":{"content":"真实HTTP协议夹具回复"},"finish_reason":"stop"}]}\n\n');
    res.write('data: {"choices":[],"usage":{"prompt_tokens":29,"completion_tokens":5,"total_tokens":34,"prompt_tokens_details":{"cached_tokens":10},"unexpected_secret":"must-not-persist"}}\n\n');
    res.end("data: [DONE]\n\n");
  });
  provider.listen(0,"127.0.0.1");await once(provider,"listening");
  const folder=await mkdtemp(join(tmpdir(),"mycompanion-usage-")),databasePath=join(folder,"runtime.sqlite");
  let app=buildApp({databasePath});
  try {
    await app.inject({method:"PUT",url:"/api/settings/provider",payload:{kind:"openai-compatible",baseUrl:`http://127.0.0.1:${(provider.address() as {port:number}).port}/v1`,model:"gpt-4o",maxTokens:128,contextLimitTokens:4096}});
    const role=await createTestCharacter(app,{ch_name:"Usage protocol fixture",first_mes:"Hello"});
    const story=(await app.inject({method:"POST",url:"/api/conversations",payload:{characterId:role.id}})).json();
    const response=await app.inject({method:"POST",url:`/api/conversations/${story.id}/messages`,payload:{content:"请回答"}});
    const events=parseSse(response.body),budget=promptBudgetReportSchema.parse(events.find(event=>event.type==="prompt_budget")?.report);
    const accounting=budget.tokenAccounting!;
    expect(budget.tokenAccounting).toMatchObject({estimated:true,textEstimated:false,framingEstimated:true});
    expect(budget.totalTokens).toBe(accounting.promptTokens+budget.reserveTokens);
    const done=chatMessageSchema.parse(events.find(event=>event.type==="done")?.message);
    expect(done.generationMetadata).toMatchObject({usage:{source:"provider-reported",inputTokens:29,outputTokens:5,totalTokens:34,cachedInputTokens:10},tokenAccounting:budget.tokenAccounting});
    await app.close();app=buildApp({databasePath});
    const restored=(await app.inject({method:"GET",url:`/api/conversations/${story.id}`})).json();
    expect(restored.messages.find((item:{id:string})=>item.id===done.id).generationMetadata).toEqual(done.generationMetadata);
    const backup=await app.inject({method:"GET",url:"/api/backup"});
    expect(backup.body).toContain('"inputTokens":29');expect(backup.body).not.toContain("must-not-persist");
  } finally {await app.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));await rm(folder,{recursive:true,force:true});}
});

it("captures non-stream JSON usage and does not invent counters when a provider omits usage",async()=>{
  let includeUsage=true;
  const provider=createServer(async(req,res)=>{
    for await (const _chunk of req) { /* drain request */ }
    res.end(JSON.stringify({choices:[{message:{content:"非流式回复"},finish_reason:"stop"}],...(includeUsage?{usage:{prompt_tokens:17,completion_tokens:3,total_tokens:20}}:{})}));
  });
  provider.listen(0,"127.0.0.1");await once(provider,"listening");
  const app=buildApp();
  try {
    const settings={kind:"openai-compatible" as const,baseUrl:`http://127.0.0.1:${(provider.address() as {port:number}).port}/v1`,model:"gpt-4o",hasApiKey:false,temperature:1,maxTokens:128,contextLimitTokens:4096};
    const character=characterDetailSchema.parse(await createTestCharacter(app,{ch_name:"Nonstream usage fixture",first_mes:"Hello"}));
    const usage:ProviderTokenUsage[]=[];
    const options={settings,character,history:[],plugins:[],lorebook:lorebookReportSchema.parse({characterId:character.id,budgetTokens:128,results:[],block:"",position:"after_character_core",injectedCount:0,durationMs:0}),
      memory:memoryRetrievalReportSchema.parse({conversationId:crypto.randomUUID(),budgetTokens:300,pinnedBudgetTokens:300,results:[],block:"",position:"before_recent_messages",injectedCount:0,durationMs:0}),
      onRequest:async(request:Parameters<NonNullable<Parameters<typeof streamReply>[0]["onRequest"]>>[0])=>({...request,stream:false}),onDelta:()=>{},onUsage:(value:ProviderTokenUsage)=>usage.push(value)};
    await streamReply(options);expect(usage).toEqual([{source:"provider-reported",protocol:"openai",inputTokens:17,outputTokens:3,totalTokens:20}]);
    includeUsage=false;await streamReply(options);expect(usage).toHaveLength(1);
  } finally {await app.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));}
});
