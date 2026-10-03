import { createServer, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { toExtensionChatState } from "@mycompanion/shared";
import { buildApp } from "./app.js";
import { decodeProviderReply, readProviderStream } from "./provider-response.js";
import { createToolTestRuntime } from "./tool-test-runtime.js";

const cleanups: Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
const sse=(value:unknown)=>`data: ${JSON.stringify(value)}\n\n`;
const usage={prompt_tokens:11,completion_tokens:7,total_tokens:18};
const frames=[
  {choices:[{index:1,delta:{content:"B1",reasoning_content:"BR"}},{index:0,delta:{content:"A1",reasoning_content:"AR"}}]},
  {choices:[{index:0,delta:{content:"A2"},finish_reason:"stop"},{index:1,delta:{content:"B2"},finish_reason:"length"}]},
  {choices:[],usage},
];
const jsonReply={choices:[{index:1,message:{content:"B",reasoning_content:"BR"},finish_reason:"length"},
  {index:0,message:{content:"A",reasoning_content:"AR"},finish_reason:"stop"}],usage};
const infoKey="__mycompanion_native_candidate";
const infos=(message:any)=>message.extensionData?.swipe_info?.map((entry:any)=>entry.extra?.[infoKey]);

async function fixture(reply:(ordinal:number,response:ServerResponse,body:any)=>void){
  const requests:any[]=[],background:any[]=[];
  const provider=createServer(async(request,response)=>{
    const bytes:Buffer[]=[];for await(const chunk of request)bytes.push(Buffer.from(chunk));
    const body=JSON.parse(Buffer.concat(bytes).toString());
    if(body.n!==2){background.push(body);response.writeHead(200,{"Content-Type":"application/json"});response.end(JSON.stringify({choices:[{index:0,message:{content:"[]"},finish_reason:"stop"}]}));return;}
    requests.push(body);reply(requests.length,response,body);
  });
  await new Promise<void>(accept=>provider.listen(0,"127.0.0.1",accept));
  cleanups.push(()=>new Promise<void>(accept=>{provider.closeAllConnections();provider.close(()=>accept());}));
  const folder=await mkdtemp(join(tmpdir(),"mycompanion-native-candidates-"));cleanups.push(()=>rm(folder,{recursive:true,force:true}));
  const databasePath=join(folder,"runtime.sqlite");
  let app=buildApp({databasePath}),base=await app.listen({host:"127.0.0.1",port:0});cleanups.push(()=>app.close());
  await app.inject({method:"PUT",url:"/api/settings/provider",payload:{kind:"openai-compatible",baseUrl:`http://127.0.0.1:${(provider.address()as{port:number}).port}/v1`,model:"gpt-4o",maxTokens:128,contextLimitTokens:8192}});
  const avatar=(await app.inject({method:"POST",url:"/api/characters/create",payload:{ch_name:"Native candidates",first_mes:"Hello"}})).body;
  const character=(await app.inject({method:"POST",url:"/api/characters/get",payload:{avatar_url:avatar}})).json();
  const story=(await app.inject({method:"POST",url:"/api/conversations",payload:{characterId:character.id}})).json();
  const read=async()=> (await app.inject({url:`/api/conversations/${story.id}`})).json();
  const tools=createToolTestRuntime();
  const send=async(options:{stream?:boolean;event?:(event:any)=>Promise<void>;tools?:boolean}={})=>{
    const response=await fetch(`${base}/api/conversations/${story.id}/messages`,{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({content:"next",browserPreflight:true}),signal:AbortSignal.timeout(15000)});
    expect(response.status).toBe(200);
    const reader=response.body!.getReader(),decoder=new TextDecoder(),events:any[]=[];let buffer="";
    try{for(;;){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});
      for(let index;(index=buffer.indexOf("\n\n"))>=0;){const raw=buffer.slice(0,index);buffer=buffer.slice(index+2);if(!raw.startsWith("data: "))continue;
        const event=JSON.parse(raw.slice(6));events.push(event);
        if(event.type==="completion_request"){
          const request={...event.request,n:2,stream:options.stream!==false,chat_completion_source:"custom"};
          if(options.tools)await tools.ToolManager.registerFunctionToolsOpenAI(request);
          expect((await app.inject({method:"POST",url:`/api/generation/preflight/${event.requestId}`,payload:{request}})).statusCode).toBe(200);
        }else if(event.type==="effect_request"){
          const payload=await tools.run(event.evaluation,AbortSignal.timeout(3000));
          expect((await app.inject({method:"POST",url:`/api/generation/effects/${event.requestId}`,payload:{result:{payload,local:event.evaluation.local,global:event.evaluation.global}}})).statusCode).toBe(200);
        }
        await options.event?.(event);
      }
    }}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    return {events,message:events.find(event=>event.type==="done")?.message};
  };
  const save=async(state:any,next:any)=>app.inject({method:"PUT",url:`/api/conversations/${story.id}/extension-state`,payload:{branchId:story.activeBranchId,base:state,next}});
  return {requests,background,read,send,save,tools,databasePath,get app(){return app;},get base(){return base;},story,
    restart:async()=>{await app.close();app=buildApp({databasePath});base=await app.listen({host:"127.0.0.1",port:0});}};
}
const endStream=(response:ServerResponse,values:unknown[]=frames)=>{response.writeHead(200,{"Content-Type":"text/event-stream"});response.end(values.map(sse).join("")+"data: [DONE]\n\n");};

it.each([false,true])("selects choice index zero and saves both actual HTTP candidates with per-choice finish: stream=%s",async stream=>{
  const f=await fixture((_ordinal,response)=>stream?endStream(response):(response.writeHead(200,{"Content-Type":"application/json"}),response.end(JSON.stringify(jsonReply))));
  const {message,events}=await f.send({stream});
  expect(message).toMatchObject({status:"complete",content:stream?"A1A2":"A",extensionData:{swipes:stream?["A1A2","B1B2"]:["A","B"],swipe_id:0},
    generationMetadata:{responseState:{reasoning:"AR"},finishReason:"stop",completionOutcome:"complete",usage:{inputTokens:11,outputTokens:7,totalTokens:18}}});
  expect(infos(message)).toMatchObject([{index:0,responseState:{reasoning:"AR"},completionOutcome:"complete"},{index:1,responseState:{reasoning:"BR"},finishReason:"length",completionOutcome:"truncated"}]);
  expect(infos(message).some((info:any)=>info.usage||info.tokenAccounting)).toBe(false);
  expect(events.filter(event=>event.type==="delta").map(event=>event.delta).join("")).toBe(stream?"A1A2":"A");
  expect((await f.read()).messages.at(-1)).toEqual(message);
  const db=new DatabaseSync(f.databasePath,{readOnly:true});try{const row=db.prepare("SELECT content,extension_data_json,generation_json FROM messages WHERE id=?").get(message.id)!;
    expect(row.content).toBe(message.content);expect(JSON.parse(String(row.extension_data_json))).toEqual(message.extensionData);expect(JSON.parse(String(row.generation_json))).toEqual(message.generationMetadata);
  }finally{db.close();}
  expect(f.requests[0].n).toBe(2);const backup=(await f.app.inject({url:"/api/backup"})).json();expect(backup.conversations[0].messages.at(-1).extensionData).toEqual(message.extensionData);
  await f.restart();expect((await f.read()).messages.at(-1)).toEqual(message);
});

it.each([false,true])("does not select a nonzero-only candidate or extract success memory: stream=%s",async stream=>{
  const f=await fixture((_ordinal,response)=>stream?endStream(response,[{choices:[{index:1,delta:{content:"only B"},finish_reason:"stop"}]}]):
    (response.writeHead(200,{"Content-Type":"application/json"}),response.end(JSON.stringify({choices:[{index:1,message:{content:"only B"},finish_reason:"stop"}]}))));
  const {message,events}=await f.send({stream});expect(message.status).toBe("failed");expect(message.content).not.toBe("only B");
  expect(message.extensionData.swipes).toEqual(["only B"]);expect(message.extensionData.swipe_id).toBe(-1);
  expect(infos(message)).toMatchObject([{index:1,status:"failed"}]);expect(events.filter(event=>event.type==="delta")).toEqual([]);expect(f.background).toEqual([]);
});

it("keeps sparse indexes separate and survives a late bad JSON frame without tools or success jobs",async()=>{
  const f=await fixture((ordinal,response)=>{if(ordinal>1){endStream(response);return;}
    response.writeHead(200,{"Content-Type":"text/event-stream"});response.end(sse({choices:[{index:5,delta:{content:"sparse B",reasoning:"BR"}},{index:0,delta:{content:"partial A",reasoning:"AR"}}]})+
      'data: {"private":"NATIVE_N_PRIVATE_BAD_FRAME",\n\n'+sse({choices:[{index:0,delta:{content:"must not keep"}}]})+"data: [DONE]\n\n");
  });
  const {message,events}=await f.send();expect(message).toMatchObject({status:"failed",content:"partial A",extensionData:{swipes:["partial A","sparse B"],swipe_id:0}});
  expect(infos(message)).toMatchObject([{index:0,status:"failed"},{index:5,status:"failed"}]);expect(JSON.stringify(events)).not.toContain("NATIVE_N_PRIVATE_BAD_FRAME");
  expect(JSON.stringify(message)).not.toContain("must not keep");expect(f.background).toEqual([]);
  expect((await f.send()).message.content).toBe("A1A2");
});

it("stops both partial candidates and merges latest plugin variables/unknown fields before final save",async()=>{
  const f=await fixture((_ordinal,response)=>{response.writeHead(200,{"Content-Type":"text/event-stream"});response.write(sse({choices:[{index:1,delta:{content:"partial B"}},{index:0,delta:{content:"partial A"}}]}));});
  let saved=false;
  const {message}=await f.send({event:async event=>{if(event.type!=="delta"||saved)return;saved=true;
    const base=toExtensionChatState(await f.read()),next=structuredClone(base);next.messages.at(-1)!.extra={variables:{keep:"latest"},unknown:{nested:true}};
    next.messages.at(-1)!.swipe_info=[{extra:{[infoKey]:{index:0},variables:{keep:"stale"},oldUnknown:true}}];
    expect((await f.save(base,next)).statusCode).toBe(200);
    expect((await f.app.inject({method:"POST",url:`/api/conversations/${f.story.id}/generation/stop`})).statusCode).toBe(200);
  }});
  expect(message).toMatchObject({status:"stopped",content:"partial A",extensionData:{swipes:["partial A","partial B"],swipe_id:0,extra:{variables:{keep:"latest"},unknown:{nested:true},oldUnknown:true}}});
  expect(infos(message)).toMatchObject([{index:0,status:"stopped"},{index:1,status:"stopped"}]);expect(f.background).toEqual([]);
});

it("runs only zero's same-ordinal tool, keeps final-round candidates and cannot replay zero's tools from alternate selection",async()=>{
  const f=await fixture((ordinal,response)=>{if(ordinal===1){endStream(response,[{choices:[
    {index:1,delta:{content:"B preface",tool_calls:[{index:0,id:"same",function:{name:"echo",arguments:'{"value":"B"}'}}]},finish_reason:"tool_calls"},
    {index:0,delta:{content:"A preface",tool_calls:[{index:0,id:"same",function:{name:"echo",arguments:'{"value":"A"}'}}]},finish_reason:"tool_calls"}]}]);}else endStream(response);});
  const executed:string[]=[];f.tools.ToolManager.registerFunctionTool({name:"echo",description:"echo",parameters:{type:"object",properties:{value:{type:"string"}}},action:({value}:{value:string})=>{executed.push(value);return value;}});
  const {message}=await f.send({tools:true});expect(executed).toEqual(["A"]);expect(message.content).toBe("A1A2");expect(message.extensionData.swipes).toEqual(["A1A2","B1B2"]);
  expect(message.generationMetadata.toolRounds).toHaveLength(1);expect(infos(message)[1].responseState.toolCalls).toEqual([]);
  const base=toExtensionChatState(await f.read()),next=structuredClone(base),last=next.messages.at(-1)!;
  last.swipe_id=1;last.mes="B1B2";last.extra=(last.swipe_info as any[])[1].extra;
  // Projection-only fields cannot forge host billing or native generation state.
  last.generationMetadata={usage:{source:"provider-reported",totalTokens:999999},model:"forged"};last.status="complete";
  expect((await f.save(base,next)).statusCode).toBe(200);
  const selected=(await f.read()).messages.at(-1);expect(selected.generationMetadata.model).toBe("gpt-4o");expect(selected.generationMetadata.usage.totalTokens).toBe(18);
  expect(selected.generationMetadata.responseState.reasoning).toBe("BR");expect(selected.generationMetadata.completionOutcome).toBe("truncated");
  expect(selected.extensionData.generationMetadata).toBeUndefined();
  await f.send();const wire=f.requests.at(-1).messages;expect(wire.some((entry:any)=>entry.role==="tool"||entry.tool_calls?.length)).toBe(false);
});

it("separates two choices' reasoning/media/call indexes and releases malformed streams while exposing partial snapshots",async()=>{
  const reply=decodeProviderReply("openai",jsonReply,{n:2});expect(reply.text).toBe("A");
  const snapshots:any[]=[];let cancelled=false;
  const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode(sse({choices:[
    {index:1,delta:{content:"B",reasoning:"BR",audio:{data:"Qg==",format:"wav"},tool_calls:[{index:0,id:"b",function:{name:"echo",arguments:'{"b":1}'}}]}},
    {index:0,delta:{content:"A",reasoning:"AR",audio:{data:"QQ==",format:"wav"},tool_calls:[{index:0,id:"a",function:{name:"echo",arguments:'{"a":1}'}}]}}]})+'data: invalid\n\n'));},cancel(){cancelled=true;}});
  await expect(readProviderStream("openai",new Response(stream),{n:2,onDelta:()=>{},onCandidates:(values:any)=>snapshots.push(values)}as any)).rejects.toThrow("模型返回了不兼容的响应格式。");
  expect(snapshots.at(-1)).toMatchObject([{index:0,content:"A",responseState:{reasoning:"AR",toolCalls:[{id:"a"}],media:[{data:"QQ=="}]}},
    {index:1,content:"B",responseState:{reasoning:"BR",toolCalls:[{id:"b"}],media:[{data:"Qg=="}]}}]);
  expect(cancelled).toBe(true);expect(stream.locked).toBe(false);
});

it("retains received JSON candidates on invalid zero tool arguments, executes no callback and recovers",async()=>{
  const f=await fixture((ordinal,response)=>{if(ordinal>1){endStream(response);return;}
    response.writeHead(200,{"Content-Type":"application/json"});response.end(JSON.stringify({choices:[
      {index:1,message:{content:"B intact"},finish_reason:"stop"},
      {index:0,message:{content:"A intact",tool_calls:[{id:"a",type:"function",function:{name:"echo",arguments:"invalid"}}]},finish_reason:"tool_calls"}],usage}));});
  let executed=0;f.tools.ToolManager.registerFunctionTool({name:"echo",description:"echo",parameters:{type:"object"},action:()=>{executed++;return "never";}});
  const {message}=await f.send({stream:false,tools:true});expect(message).toMatchObject({status:"failed",content:"A intact",extensionData:{swipes:["A intact","B intact"]}});
  expect(infos(message)).toMatchObject([{index:0,status:"failed"},{index:1,status:"failed"}]);expect(executed).toBe(0);expect(f.background).toEqual([]);
  expect((await f.send()).message.content).toBe("A1A2");
});

it("does not invent candidates from an unfinished JSON response when stopped and permits the next send",async()=>{
  let open:ServerResponse|undefined;
  const f=await fixture((ordinal,response)=>{if(ordinal>1){endStream(response);return;}open=response;
    response.writeHead(200,{"Content-Type":"application/json"});response.write('{"choices":[{"index":1,"message":{"content":"not parsed yet"}}');});
  const pending=f.send({stream:false});
  for(let attempt=0;attempt<100&&!open;attempt++)await new Promise(accept=>setTimeout(accept,5));
  expect(open).toBeDefined();expect((await f.app.inject({method:"POST",url:`/api/conversations/${f.story.id}/generation/stop`})).statusCode).toBe(200);
  const {message}=await pending;expect(message).toMatchObject({status:"stopped",content:""});expect(message.extensionData?.swipes).toBeUndefined();expect(f.background).toEqual([]);
  expect((await f.send()).message.content).toBe("A1A2");
});

it.each([undefined,-1,1.5,"1"])("rejects an ambiguous or invalid multiple-choice index %s without selecting its text",async index=>{
  const f=await fixture((_ordinal,response)=>endStream(response,[{choices:[{...(index===undefined?{}:{index}),delta:{content:"invalid candidate"}}]}]));
  const {message,events}=await f.send();expect(message.status).toBe("failed");expect(events.filter(event=>event.type==="delta")).toEqual([]);
  expect(f.background).toEqual([]);expect(JSON.stringify(message)).not.toContain("invalid candidate");
});

it("preserves both partial candidates when EOF interrupts selected zero, including a completed nonselected choice",async()=>{
  const f=await fixture((_ordinal,response)=>{response.writeHead(200,{"Content-Type":"text/event-stream"});response.end(sse({choices:[
    {index:1,delta:{content:"B finished"},finish_reason:"stop"},{index:0,delta:{content:"A partial"}}]}));});
  const {message}=await f.send();expect(message).toMatchObject({status:"failed",content:"A partial",extensionData:{swipes:["A partial","B finished"]}});
  expect(infos(message)).toMatchObject([{index:0,status:"failed",finishReason:"eof",completionOutcome:"incomplete"},
    {index:1,status:"failed",finishReason:"stop",completionOutcome:"complete"}]);expect(f.background).toEqual([]);
});

it("clears native replay state after manual editing or invalid candidate info, while preserving request billing",async()=>{
  const f=await fixture((_ordinal,response)=>endStream(response));const {message}=await f.send();
  let base=toExtensionChatState(await f.read()),next=structuredClone(base),last=next.messages.at(-1)!;
  last.mes="edited A";(last.swipes as string[])[0]="edited A";
  expect((await f.save(base,next)).statusCode).toBe(200);
  let saved=(await f.read()).messages.at(-1);expect(saved.generationMetadata.responseState).toBeUndefined();
  expect(saved.generationMetadata.finishReason).toBeUndefined();expect(saved.generationMetadata.completionOutcome).toBeUndefined();expect(saved.generationMetadata.usage.totalTokens).toBe(18);
  base=toExtensionChatState(await f.read());next=structuredClone(base);last=next.messages.at(-1)!;
  last.swipe_id=1;last.mes="B1B2";(last.swipe_info as any[])[1].extra[infoKey]={version:1,index:1,responseState:{protocol:"openai",media:"bad"}};
  expect((await f.save(base,next)).statusCode).toBe(200);saved=(await f.read()).messages.at(-1);
  expect(saved.generationMetadata.responseState).toBeUndefined();expect(saved.generationMetadata.completionOutcome).toBeUndefined();expect(saved.generationMetadata.usage.totalTokens).toBe(18);
});

it.each([false,true])("transforms each successful candidate once in index order and commits output macros with latest message extras (experimental=%s)",async experimental=>{
  const f=await fixture((_ordinal,response)=>endStream(response));
  await f.app.inject({method:"PUT",url:"/api/extensions/settings",payload:{extensionSettings:{
    regex:[{placement:[2],findRegex:"/^(?:A1A2|B1B2)$/",replaceString:"{{incvar::out}}/{{incglobalvar::out}}"}],
    __mycompanion_power_user:{experimental_macro_engine:experimental},variables:{global:{}},
  }}});
  let edited=false;
  const {message}=await f.send({event:async event=>{if(event.type!=="delta"||edited)return;edited=true;
    const base=toExtensionChatState(await f.read()),next=structuredClone(base);next.messages.at(-1)!.extra={variables:{keep:"latest"},unknown:{preserved:true}};
    expect((await f.save(base,next)).statusCode).toBe(200);
  }});
  expect(message).toMatchObject({content:"1/1",extensionData:{swipes:["1/1","2/2"],extra:{variables:{keep:"latest"},unknown:{preserved:true}}}});
  expect(infos(message).map((info:any)=>info.originalContent)).toEqual(["1/1","2/2"]);
  expect(String((await f.read()).chatMetadata.variables.out)).toBe("2");
  expect(String((await f.app.inject({url:"/api/extensions/settings"})).json().extensionSettings.variables.global.out)).toBe("2");
});

it("rolls back all candidate output macro effects when final storage fails, retaining original provider partials",async()=>{
  const f=await fixture((_ordinal,response)=>endStream(response));
  await f.app.inject({method:"PUT",url:"/api/extensions/settings",payload:{extensionSettings:{
    regex:[{placement:[2],findRegex:"/^(?:A1A2|B1B2)$/",replaceString:"{{incvar::out}}/{{incglobalvar::out}}"}],
    __mycompanion_power_user:{experimental_macro_engine:true},variables:{global:{}},
  }}});
  const database=new DatabaseSync(f.databasePath);database.exec("CREATE TRIGGER reject_candidate_complete BEFORE UPDATE ON messages WHEN NEW.role='assistant' AND NEW.status='complete' BEGIN SELECT RAISE(ABORT,'controlled candidate storage failure'); END");
  try{
    const {message}=await f.send();expect(message).toMatchObject({status:"failed",content:"A1A2",extensionData:{swipes:["A1A2","B1B2"]}});
    expect((await f.read()).chatMetadata?.variables?.out).toBeUndefined();
    expect((await f.app.inject({url:"/api/extensions/settings"})).json().extensionSettings.variables.global.out).toBeUndefined();expect(f.background).toEqual([]);
  }finally{database.close();}
});

it("keeps only final-round partials when stopped during a selected-zero tool continuation",async()=>{
  const f=await fixture((ordinal,response)=>{if(ordinal===1){endStream(response,[{choices:[
    {index:0,delta:{content:"A before",tool_calls:[{index:0,id:"a",function:{name:"echo",arguments:"{}"}}]},finish_reason:"tool_calls"},
    {index:1,delta:{content:"B before"},finish_reason:"stop"}]}]);return;}
    response.writeHead(200,{"Content-Type":"text/event-stream"});response.write(sse({choices:[{index:1,delta:{content:"B partial"}},{index:0,delta:{content:"A partial"}}]}));});
  let count=0;f.tools.ToolManager.registerFunctionTool({name:"echo",description:"echo",parameters:{type:"object"},action:()=>{count++;return "ok";}});
  const {message}=await f.send({tools:true,event:async event=>{if(event.type==="delta"&&event.delta==="A partial")await f.app.inject({method:"POST",url:`/api/conversations/${f.story.id}/generation/stop`});}});
  expect(count).toBe(1);expect(message).toMatchObject({status:"stopped",content:"A partial",extensionData:{swipes:["A partial","B partial"]}});
  expect(message.generationMetadata.toolRounds[0].content).toBe("A before");expect(f.background).toEqual([]);
});

it("retains valid JSON candidate prefixes when a later duplicate ordinal invalidates the response",async()=>{
  const f=await fixture((_ordinal,response)=>{response.writeHead(200,{"Content-Type":"application/json"});response.end(JSON.stringify({choices:[
    {index:0,message:{content:"A received"},finish_reason:"stop"},{index:1,message:{content:"B received"},finish_reason:"stop"},
    {index:1,message:{content:"invalid duplicate"},finish_reason:"stop"}],usage}));});
  const {message,events}=await f.send({stream:false});expect(message).toMatchObject({status:"failed",content:"A received",extensionData:{swipes:["A received","B received"]}});
  expect(infos(message)).toMatchObject([{index:0,status:"failed"},{index:1,status:"failed"}]);expect(JSON.stringify(events)).not.toContain("invalid duplicate");expect(f.background).toEqual([]);
  expect(message.generationMetadata.usage).toMatchObject({inputTokens:11,outputTokens:7,totalTokens:18});
});

it.each([false,true])("preserves exact public OpenAI multi-choice bytes without native candidate validation: stream=%s",async stream=>{
  const payload={id:"public-n",choices:[{index:1,message:{content:"公开 B",reasoning_content:"BR"},finish_reason:"length"},
    {index:0,message:{content:"公开 A",unknown:{retained:true}},finish_reason:"stop"},
    {message:{content:"unindexed extension data"}},{index:1,message:{content:"duplicate extension data"}}],usage};
  const wire=stream?": keepalive\n\n"+sse(payload)+"data: [DONE]\n\n":JSON.stringify(payload,null,2)+"\n";
  const f=await fixture((_ordinal,response)=>{response.writeHead(200,{"Content-Type":stream?"text/event-stream":"application/json"});
    const bytes=Buffer.from(wire);for(let offset=0;offset<bytes.length;offset+=7)response.write(bytes.subarray(offset,offset+7));response.end();});
  const response=await fetch(`${f.base}/api/backends/chat-completions/generate`,{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({messages:[{role:"user",content:"public"}],n:2,stream,chat_completion_source:"custom"}),signal:AbortSignal.timeout(5000)});
  expect(response.status).toBe(200);expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(wire));
  expect(f.requests).toHaveLength(1);expect(f.requests[0].n).toBe(2);expect(f.background).toEqual([]);
});

it("executes the actual served chat-merge ESM without imported closures and projects durable host metadata",async()=>{
  const f=await fixture((_ordinal,response)=>endStream(response));const {message}=await f.send();
  const response=await fetch(`${f.base}/plugin-runtime/chat-merge.js`,{signal:AbortSignal.timeout(5000)});expect(response.status).toBe(200);
  const source=await response.text();
  // Native ESM loading executes the served source as-is, with no injected host helpers.
  const esm=await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const input=structuredClone(message);input.extensionData.generationMetadata={usage:{totalTokens:999999},responseState:{reasoning:"forged"}};
  input.extensionData.unknown={retained:true};const projected=esm.toExtensionMessage(input,"Role");
  expect(projected.generationMetadata).toEqual(message.generationMetadata);expect(projected.generationMetadata).not.toBe(input.generationMetadata);
  expect(projected.swipes).toEqual(["A1A2","B1B2"]);expect(projected.unknown).toEqual({retained:true});
  expect(esm.mergeJsonChanges({a:1},{a:2},{a:1,b:3})).toEqual({a:2,b:3});
  expect(esm.mergeChatMessages([{id:"a",mes:"before"}],[{id:"a",mes:"edit"}],[{id:"a",mes:"before"},{id:"b",mes:"concurrent"}],esm.mergeJsonChanges))
    .toEqual([{id:"a",mes:"edit"},{id:"b",mes:"concurrent"}]);
});

it.each([false,true])("does not borrow old native state or tools after extension deletion of candidate info (all markers=%s)",async removeAll=>{
  const image="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
  const f=await fixture((ordinal,response)=>{if(ordinal===1){endStream(response,[{choices:[
    {index:0,delta:{content:"A tool preface",tool_calls:[{index:0,id:"executed",function:{name:"echo",arguments:"{}"}}]},finish_reason:"tool_calls"},
    {index:1,delta:{content:"B preface"},finish_reason:"stop"}]}]);return;}
    if(ordinal===2){endStream(response,[{choices:[
      {index:0,delta:{content:[{type:"text",text:"A final"},{type:"image_url",image_url:{url:"data:image/png;base64,"+image}}],reasoning_content:"A private reasoning",signature:"A_PRIVATE_SIGNATURE"},finish_reason:"stop"},
      {index:1,delta:{content:"B final"},finish_reason:"stop"}]},{choices:[],usage}]);return;}endStream(response);});
  let count=0;f.tools.ToolManager.registerFunctionTool({name:"echo",description:"echo",parameters:{type:"object"},action:()=>{count++;return "actual result";}});
  const {message}=await f.send({tools:true});expect(count).toBe(1);expect(message.generationMetadata.toolRounds).toHaveLength(1);
  expect(message.generationMetadata.responseState.media).toHaveLength(1);
  const base=toExtensionChatState(await f.read()),next=structuredClone(base),last=next.messages.at(-1)!;
  delete last.swipe_info;if(removeAll)delete (last.extra as Record<string,unknown>)[infoKey];
  last.generationMetadata={nativeCandidates:false,usage:{totalTokens:999999},responseState:{reasoning:"forged"}};
  expect((await f.save(base,next)).statusCode).toBe(200);const saved=(await f.read()).messages.at(-1);
  expect(saved.generationMetadata.responseState).toBeUndefined();expect(saved.generationMetadata.finishReason).toBeUndefined();
  expect(saved.generationMetadata.completionOutcome).toBeUndefined();expect(saved.generationMetadata.usage.totalTokens).toBe(18);
  expect(saved.generationMetadata.toolRounds).toHaveLength(1);expect(saved.generationMetadata.nativeCandidates).toBe(true);
  await f.restart();expect((await f.read()).messages.at(-1)).toEqual(saved);
  await f.send();const wire=f.requests.at(-1).messages;expect(wire.some((entry:any)=>entry.role==="tool"||entry.tool_calls?.length)).toBe(false);
  expect(JSON.stringify(wire)).not.toContain(image);expect(JSON.stringify(wire)).not.toContain("A_PRIVATE_SIGNATURE");
  expect(JSON.stringify(wire)).not.toContain("A private reasoning");expect(count).toBe(1);
});
