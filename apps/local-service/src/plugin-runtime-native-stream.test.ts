import { createServer } from "node:http";
import { runInNewContext } from "node:vm";
import { createParser } from "eventsource-parser";
import { afterEach, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { openAITransportSource } from "./plugin-runtime-openai-transport.js";
import { eventSourceStreamSource } from "./plugin-runtime-stream.js";
import { eventBusSource } from "./plugin-runtime-events.js";
import { toolCallingRuntimeSource } from "./tool-calling-upstream.js";
import { toolRuntimeAdapterSource } from "./plugin-runtime-tools.js";

const apps:ReturnType<typeof buildApp>[]=[],cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));for(const close of cleanups.splice(0))await close();});
const strip=(source:string)=>source.replace(/^import .*;\r?\n/gm,"").replace(/^export \{.*\};\r?\n/gm,"").replace(/^export default /gm,"").replace(/^export /gm,"");
const sse=(data:unknown)=>`data: ${JSON.stringify(data)}\n\n`;
const claude=[
  {type:"message_start",message:{id:"fixture",type:"message",role:"assistant",content:[],usage:{input_tokens:1,output_tokens:0}}},
  {type:"content_block_start",index:0,content_block:{type:"thinking",thinking:"r",signature:""}},
  {type:"content_block_delta",index:0,delta:{type:"signature_delta",signature:"CLAUDE_SIG"}},
  {type:"content_block_stop",index:0},
  {type:"content_block_start",index:1,content_block:{type:"text",text:"原生"}},
  {type:"content_block_delta",index:1,delta:{type:"text_delta",text:"回复"}},
  {type:"content_block_stop",index:1},
  {type:"content_block_start",index:2,content_block:{type:"tool_use",id:"a",name:"same",input:{}}},
  {type:"content_block_delta",index:2,delta:{type:"input_json_delta",partial_json:'{"n":'}},
  {type:"content_block_delta",index:2,delta:{type:"input_json_delta",partial_json:'1}'}},
  {type:"content_block_stop",index:2},
  {type:"content_block_start",index:3,content_block:{type:"tool_use",id:"b",name:"same",input:{n:1}}},
  {type:"content_block_stop",index:3},
  {type:"message_delta",delta:{stop_reason:"tool_use"},usage:{output_tokens:3}},
  {type:"message_stop"},
];
const gemini=[{candidates:[{content:{parts:[{text:"r",thought:true},{text:"原生",thoughtSignature:"TEXT_SIG"},
  {functionCall:{name:"same",args:{n:1}},thoughtSignature:"CALL_A"}]}}]},
  {candidates:[{content:{parts:[{text:"回复"},{inlineData:{mimeType:"image/png",data:"aW1hZ2U="},thoughtSignature:"IMAGE_SIG"},
    {inlineData:{mimeType:"audio/wav",data:"UklGRg=="}},{functionCall:{name:"same",args:{n:1}},thoughtSignature:"CALL_B"}]},finishReason:"STOP"}]}];

function browser(settings:Record<string,unknown>,base:string){
  const context={name1:"User",name2:"Character"},bus=runInNewContext(eventBusSource+"\nnew EventBus()",{Promise,Map,Set});
  const sources={OPENAI:"openai",CUSTOM:"custom",CLAUDE:"claude",MAKERSUITE:"makersuite",AZURE_OPENAI:"azure_openai"};
  const common={console:{log:vi.fn(),warn:vi.fn(),error:vi.fn()},toastr:{info:vi.fn(),clear:vi.fn(),error:vi.fn()},
    Promise,Map,Set,Error,AbortController,structuredClone,main_api:"openai",oai_settings:settings,model_list:[],chat_completion_sources:sources,
    custom_prompt_post_processing_types:{NONE:"",MERGE_TOOLS:"merge_tools",SEMI_TOOLS:"semi_tools",STRICT_TOOLS:"strict_tools"},
    getContext:()=>context,getChatCompletionModel:()=>settings.model};
  const ToolManager=runInNewContext(strip(toolCallingRuntimeSource)+"\nToolManager",common);
  // Slash command initialization has a separate browser gate; this transport
  // fixture uses the real production register adapter and original ToolManager.
  const adapter=runInNewContext(strip(toolRuntimeAdapterSource).replace("let initialized=false;","let initialized=true;")
    +"\n({registerNativeTools})",{...common,ToolManager});
  const getEventSourceStream=runInNewContext(strip(eventSourceStreamSource)+"\ngetEventSourceStream",{createParser,TextDecoder,TransformStream,MessageEvent});
  const transport=runInNewContext(strip(openAITransportSource)+"\n({sendOpenAIRequest,getStreamingReply})",{
    ...common,ToolManager,registerNativeTools:adapter.registerNativeTools,eventSource:bus,event_types:{GENERATION_STOPPED:"stopped",CHAT_COMPLETION_SETTINGS_READY:"settings"},
    getRequestHeaders:()=>({"Content-Type":"application/json"}),getEventSourceStream,
    refreshOpenAISettings:async()=>settings,getProviderRevision:()=>1,markProviderConnected:vi.fn(),
    getCustomStoppingStrings:()=>[],power_user:{request_token_probabilities:false},substituteParams:(value:string)=>value,
    openai_max_stop_strings:4,window:new EventTarget(),fetch:(url:string,init?:RequestInit)=>fetch(base+url,init),
  });
  return {ToolManager,transport,bus};
}

it.each(["anthropic","gemini"]as const)("consumes actual public %s SSE, preserves text/media/signatures and invokes both upstream tool ordinals",async kind=>{
  const requests:Record<string,any>[]=[];
  const provider=createServer(async(request,response)=>{
    let body="";for await(const chunk of request)body+=chunk;requests.push(JSON.parse(body));
    response.writeHead(200,{"Content-Type":"text/event-stream"});response.end((kind==="anthropic"?claude:gemini).map(sse).join(""));
  });
  await new Promise<void>(resolve=>provider.listen(0,"127.0.0.1",resolve));
  cleanups.push(()=>new Promise<void>(resolve=>{provider.closeAllConnections();provider.close(()=>resolve());}));
  const remote=`http://127.0.0.1:${(provider.address()as{port:number}).port}/${kind==="anthropic"?"v1":"v1beta"}`;
  const app=buildApp();apps.push(app);
  const model=kind==="anthropic"?"claude-sonnet-4-6":"gemini-2.5-flash";
  expect((await app.inject({method:"PUT",url:"/api/settings/provider",payload:{kind,baseUrl:remote,model,maxTokens:2048,contextLimitTokens:8192}})).statusCode).toBe(200);
  const base=await app.listen({host:"127.0.0.1",port:0});
  const settings={model,chat_completion_source:kind==="anthropic"?"claude":"makersuite",function_calling:true,custom_prompt_post_processing:"",
    stream_openai:true,show_thoughts:true,openai_max_tokens:2048,openai_max_context:8192,temp_openai:0.8,
    reverse_proxy:remote,n:1,seed:-1};
  const f=browser(settings,base),actions=vi.fn(({n}:{n:number})=>"result"+n);
  f.ToolManager.registerFunctionTool({name:"same",parameters:{type:"object",properties:{n:{type:"integer"}}},action:actions});
  const iterator=await f.transport.sendOpenAIRequest("normal",[{role:"user",content:"go"}]);
  const chunks:any[]=[];for await(const chunk of iterator())chunks.push(structuredClone(chunk));
  const last=chunks.at(-1);expect(last.text).toBe("原生回复");expect(last.state.reasoning).toBe("r");
  expect(last.state.signature).toBe(kind==="anthropic"?"CLAUDE_SIG":"TEXT_SIG");
  expect(last.toolCalls[0].filter(Boolean)).toHaveLength(2);
  const result=await f.ToolManager.invokeFunctionTools(last.toolCalls);
  expect(actions).toHaveBeenCalledTimes(2);expect(result.invocations).toHaveLength(2);
  if(kind==="anthropic"){
    expect(result.invocations.map((item:any)=>item.id)).toEqual(["a","b"]);
    expect(requests[0]!.tools[0].name).toBe("same");
  }else{
    expect(result.invocations.map((item:any)=>item.signature)).toEqual(["CALL_A","CALL_B"]);
    expect(last.state.images).toEqual(["data:image/png;base64,aW1hZ2U="]);
    expect(last.state.media.map((media:any)=>media.mimeType)).toEqual(["image/png","audio/wav"]);
    expect(requests[0]!.tools[0].functionDeclarations[0].name).toBe("same");
  }
  expect(f.bus.events.stopped).toHaveLength(0);
  settings.show_thoughts=false;
  const hidden={reasoning:""};f.transport.getStreamingReply(kind==="anthropic"?claude[1]:gemini[0],hidden);
  expect(hidden.reasoning).toBe("");
});
