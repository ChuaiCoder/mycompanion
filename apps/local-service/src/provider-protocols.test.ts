import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ModelResponseState, ProviderSettings } from "@mycompanion/shared";
import { buildApp } from "./app.js";
import { parseSse } from "./test-helpers.js";
import { readProviderStream } from "./provider-response.js";
import { normalizeChatCompletionRequest } from "./chat-completion-request.js";
import { providerRequestBody, requestProviderCompletion } from "./provider-transport.js";

const apps:ReturnType<typeof buildApp>[]=[],cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));for(const close of cleanups.splice(0))await close();});
const codec={seal:(value:string)=>Buffer.from(value).toString("base64"),unseal:(value:string)=>Buffer.from(value,"base64").toString()};
const sse=(data:unknown,event?:string)=>`${event?`event: ${event}\n`:""}data: ${JSON.stringify(data)}\n\n`;
const claudeFrames=[
  {type:"message_start",message:{usage:{input_tokens:11,cache_read_input_tokens:2,cache_creation_input_tokens:3,output_tokens:0}}},
  {type:"content_block_start",index:0,content_block:{type:"thinking",thinking:"",signature:""}},
  {type:"content_block_delta",index:0,delta:{type:"thinking_delta",thinking:"思考过程"}},
  {type:"content_block_delta",index:0,delta:{type:"signature_delta",signature:"CLAUDE_SIGNATURE"}},
  {type:"content_block_stop",index:0},
  {type:"content_block_start",index:1,content_block:{type:"text",text:""}},
  {type:"content_block_delta",index:1,delta:{type:"text_delta",text:"原生回复"}},
  {type:"content_block_stop",index:1},
  {type:"message_delta",delta:{stop_reason:"end_turn"},usage:{output_tokens:5}},
  {type:"message_stop"},
];
const image="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const geminiParts=[{text:"思考过程",thought:true},{text:"原生",thoughtSignature:"GEMINI_TEXT_SIGNATURE"},{text:"回复"},
  {inlineData:{mimeType:"image/png",data:image},thoughtSignature:"GEMINI_IMAGE_SIGNATURE"},
  {inlineData:{mimeType:"audio/wav",data:"UklGRg=="}}];
const geminiFrames=[{candidates:[{content:{role:"model",parts:geminiParts},finishReason:"STOP"}],
  usageMetadata:{promptTokenCount:13,candidatesTokenCount:4,thoughtsTokenCount:2,totalTokenCount:19}}];
interface Captured {path:string;body:Record<string,any>;headers:IncomingMessage["headers"]}
async function remote(handler:(capture:Captured,response:ServerResponse)=>void){
  const requests:Captured[]=[];
  const server=createServer(async(request,response)=>{
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
    const capture={path:request.url!,body:JSON.parse(Buffer.concat(chunks).toString()||"{}"),headers:request.headers};requests.push(capture);handler(capture,response);
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  cleanups.push(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
  return {requests,base:`http://127.0.0.1:${(server.address()as{port:number}).port}`};
}
function json(response:ServerResponse,value:unknown,status=200){response.writeHead(status,{"Content-Type":"application/json"});response.end(JSON.stringify(value));}
async function setup(kind:ProviderSettings["kind"],base:string,databasePath?:string){
  const app=buildApp({secretCodec:codec,...(databasePath?{databasePath}:{})});apps.push(app);
  const settings={kind,baseUrl:base+"/proxy/"+(kind==="gemini"?"v1beta":"v1"),model:kind==="anthropic"?"claude-sonnet-4-6":"gemini-2.5-flash",apiKey:"P01_PROFILE_KEY",maxTokens:2048,contextLimitTokens:8192};
  expect((await app.inject({method:"PUT",url:"/api/settings/provider",payload:settings})).statusCode).toBe(200);
  const avatar=(await app.inject({method:"POST",url:"/api/characters/create",payload:{ch_name:"Protocol",first_mes:"Hello"}})).body;
  const character=(await app.inject({method:"POST",url:"/api/characters/get",payload:{avatar_url:avatar}})).json();
  const story=(await app.inject({method:"POST",url:"/api/conversations",payload:{characterId:character.id}})).json();
  return {app,story,settings};
}

it.each(["anthropic","gemini"]as const)("uses actual %s wire, preserves signed response/media/usage and replays history after SQLite restart",async kind=>{
  const protocol=kind==="anthropic"?"claude":"gemini";
  const provider=await remote(({body,path},response)=>{
    const stream=body.stream||path.includes("streamGenerateContent");
    if(stream){response.writeHead(200,{"Content-Type":"text/event-stream"});response.end((kind==="anthropic"?claudeFrames:geminiFrames).map(frame=>sse(frame)).join(""));}
    else if(kind==="anthropic")json(response,{content:[{type:"text",text:"[]"}],stop_reason:"end_turn"});
    else json(response,{candidates:[{content:{parts:[{text:"[]"}]},finishReason:"STOP"}]});
  });
  const folder=await mkdtemp(join(tmpdir(),"mycompanion-protocol-"));cleanups.push(()=>rm(folder,{recursive:true,force:true}));const databasePath=join(folder,"runtime.sqlite");
  let {app,story,settings}=await setup(kind,provider.base,databasePath);
  const result=await app.inject({method:"POST",url:`/api/conversations/${story.id}/messages`,payload:{content:"请回复"}});
  const done=parseSse(result.body).find(event=>event.type==="done")as any;
  expect(done?.message).toMatchObject({status:"complete",content:"原生回复",generationMetadata:{finishReason:"stop",completionOutcome:"complete",responseState:{protocol,reasoning:"思考过程"}}});
  const state=done.message.generationMetadata.responseState as ModelResponseState;
  expect(state.signature).toBe(kind==="anthropic"?"CLAUDE_SIGNATURE":"GEMINI_TEXT_SIGNATURE");
  expect(done.message.generationMetadata.usage).toMatchObject(kind==="anthropic"?{inputTokens:16,outputTokens:5,cachedInputTokens:2,cacheCreationInputTokens:3}:{inputTokens:13,outputTokens:6,reasoningTokens:2,totalTokens:19});
  expect(state.media).toHaveLength(kind==="gemini"?2:0);
  const backup=(await app.inject({method:"GET",url:"/api/backup"})).json();
  expect(backup.conversations[0].messages.at(-1).generationMetadata.responseState).toEqual(state);
  expect(JSON.stringify(backup)).not.toContain("P01_PROFILE_KEY");
  await app.close();app=buildApp({secretCodec:codec,databasePath});apps.push(app);
  const restarted=(await app.inject({method:"GET",url:`/api/conversations/${story.id}`})).json();expect(restarted.messages.at(-1).generationMetadata.responseState).toEqual(state);
  const next=await app.inject({method:"POST",url:`/api/conversations/${story.id}/messages`,payload:{content:"下一轮"}});expect(next.body).toContain("原生回复");
  const chats=provider.requests.filter(request=>request.body.stream||request.path.includes("streamGenerateContent"));expect(chats).toHaveLength(2);
  for(const request of chats){
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers[kind==="anthropic"?"x-api-key":"x-goog-api-key"]).toBe("P01_PROFILE_KEY");
    expect(request.path).toBe(kind==="anthropic"?"/proxy/v1/messages":`/proxy/v1beta/models/${settings.model}:streamGenerateContent?alt=sse`);
  }
  if(kind==="anthropic"){
    expect(chats[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(chats[0]!.body.system).toBeDefined();
    expect(chats[1]!.body.messages.flatMap((message:any)=>message.content)).toContainEqual({type:"thinking",thinking:"思考过程",signature:"CLAUDE_SIGNATURE"});
  }else{
    expect(chats[0]!.body.systemInstruction).toBeDefined();
    expect(chats[1]!.body.contents.flatMap((message:any)=>message.parts)).toContainEqual(geminiParts[3]);
    expect(chats[1]!.body.contents.flatMap((message:any)=>message.parts)).toContainEqual(geminiParts[1]);
  }
});

it.each(["anthropic","gemini"]as const)("wraps public %s non-stream output and sends actual tool/result/media/schema wire without mutating inputs",async kind=>{
  const provider=await remote((_capture,response)=>kind==="anthropic"?json(response,{content:[{type:"thinking",thinking:"r",signature:"s"},{type:"text",text:"answer"}],stop_reason:"end_turn",usage:{input_tokens:1,output_tokens:2}})
    :json(response,{candidates:[{content:{role:"model",parts:[{text:"answer",thoughtSignature:"s"}]},finishReason:"STOP"}]}));
  const {app}=await setup(kind,provider.base);
  const input={model:kind==="anthropic"?"claude-sonnet-4-6":"gemini-2.5-flash",messages:[{role:"system",content:"Rules"},
    {role:"user",content:[{type:"text",text:"look"},{type:"image_url",image_url:{url:"data:image/png;base64,"+image}}]},
    {role:"assistant",content:null,tool_calls:[{id:"call_a",type:"function",function:{name:"lookup",arguments:'{"id":1}'},signature:"TOOL_SIGNATURE"}]},
    {role:"tool",content:"tool result",tool_call_id:"call_a"}],
    tools:[{type:"function",function:{name:"lookup",parameters:{type:"object",properties:{id:{type:"integer"}},required:["id"]}}}],tool_choice:"required",stream:false,max_tokens:2048};
  const original=structuredClone(input);
  const reply=await app.inject({method:"POST",url:"/api/backends/chat-completions/generate",payload:input});
  expect(reply.statusCode,reply.body).toBe(200);expect(reply.json().choices[0].message).toMatchObject({content:"answer",signature:"s"});expect(input).toEqual(original);
  const wire=provider.requests.at(-1)!.body;
  if(kind==="anthropic"){
    expect(wire.tool_choice).toEqual({type:"any"});expect(wire.tools[0].input_schema).toEqual(input.tools[0]!.function.parameters);
    expect(wire.messages.flatMap((message:any)=>message.content)).toContainEqual({type:"tool_result",tool_use_id:"call_a",content:"tool result"});
    expect(wire.messages.flatMap((message:any)=>message.content)).toContainEqual({type:"image",source:{type:"base64",media_type:"image/png",data:image}});
  }else{
    expect(wire.toolConfig).toEqual({functionCallingConfig:{mode:"ANY"}});
    expect(wire.contents.flatMap((message:any)=>message.parts)).toContainEqual({functionCall:{name:"lookup",args:{id:1}},thoughtSignature:"TOOL_SIGNATURE"});
    expect(wire.contents.flatMap((message:any)=>message.parts)).toContainEqual({functionResponse:{name:"lookup",response:{name:"lookup",content:"tool result"}}});
  }
  const schema={name:"answer",value:{type:"object",properties:{ok:{type:"boolean"}}}};
  await app.inject({method:"POST",url:"/api/extensions/generate-raw",payload:{messages:[{role:"user",content:"JSON"}],jsonSchema:schema}});
  const schemaWire=provider.requests.at(-1)!.body;
  expect(kind==="anthropic"?schemaWire.tools[0].input_schema:schemaWire.generationConfig.responseJsonSchema).toEqual(schema.value);
});

it("accumulates fragmented Claude JSON and identical tool names by real content block ordinal",async()=>{
  const frames=[...claudeFrames.slice(0,5),
    {type:"content_block_start",index:1,content_block:{type:"tool_use",id:"call_1",name:"same",input:{}}},
    {type:"content_block_delta",index:1,delta:{type:"input_json_delta",partial_json:'{"city":'}},
    {type:"content_block_delta",index:1,delta:{type:"input_json_delta",partial_json:'"上海"}'}},
    {type:"content_block_stop",index:1},
    {type:"content_block_start",index:2,content_block:{type:"tool_use",id:"call_2",name:"same",input:{city:"上海"}}},
    {type:"content_block_stop",index:2},
    {type:"message_delta",delta:{stop_reason:"tool_use"},usage:{output_tokens:7}},{type:"message_stop"}];
  const bytes=new TextEncoder().encode(frames.map(frame=>sse(frame)).join(""));let cancelled=false;
  const response=new Response(new ReadableStream<Uint8Array>({start(controller){for(const byte of bytes)controller.enqueue(new Uint8Array([byte]));},cancel(){cancelled=true;}}));
  const states:ModelResponseState[]=[];
  const result=await readProviderStream("claude",response,{onDelta:()=>{},onState:state=>states.push(state)});
  expect(result.finishReason).toBe("tool_calls");expect(result.state.toolCalls.map(call=>[call.id,call.function.arguments])).toEqual([["call_1",'{"city":"上海"}'],["call_2",'{"city":"上海"}']]);
  expect(result.state.providerContent[1]).toMatchObject({input:{city:"上海"}});expect(cancelled).toBe(true);expect(states.some(state=>state.toolCalls[0]?.function.arguments==='{"city":')).toBe(true);
});

it("keeps real Gemini Parts and tools with their own signatures across multiple stream frames",async()=>{
  const provider=await remote((_capture,response)=>{response.writeHead(200,{"Content-Type":"text/event-stream"});response.end([
    sse({candidates:[{content:{parts:[{text:"r",thought:true},{text:"one",thoughtSignature:"TEXT_SIG"}]}}]}),
    sse({candidates:[{content:{parts:[{text:"two"},{functionCall:{name:"same",args:{n:1}},thoughtSignature:"CALL_SIG_1"},{functionCall:{name:"same",args:{n:1}},thoughtSignature:"CALL_SIG_2"}]},finishReason:"STOP"}]})].join(""));});
  const transport={protocol:"gemini"as const,baseUrl:provider.base+"/v1beta",extraHeaders:{},body:{model:"gemini-2.5-flash",stream:true,messages:[{role:"user",content:"go"}]}};
  const result=await readProviderStream("gemini",await requestProviderCompletion(transport,AbortSignal.timeout(5000)),{onDelta:()=>{}});
  expect(result.text).toBe("onetwo");expect(result.state.reasoning).toBe("r");expect(result.state.signature).toBe("TEXT_SIG");
  expect(result.state.toolCalls.map(call=>[call.id,call.signature])).toEqual([["call_0","CALL_SIG_1"],["call_1","CALL_SIG_2"]]);
});

it.each(["anthropic","gemini"]as const)("uses %s draft probes and rejects errors without echoing the provider key",async kind=>{
  const provider=await remote(({headers},response)=>json(response,{error:{code:401,message:`Echo ${headers["x-api-key"]??headers["x-goog-api-key"]}`}},401));
  const {app,settings}=await setup(kind,provider.base);
  const probe=await app.inject({method:"POST",url:"/api/settings/provider/test",payload:settings});
  expect(probe.body).not.toContain("P01_PROFILE_KEY");expect(probe.body).toContain("AUTHENTICATION");
  const raw=await app.inject({method:"POST",url:"/api/extensions/generate-raw",payload:{messages:[{role:"user",content:"test"}]}});
  expect(raw.statusCode).toBe(401);expect(raw.body).not.toContain("P01_PROFILE_KEY");
  expect(provider.requests.every(request=>request.headers.authorization===undefined)).toBe(true);
});

it("changing only protocol cannot forward a saved OpenAI key to native Claude at the same host/path",async()=>{
  const provider=await remote((_capture,response)=>json(response,{content:[{type:"text",text:"ok"}],stop_reason:"end_turn"}));
  const settings:ProviderSettings={kind:"openai-compatible",baseUrl:provider.base+"/v1",model:"chat",temperature:0.8,maxTokens:128,contextLimitTokens:8192,hasApiKey:true};
  const transport=normalizeChatCompletionRequest({chat_completion_source:"claude",messages:[{role:"user",content:"go"}],model:"claude",max_tokens:128},settings,"OLD_OPENAI_KEY");
  await requestProviderCompletion(transport,AbortSignal.timeout(5000));expect(provider.requests[0]!.headers["x-api-key"]).toBeUndefined();expect(provider.requests[0]!.headers.authorization).toBeUndefined();
});

it("preserves Gemini audio input and rejects unsupported media before fetch without silently dropping it",()=>{
  const body=providerRequestBody("gemini",{model:"gemini-2.5-flash",messages:[{role:"user",content:[{type:"input_audio",input_audio:{format:"wav",data:"UklGRg=="}}]}]});
  expect((body.contents as any)[0].parts).toEqual([{inlineData:{mimeType:"audio/wav",data:"UklGRg=="}}]);
  expect(()=>providerRequestBody("claude",{model:"claude",messages:[{role:"user",content:[{type:"input_audio",input_audio:{format:"wav",data:"UklGRg=="}}]}]})).toThrow("不支持");
  expect(()=>providerRequestBody("gemini",{model:"gemini",messages:[{role:"user",content:[{type:"image_url",image_url:{url:"https://example.com/image.png"}}]}]})).toThrow("内嵌图片");
});

it.each(["anthropic","gemini"]as const)("scopes %s replay signatures to the actual model after settings and preflight changes",async kind=>{
  const provider=await remote(({body,path},response)=>{
    if(body.stream||path.includes("streamGenerateContent")){
      response.writeHead(200,{"Content-Type":"text/event-stream"});
      response.end((kind==="anthropic"?claudeFrames:geminiFrames).map(frame=>sse(frame)).join(""));
    }else if(kind==="anthropic")json(response,{content:[{type:"text",text:"[]"}],stop_reason:"end_turn"});
    else json(response,{candidates:[{content:{parts:[{text:"[]"}]},finishReason:"STOP"}]});
  });
  const {app,story,settings}=await setup(kind,provider.base);
  const first=await app.inject({method:"POST",url:`/api/conversations/${story.id}/messages`,payload:{content:"初轮"}});
  expect(first.body).toContain('"status":"complete"');
  const changedModel=kind==="anthropic"?"claude-opus-4-6":"gemini-2.5-pro";
  expect((await app.inject({method:"PUT",url:"/api/settings/provider",payload:{...settings,model:changedModel}})).statusCode).toBe(200);
  const second=await app.inject({method:"POST",url:`/api/conversations/${story.id}/messages`,payload:{content:"更换同协议模型"}});
  expect(second.body).toContain('"status":"complete"');
  const base=await app.listen({host:"127.0.0.1",port:0});
  const response=await fetch(`${base}/api/conversations/${story.id}/messages`,{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({content:"扩展在预检中恢复旧模型",browserPreflight:true})});
  const reader=response.body!.getReader(),decoder=new TextDecoder();let buffer="",answered=false;
  while(true){
    const {done,value}=await reader.read();if(done)break;
    buffer+=decoder.decode(value,{stream:true});let split:number;
    while((split=buffer.indexOf("\n\n"))>=0){
      const frame=buffer.slice(0,split);buffer=buffer.slice(split+2);
      if(!frame.startsWith("data: "))continue;const event=JSON.parse(frame.slice(6));
      if(event.type==="completion_request"){
        answered=true;expect((await app.inject({method:"POST",url:`/api/generation/preflight/${event.requestId}`,
          payload:{request:{...event.request,model:settings.model}}})).statusCode).toBe(200);
      }
      expect(event.type).not.toBe("error");
    }
  }
  reader.releaseLock();expect(answered).toBe(true);
  const chats=provider.requests.filter(request=>request.body.stream||request.path.includes("streamGenerateContent"));
  expect(chats).toHaveLength(3);
  for(const request of chats){expect(JSON.stringify(request.body)).not.toContain("responseState");expect(JSON.stringify(request.body)).not.toContain("provider_response_");}
  const switched=chats[1]!.body,preflight=chats[2]!.body;
  if(kind==="anthropic"){
    expect(switched.model).toBe(changedModel);expect(switched.messages.flatMap((message:any)=>message.content).some((part:any)=>part.type==="thinking")).toBe(false);
    expect(preflight.model).toBe(settings.model);expect(preflight.messages.flatMap((message:any)=>message.content).filter((part:any)=>part.type==="thinking")).toHaveLength(1);
  }else{
    const parts=switched.contents.flatMap((message:any)=>message.parts);
    expect(parts.some((part:any)=>part.thought||part.thoughtSignature)).toBe(false);
    expect(parts).toContainEqual({inlineData:geminiParts[3]!.inlineData});
    const signed=preflight.contents.flatMap((message:any)=>message.parts).filter((part:any)=>part.thoughtSignature);
    expect(signed).toHaveLength(2); // First response matches; the second was generated by the changed model.
  }
});
