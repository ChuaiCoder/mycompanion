import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach,expect,it,vi } from "vitest";
import type { MemoryRecord, MemoryRetrievalReport } from "@mycompanion/shared";
import { buildApp } from "./app.js";
import { RuntimeRepository } from "./persistence/runtime-repository.js";
import { createTestCharacter } from "./testing/native-character.js";
import { parseSse,sseResponse,completionResponse } from "./testing/helpers.js";
import { countCompatibilityMessagesSync } from "./tokens/tokenizer-service.js";

const resources:Array<{app:ReturnType<typeof buildApp>;database:DatabaseSync;path:string}>=[];
afterEach(async()=>{for(const {app,database,path}of resources.splice(0)){await app.close();database.close();for(const suffix of["","-wal","-shm"])rmSync(path+suffix,{force:true});}});

it.each([false,true])("reports and marks only memories retained by the actual native request (new=%s)",async newEngine=>{
  const path=join(tmpdir(),`memory-retained-${randomUUID()}.sqlite`),app=buildApp({databasePath:path}),database=new DatabaseSync(path),runtime=new RuntimeRepository(database);
  resources.push({app,database,path});
  const character=await createTestCharacter(app,{ch_name:"Memory actor",first_mes:""});
  const story=(await app.inject({method:"POST",url:"/api/conversations",payload:{characterId:character.id}})).json();
  await app.inject({method:"PUT",url:"/api/extensions/settings",payload:{extensionSettings:{__mycompanion_power_user:{experimental_macro_engine:newEngine}}}});
  const provider={kind:"ollama",baseUrl:"http://provider.test/v1",model:"gpt-4o",contextLimitTokens:4096,maxTokens:128};
  await app.inject({method:"PUT",url:"/api/settings/provider",payload:provider});
  const make=(label:string,importance:number):MemoryRecord=>runtime.addMemory({id:randomUUID(),conversationId:story.id,characterId:character.id,type:"fact",
    content:`signal ${label} `+"detail ".repeat(40),scope:"story",importance,status:"active",pinned:false,manuallyEdited:true,sourceMessageIds:[],
    supersededBy:null,previousContent:null,createdAt:"2026-10-02T00:00:00.000Z",lastUsedAt:null});
  const high=make("HIGH_RELEVANCE",5),low=make("LOW_RELEVANCE",1);
  const retrieval=(await app.inject({method:"POST",url:`/api/conversations/${story.id}/memories/test`,payload:{input:"signal"}})).json() as MemoryRetrievalReport;
  expect(retrieval.results.filter(item=>item.injected).map(item=>item.memoryId)).toEqual([high.id,low.id]);
  const full=(await app.inject({method:"POST",url:`/api/conversations/${story.id}/prompt-preview`,payload:{draft:"signal"}})).json();
  await app.inject({method:"PUT",url:"/api/settings/provider",payload:{...provider,contextLimitTokens:full.totalTokens-10}});
  const requests:Array<{messages:Array<{role:string;content:string}>}>=[];
  vi.stubGlobal("fetch",async(_url:unknown,init?:RequestInit)=>{const body=JSON.parse(String(init?.body));if(body.stream)requests.push(body);return body.stream?sseResponse(["reply"]):completionResponse();});
  const response=await app.inject({method:"POST",url:`/api/conversations/${story.id}/messages`,payload:{content:"signal"}});
  expect(response.statusCode).toBe(200);const events=parseSse(response.body);
  expect(events.some(event=>event.type==="error")).toBe(false);expect(requests).toHaveLength(1);
  const report=events.find(event=>event.type==="memory")!.report as MemoryRetrievalReport;
  expect(report.results.filter(item=>item.injected).map(item=>item.memoryId)).toEqual([high.id]);
  expect(report.results.find(item=>item.memoryId===low.id)?.diagnostics.join(" ")).toContain("预算");
  expect(JSON.stringify(requests[0]!.messages)).toContain("HIGH_RELEVANCE");expect(JSON.stringify(requests[0]!.messages)).not.toContain("LOW_RELEVANCE");
  expect(runtime.getMemory(high.id)!.lastUsedAt).not.toBeNull();expect(runtime.getMemory(low.id)!.lastUsedAt).toBeNull();
  const exact={token_count:countCompatibilityMessagesSync(requests[0]!.messages as never,"gpt-4o",true)};
  const budget=events.find(event=>event.type==="prompt_budget")!.report as {totalTokens:number;reserveTokens:number};
  expect(budget.totalTokens).toBe(exact.token_count+budget.reserveTokens);
});
