import { expect,it,vi } from "vitest";
import { toExtensionChatState, type GenerationSseEvent } from "@mycompanion/shared";
import { buildApp } from "./app.js";
import { apps, sseResponse, completionResponse } from "./test-helpers.js";
import { browserMacroHarness } from "./browser-macro-test-helper.js";
import type { BrowserMacroCall, BrowserMacroResult } from "./macro-boundary.js";
import { macroBoundaryBrowserSource, macroDraftSource } from "./plugin-runtime-macro-draft.js";
import {createSlashFixture} from "./slash-runtime-fixture.js";

const nativeFetch=globalThis.fetch;
async function fixture(newEngine=true,description="CARD={{m04HttpClosure}}",seedGeneration=false) {
  const app=buildApp();apps.push(app);
  const avatar=(await app.inject({method:"POST",url:"/api/characters/create",payload:{ch_name:"Actor",description,first_mes:"Opening"}})).body;
  const character=(await app.inject({method:"POST",url:"/api/characters/get",payload:{avatar_url:avatar}})).json();
  const story=(await app.inject({method:"POST",url:"/api/conversations",payload:{characterId:character.id}})).json();
  await app.inject({method:"PUT",url:"/api/settings/provider",payload:{kind:"ollama",baseUrl:"http://provider.test/v1",model:"gpt-4o",contextLimitTokens:4096,maxTokens:128}});
  await app.inject({method:"PUT",url:"/api/extensions/settings",payload:{extensionSettings:{__mycompanion_power_user:{experimental_macro_engine:newEngine},variables:{global:{callbacks:0}}}}});
  const base=await app.listen({host:"127.0.0.1",port:0}), requests:Record<string,any>[]=[],embeddingRequests:Record<string,any>[]=[];
  let embeddingResponse:(body:Record<string,any>)=>Promise<Response>|Response=body=>new Response(JSON.stringify({data:body.input.map((_text:string,index:number)=>({index,embedding:[1,0]}))}),{headers:{"Content-Type":"application/json"}});
  vi.stubGlobal("fetch",async(url:string|URL|Request,init?:RequestInit)=>{
    if(String(url).startsWith(base))return nativeFetch(url,init);
    const body=JSON.parse(String(init?.body));
    if(String(url).endsWith("/embeddings")){embeddingRequests.push(body);return embeddingResponse(body);}
    if(body.stream)requests.push(body);
    return body.stream?sseResponse(["reply"]):completionResponse();
  });
  if(seedGeneration){
    expect((await app.inject({method:"POST",url:`/api/conversations/${story.id}/messages`,payload:{content:"setup"}})).statusCode).toBe(200);
    requests.length=0;
    const settings=(await app.inject({method:"GET",url:"/api/extensions/settings"})).json().extensionSettings;
    settings.regex=[{placement:[2],findRegex:"/reply/g",replaceString:"OUT={{m04HttpClosure}}"}];
    await app.inject({method:"PUT",url:"/api/extensions/settings",payload:{extensionSettings:settings}});
  }
  const browser=browserMacroHarness();Object.assign(browser.context,{conversationId:story.id,branchId:story.activeBranchId});
  browser.setFetch((url:string|URL|Request,init?:RequestInit)=>nativeFetch(base+String(url),init));
  browser.powerUser.experimental_macro_engine=newEngine;let closures=0,closureText="browser-closure";
  browser.MacrosParser.registerMacro("m04HttpClosure",()=>{closures++;browser.variables.incrementLocalVariable("callbacks");browser.variables.incrementGlobalVariable("callbacks");return closureText;});
  browser.registry.registerMacro("m04HttpRegistry",{handler:({env}:any)=>"registry:"+env.system.model});
  const readStory=async()=>(await app.inject({method:"GET",url:`/api/conversations/${story.id}`})).json();
  const readSettings=async()=>(await app.inject({method:"GET",url:"/api/extensions/settings"})).json().extensionSettings;
  const exchange=async(path:string,payload:Record<string,unknown>)=>{
    const controller=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)]);
    const response=await nativeFetch(base+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({browserMacros:true,...payload}),signal});
    expect(response.status).toBe(200);expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader=response.body!.getReader(),decoder=new TextDecoder(),events:GenerationSseEvent[]=[],calls:BrowserMacroCall[]=[],frames:GenerationSseEvent[]=[];let buffer="";
    const next=async():Promise<GenerationSseEvent|undefined>=>{
      while(!frames.length){const chunk=await reader.read();if(chunk.done)return;buffer+=decoder.decode(chunk.value,{stream:true});
        let delimiter;while((delimiter=buffer.indexOf("\n\n"))>=0){const frame=buffer.slice(0,delimiter);buffer=buffer.slice(delimiter+2);
          for(const line of frame.split("\n"))if(line.startsWith("data:"))frames.push(JSON.parse(line.slice(5)));}}
      const event=frames.shift()!;events.push(event);return event;
    };
    const answerMacro=(event:Extract<GenerationSseEvent,{type:"macro_request"}>,result?:BrowserMacroResult)=>
      app.inject({method:"POST",url:`/api/generation/macros/${event.requestId}`,payload:{result:result??browser.evaluateBrowserMacro(event)}});
    const answerEffect=(event:Extract<GenerationSseEvent,{type:"effect_request"}>)=>browser.respondToEffectRequest(event,signal);
    const finish=async(onPreflight?:(event:Extract<GenerationSseEvent,{type:"completion_request"}>)=>Promise<void>)=>{
      for(let event; (event=await next());){
        if(event.type==="macro_request"){
          calls.push(event.evaluation as unknown as BrowserMacroCall);expect((await answerMacro(event)).statusCode).toBe(200);
          if(calls.length===1)expect((await app.inject({method:"POST",url:`/api/generation/macros/${event.requestId}`,payload:{result:{content:"duplicate",local:{},global:{}}}})).statusCode).toBe(409);
        }
        if(event.type==="completion_request"){if(onPreflight)await onPreflight(event);else expect((await app.inject({method:"POST",url:`/api/generation/preflight/${event.requestId}`,payload:{request:event.request}})).statusCode).toBe(200);}
        if(event.type==="effect_request")await answerEffect(event);
        if(event.type==="effect_end")browser.endEffectInvocation(event.invocationId);
        if(event.type==="assistant_start")browser.context.branchId=event.message.branchId;
      }
      reader.releaseLock();return events;
    };
    return {events,calls,next,answerMacro,answerEffect,finish,controller,reader};
  };
  const cleanup=()=>{browser.MacrosParser.unregisterMacro("m04HttpClosure");browser.registry.unregisterMacro("m04HttpRegistry");};
  return {app,story,character,browser,requests,embeddingRequests,readStory,readSettings,exchange,closures:()=>closures,cleanup,setClosureText:(value:string)=>{closureText=value;},
    setEmbeddingResponse:(next:typeof embeddingResponse)=>{embeddingResponse=next;}};
}

const prompts=["a","b"].map(key=>({key,value:"SCAN {{m04HttpClosure}} {{m04HttpRegistry}} trigger",position:1,depth:0,role:0,scan:true}));
async function enableTimedBook(f:Awaited<ReturnType<typeof fixture>>){
  await f.app.inject({method:"POST",url:"/api/worldinfo/edit",payload:{name:"Timed",data:{entries:{1:{uid:1,key:[],constant:true,
    sticky:3,cooldown:2,content:"TIMER {{m04HttpClosure}}",order:100,position:1,useProbability:false}}}}});
  const settings=(await f.app.inject({method:"GET",url:"/api/worldinfo/settings"})).json();
  await f.app.inject({method:"PUT",url:"/api/worldinfo/settings",payload:{...settings,world_info:{globalSelect:["Timed"],charLore:[]}}});
}

it.each(["normal","quiet","preview"])("runs original WI Quick Reply automation once inside the actual %s native acceptance boundary",async mode=>{
  const f=await fixture(true,"{{m04HttpClosure}}"),settings=await f.readSettings();
  settings.quickReplyV2={isEnabled:true,config:{setList:[{set:"Native WI"}]}};
  await f.app.inject({method:"PUT",url:"/api/extensions/settings",payload:{extensionSettings:settings}});
  await f.app.inject({method:"POST",url:"/api/quick-replies/save",payload:{version:2,name:"Native WI",qrList:[{id:1,label:"Count",automationId:"test-automation",message:"/incvar qrCount | /incglobalvar qrCount"}]}});
  const qr=await createSlashFixture(undefined,undefined,{quickReplies:true,isMacroDraftActive:()=>f.browser.draft.isMacroDraftActive(),fetch:async(url:any,init?:RequestInit)=>{
    const response=await f.app.inject({method:(init?.method??"GET") as any,url:String(url),...(init?.body?{payload:JSON.parse(String(init.body))}:{})});
    return new Response(response.body,{status:response.statusCode,headers:{"Content-Type":"application/json"}});
  }});
  try{
    qr.settings.quickReplyV2=settings.quickReplyV2;await qr.api.loadQuickReplies();let automations=0;
    f.browser.eventSource.on(f.browser.event_types.WORLD_INFO_ACTIVATED,async(entries:any[])=>{
      automations++;qr.context.chatMetadata=f.browser.context.chatMetadata;qr.settings.variables=f.browser.settings.variables;
      await qr.api.eventSource.emit(qr.api.event_types.WORLD_INFO_ACTIVATED,entries);
    });
    await f.app.inject({method:"POST",url:"/api/worldinfo/edit",payload:{name:"QRWorld",data:{entries:{1:{uid:1,key:[],constant:true,
      automationId:"test-automation",content:"WI {{m04HttpClosure}}",order:100,position:1,useProbability:false}}}}});
    const wi=(await f.app.inject({url:"/api/worldinfo/settings"})).json();
    await f.app.inject({method:"PUT",url:"/api/worldinfo/settings",payload:{...wi,world_info:{globalSelect:["QRWorld"],charLore:[]}}});
    const path=`/api/conversations/${f.story.id}/${mode==="quiet"?"quiet-generation":mode==="preview"?"prompt-preview":"messages"}`;
    const payload={...(mode==="quiet"?{quietPrompt:"quiet"}:mode==="preview"?{draft:"preview"}:{content:"normal"}),extensionPrompts:[
      {key:"qr-post-scan",value:"QR_AFTER {{getvar::qrCount}}/{{getglobalvar::qrCount}}",position:0,depth:0,role:0,scan:false}]};
    const x=await f.exchange(path,payload);await x.finish();expect(x.events.filter(event=>event.type==="error")).toEqual([]);
    expect(automations).toBe(mode==="preview"?0:1);
    const stored=await f.readStory(),savedSettings=await f.readSettings();
    if(mode!=="preview"){
      expect(stored.chatMetadata.variables.qrCount).toBe(1);expect(savedSettings.variables.global.qrCount).toBe(1);
      expect(JSON.stringify(f.requests[0]!.messages)).toContain("QR_AFTER 1/1");
      expect(qr.traces.filter(item=>item[0]==="localSave"||item[0]==="globalSave")).toEqual([]);
    }else{expect(stored.chatMetadata.variables?.qrCount).toBeUndefined();expect(savedSettings.variables.global.qrCount).toBeUndefined();}
  }finally{qr.close();f.cleanup();}
});

it.each(["normal","quiet","public-wi"])("commits and publishes accepted world-info timers at the %s boundary",async mode=>{
  const f=await fixture(true,"");
  try{
    await enableTimedBook(f);
    const path=mode==="public-wi"?"/api/worldinfo/prompt":`/api/conversations/${f.story.id}/${mode==="quiet"?"quiet-generation":"messages"}`;
    const payload=mode==="public-wi"?{chat:["Opening"],maxContext:4096,conversationId:f.story.id,characterId:f.character.id,commitVariables:true,isDryRun:false}
      :mode==="quiet"?{quietPrompt:"quiet"}:{content:"latest"};
    const x=await f.exchange(path,payload);await x.finish();
    expect(x.events.filter(event=>event.type==="error")).toEqual([]);
    const saved=await f.readStory(),state=saved.chatMetadata.__mycompanion_world_info_state;
    expect(state.revision).toBe(1);expect(Object.keys(saved.chatMetadata.timedWorldInfo.sticky)).toHaveLength(1);
    const published=mode==="public-wi"?(x.events.find(event=>event.type==="macro_result") as any).result.worldInfoState
      :(x.events.find(event=>event.type==="macro_variables" && event.worldInfoState) as any).worldInfoState;
    expect(published).toEqual({timedWorldInfo:saved.chatMetadata.timedWorldInfo,__mycompanion_world_info_state:state});
    if(mode==="public-wi"){
      // Use precisely the response snapshot as a browser would on the next call.
      const second=await f.exchange(path,{...payload,metadata:{...saved.chatMetadata,...published}});await second.finish();
      expect(second.events.filter(event=>event.type==="error")).toEqual([]);
      expect((await f.readStory()).chatMetadata.__mycompanion_world_info_state.revision).toBe(2);
    }
  }finally{f.cleanup();}
});

it("keeps full source prefixes for world-info timers and excludes the replaced assistant during regeneration",async()=>{
  const f=await fixture(true,"");
  try{
    await enableTimedBook(f);const initial=await f.readStory(),base=toExtensionChatState(initial),next=structuredClone(base);
    next.messages.push(...Array.from({length:84},(_,index)=>({id:crypto.randomUUID(),mes:`old-${index}`,is_user:index%2===0})));
    expect((await f.app.inject({method:"PUT",url:`/api/conversations/${f.story.id}/extension-state`,payload:{branchId:initial.activeBranchId,base,next}})).statusCode).toBe(200);
    const normal=await f.exchange(`/api/conversations/${f.story.id}/messages`,{content:"latest"});await normal.finish();
    const before=await f.readStory();expect(before.chatMetadata.__mycompanion_world_info_state.checkpoints.at(-1).sourceCount).toBe(86);
    const regenerated=await f.exchange(`/api/conversations/${f.story.id}/messages/regenerate`,{});await regenerated.finish();
    expect(regenerated.events.filter(event=>event.type==="error")).toEqual([]);
    const saved=await f.readStory(),checkpoint=saved.chatMetadata.__mycompanion_world_info_state.checkpoints.at(-1);
    expect(saved.activeBranchId).not.toBe(before.activeBranchId);expect(checkpoint.branchId).toBe(saved.activeBranchId);
    expect(checkpoint.sourceCount).toBe(86);expect(saved.messages).toHaveLength(87);
    expect(saved.messages.slice(0,-1).map((message:any)=>[message.id,message.role,message.content]))
      .toEqual(before.messages.slice(0,-1).map((message:any)=>[message.id,message.role,message.content]));
  }finally{f.cleanup();}
});

it.each(["preview","public-dry-run","cancelled-preflight"])("does not commit world-info timers for %s",async mode=>{
  const f=await fixture(true,"");
  try{
    await enableTimedBook(f);const before=await f.readStory();
    const path=mode==="public-dry-run"?"/api/worldinfo/prompt":`/api/conversations/${f.story.id}/${mode==="preview"?"prompt-preview":"quiet-generation"}`;
    const payload=mode==="public-dry-run"?{chat:["Opening"],maxContext:4096,conversationId:f.story.id,characterId:f.character.id,commitVariables:true,isDryRun:true}
      :mode==="preview"?{}:{quietPrompt:"quiet",browserPreflight:true};
    const x=await f.exchange(path,payload);
    if(mode==="cancelled-preflight"){
      for(let event;(event=await x.next());){if(event.type==="macro_request")await x.answerMacro(event);
        if(event.type==="effect_request")await x.answerEffect(event);
        if(event.type==="effect_end")f.browser.endEffectInvocation(event.invocationId);
        if(event.type==="completion_request"){x.controller.abort();await x.reader.cancel().catch(()=>{});break;}}
    }else await x.finish();
    const saved=await f.readStory();expect(saved.chatMetadata.__mycompanion_world_info_state).toBeUndefined();
    expect(saved.chatMetadata.timedWorldInfo).toBeUndefined();expect(saved.messages).toEqual(before.messages);expect(f.requests).toHaveLength(0);
  }finally{f.cleanup();}
});
it.each([false,true].flatMap(newEngine=>["normal","quiet","regenerate","preview","public-assembly","public-wi"].map(mode=>({newEngine,mode}))))("runs browser closures before budgeting and commits at the proper HTTP boundary: $mode / new=$newEngine",async({newEngine,mode})=>{
  const f=await fixture(newEngine,undefined,mode==="regenerate");
  const before=await f.readStory();
  try {
    expect((await f.app.inject({method:"GET",url:"/plugin-runtime/macro-boundary.js"})).body).toBe(macroBoundaryBrowserSource);
    expect((await f.app.inject({method:"GET",url:"/plugin-runtime/macro-draft.js"})).body).toBe(macroDraftSource);
    let path=`/api/conversations/${f.story.id}/`,payload:Record<string,unknown>={extensionPrompts:prompts};
    if(mode==="normal"){path+="messages";payload={...payload,content:"latest",browserPreflight:true};}
    if(mode==="quiet"){path+="quiet-generation";payload={...payload,quietPrompt:"QUIET {{m04HttpClosure}}"};}
    if(mode==="regenerate"){path+="messages/regenerate";payload={...payload,browserPreflight:true};}
    if(mode==="preview")path+="prompt-preview";
    if(mode==="public-assembly"){path+="extension-prompt-assembly";payload={...payload,messages:[{role:"user",content:"latest"}],commitVariables:true};}
    if(mode==="public-wi"){
      await f.app.inject({method:"POST",url:"/api/worldinfo/edit",payload:{name:"M04",data:{entries:{1:{uid:1,key:["trigger"],content:"WI={{m04HttpClosure}}",order:100,position:1,useProbability:false}}}}});
      const settings=(await f.app.inject({method:"GET",url:"/api/worldinfo/settings"})).json();
      path="/api/worldinfo/prompt";payload={chat:[],maxContext:4096,conversationId:f.story.id,characterId:f.character.id,commitVariables:true,
        settings:{...settings,world_info:{globalSelect:["M04"],charLore:[]}},extensionScanPrompts:prompts};
    }
    const x=await f.exchange(path,payload);await x.finish();
    expect(x.events.filter(event=>event.type==="error")).toEqual([]);expect(f.closures()).toBeGreaterThan(0);
    const saved=await f.readStory(),settings=await f.readSettings();
    expect(f.browser.localSave).not.toHaveBeenCalled();expect(f.browser.globalSave).not.toHaveBeenCalled();
    expect(settings.variables.global.callbacks).toBe(mode==="preview"?0:f.closures());
    expect(saved.chatMetadata.variables?.callbacks??0).toBe(mode==="preview"?0:f.closures());
    if(mode==="preview"){expect(saved).toEqual(before);expect(f.requests).toHaveLength(0);}
    else if(mode.startsWith("public")){expect(f.requests).toHaveLength(0);expect(saved.messages).toEqual(before.messages);}
    else {expect(f.requests).toHaveLength(1);expect(JSON.stringify(f.requests[0]!.messages)).toContain("browser-closure");expect(JSON.stringify(f.requests[0]!.messages)).not.toContain("{{m04");}
    if(mode==="quiet")expect(saved.messages).toEqual(before.messages);
    if(mode==="public-wi"){
      expect(x.calls.slice(0,2).map(call=>call.content)).toEqual(prompts.map(prompt=>prompt.value));
      expect(x.events.find(event=>event.type==="macro_result")).toMatchObject({result:{report:{block:"WI=browser-closure"}}});
    }else expect(x.calls.some(call=>call.content===prompts.map(prompt=>prompt.value).join("\n"))).toBe(true);
  } finally {f.cleanup();}
});

it.each(["cancel","malformed","late"])("rejects unfinished or invalid browser RPC without committing a draft: %s",async mode=>{
  const f=await fixture(),before=await f.readStory();
  try{
    const x=await f.exchange(`/api/conversations/${f.story.id}/quiet-generation`,{quietPrompt:"{{m04HttpClosure}}"});
    let event;while((event=await x.next())?.type!=="macro_request"){if(!event)throw new Error("Missing macro_request");}
    if(mode==="cancel"||mode==="late"){
      x.controller.abort();await x.reader.cancel().catch(()=>{});
      const late=await f.app.inject({method:"POST",url:`/api/generation/macros/${event.requestId}`,payload:{result:{content:"late",local:{callbacks:9},global:{callbacks:9}}}});
      // Socket close and RPC can race; draining the request guarantees cleanup.
      if(late.statusCode===200)await new Promise(resolve=>setTimeout(resolve,10));
      expect((await f.app.inject({method:"POST",url:`/api/generation/macros/${event.requestId}`,payload:{result:{content:"late",local:{},global:{}}}})).statusCode).toBe(409);
    }else{
      expect((await f.app.inject({method:"POST",url:`/api/generation/macros/${event.requestId}`,payload:{result:{content:3}}})).statusCode).toBe(400);
      await x.finish();expect(x.events.some(item=>item.type==="error")).toBe(true);
    }
    expect(await f.readStory()).toEqual(before);expect((await f.readSettings()).variables.global.callbacks).toBe(0);expect(f.requests).toHaveLength(0);
  }finally{f.cleanup();}
});

it("does not send a provider request or commit macro effects after a preflight variable conflict",async()=>{
  const f=await fixture(),before=await f.readStory();
  try{
    const x=await f.exchange(`/api/conversations/${f.story.id}/quiet-generation`,{quietPrompt:"{{m04HttpClosure}}",browserPreflight:true});
    await x.finish(async event=>{
      const settings=await f.readSettings();settings.variables.global.callbacks=99;
      await f.app.inject({method:"PUT",url:"/api/extensions/settings",payload:{extensionSettings:settings}});
      await f.app.inject({method:"POST",url:`/api/generation/preflight/${event.requestId}`,payload:{request:event.request}});
    });
    expect(x.events.some(event=>event.type==="error")).toBe(true);expect(f.requests).toHaveLength(0);expect(await f.readStory()).toEqual(before);
    expect((await f.readSettings()).variables.global.callbacks).toBe(99);
  }finally{f.cleanup();}
});

it.each([false,true])("rejects a fixed browser expansion before provider transport and draft commit (new=%s)",async newEngine=>{
  const f=await fixture(newEngine),before=await f.readStory();f.setClosureText("large ".repeat(5000));
  try{
    const x=await f.exchange(`/api/conversations/${f.story.id}/quiet-generation`,{});await x.finish();
    expect(f.closures()).toBeGreaterThan(0);expect(x.events.some(event=>event.type==="error"&&event.message.includes("上下文"))).toBe(true);
    expect(f.requests).toHaveLength(0);expect(await f.readStory()).toEqual(before);expect((await f.readSettings()).variables.global.callbacks).toBe(0);
  }finally{f.cleanup();}
});

it.each([false,true])("stops at the rejected history candidate without visiting older browser closures (new=%s)",async newEngine=>{
  const f=await fixture(newEngine,""),large=vi.fn(()=>{f.browser.variables.incrementLocalVariable("large");return "large ".repeat(5000);}),unvisited=vi.fn(()=>"forbidden");
  f.browser.MacrosParser.registerMacro("m04HistoryLarge",large);f.browser.MacrosParser.registerMacro("m04HistoryUnvisited",unvisited);
  try{
    const x=await f.exchange(`/api/conversations/${f.story.id}/extension-prompt-assembly`,{commitVariables:true,contextLimitTokens:1024,messages:[
      {role:"user",content:"latest"},{role:"assistant",content:"{{m04HistoryLarge}}"},{role:"user",content:"{{m04HistoryUnvisited}}"},
    ]});await x.finish();
    expect(large).toHaveBeenCalledTimes(1);expect(unvisited).not.toHaveBeenCalled();expect(f.requests).toHaveLength(0);
    const result=x.events.find(event=>event.type==="macro_result");expect(result).toMatchObject({result:{contextLimitTokens:1024}});
    expect(JSON.stringify(result)).toContain("latest");expect(JSON.stringify(result)).not.toContain("large large");
    expect((await f.readStory()).chatMetadata.variables).toEqual({large:1});
  }finally{f.browser.MacrosParser.unregisterMacro("m04HistoryLarge");f.browser.MacrosParser.unregisterMacro("m04HistoryUnvisited");f.cleanup();}
});

it.each([false,true])("shares one browser draft across input, prompt, WI placement 5 and output checkpoints (new=%s)",async newEngine=>{
  const f=await fixture(newEngine,"");
  try{
    const settings=await f.readSettings();settings.regex=[
      {placement:[1],findRegex:"/^input$/g",replaceString:"IN={{incvar::phase}}/{{m04HttpClosure}}"},
      {placement:[1],findRegex:"/^IN=1\\/browser-closure$/g",promptOnly:true,replaceString:"PROMPT={{incvar::phase}}/{{m04HttpClosure}}"},
      {placement:[5],findRegex:"/^LORE$/g",promptOnly:true,replaceString:"LORE={{incvar::phase}}/{{m04HttpClosure}}"},
      {placement:[2],findRegex:"/reply/g",replaceString:"OUT={{incvar::phase}}/{{m04HttpClosure}}"},
    ];
    await f.app.inject({method:"PUT",url:"/api/extensions/settings",payload:{extensionSettings:settings}});
    await f.app.inject({method:"POST",url:"/api/worldinfo/edit",payload:{name:"M04Regex",data:{entries:{1:{uid:1,key:[],constant:true,content:"LORE",order:100,position:1,useProbability:false}}}}});
    const wi=(await f.app.inject({method:"GET",url:"/api/worldinfo/settings"})).json();
    await f.app.inject({method:"PUT",url:"/api/worldinfo/settings",payload:{...wi,world_info:{globalSelect:["M04Regex"],charLore:[]}}});
    const x=await f.exchange(`/api/conversations/${f.story.id}/messages`,{content:"input",browserPreflight:true});await x.finish();
    expect(x.events.some(event=>event.type==="error")).toBe(false);expect(f.closures()).toBe(4);expect(f.requests).toHaveLength(1);
    expect(JSON.stringify(f.requests[0]!.messages)).toContain("PROMPT=2/browser-closure");expect(JSON.stringify(f.requests[0]!.messages)).toContain("LORE=3/browser-closure");
    const saved=await f.readStory();expect(saved.messages.find((message:any)=>message.role==="user").content).toBe("IN=1/browser-closure");
    expect(saved.messages.at(-1).content).toBe("OUT=4/browser-closure");expect(saved.chatMetadata.variables).toEqual({phase:4,callbacks:4});
    expect((await f.readSettings()).variables.global.callbacks).toBe(4);expect(x.events.filter(event=>event.type==="macro_variables")).toHaveLength(2);
  }finally{f.cleanup();}
});

it.each(["normal","quiet","preview","public-wi"])("awaits WI scan/activation and exposes fresh Outlet macros at the actual %s HTTP boundary",async mode=>{
  const f=await fixture(true,"OUTLET={{outlet::story}}/{{m04ReadFreshOutlet}}");
  const observed:Array<Record<string,unknown>>=[];
  f.browser.context.extensionPrompts.customWIOutlet_story={value:"OLD",position:-1,depth:0,role:0,scan:false};
  f.browser.MacrosParser.registerMacro("m04ReadFreshOutlet",()=>f.browser.context.extensionPrompts.customWIOutlet_story?.value);
  f.browser.eventSource.on(f.browser.event_types.WORLDINFO_SCAN_DONE,async(args:any)=>{
    await Promise.resolve();observed.push({kind:"scan",outlet:f.browser.context.extensionPrompts.customWIOutlet_story?.value});
    args.sortedEntries[0].content="SCANNED";f.browser.variables.incrementLocalVariable("scanCount");
  });
  f.browser.eventSource.on(f.browser.event_types.WORLD_INFO_ACTIVATED,async(entries:any[])=>{
    await Promise.resolve();observed.push({kind:"activated",content:entries[0].content,outlet:f.browser.context.extensionPrompts.customWIOutlet_story?.value,
      timers:Object.keys((f.browser.context.chatMetadata.timedWorldInfo as any).sticky)});
    f.browser.variables.incrementLocalVariable("activationCount");
  });
  try {
    const settings=await f.readSettings();settings.regex=[{placement:[5],findRegex:"SCANNED",replaceString:"FINAL",promptOnly:true}];
    await f.app.inject({method:"PUT",url:"/api/extensions/settings",payload:{extensionSettings:settings}});
    await f.app.inject({method:"POST",url:"/api/worldinfo/edit",payload:{name:"M04Outlet",data:{entries:{1:{uid:1,key:[],constant:true,
      content:"RAW",order:100,position:7,outletName:"story",sticky:3,useProbability:false}}}}});
    const wi=(await f.app.inject({method:"GET",url:"/api/worldinfo/settings"})).json();
    await f.app.inject({method:"PUT",url:"/api/worldinfo/settings",payload:{...wi,world_info:{globalSelect:["M04Outlet"],charLore:[]}}});
    const publicWi=mode==="public-wi";
    const path=publicWi?"/api/worldinfo/prompt":`/api/conversations/${f.story.id}/${mode==="preview"?"prompt-preview":mode==="quiet"?"quiet-generation":"messages"}`;
    const priorOutlet=[{key:"customWIOutlet_story",value:"OLD",position:-1,depth:0,role:0,scan:false},
      {key:"post-scan",value:"POST={{outlet::story}}/{{m04ReadFreshOutlet}}",position:0,depth:0,role:0,scan:false}];
    const payload=publicWi?{chat:["Opening"],maxContext:4096,characterId:f.character.id,conversationId:f.story.id,commitVariables:true,isDryRun:true}
      :{extensionPrompts:priorOutlet,...(mode==="normal"?{content:"latest",browserPreflight:true}:mode==="quiet"?{quietPrompt:"quiet",browserPreflight:true}:{})};
    const x=await f.exchange(path,payload);await x.finish(async event=>{
      observed.push({kind:"preflight",outlet:f.browser.context.extensionPrompts.customWIOutlet_story?.value});
      // Pinned Generate reads the card before WI, then installs outlets before
      // the independent extension prompt pass. Preserve those phase boundaries.
      expect(JSON.stringify(event.request.messages)).toContain("OUTLET=OLD/OLD");
      expect(JSON.stringify(event.request.messages)).toContain("POST=FINAL/FINAL");
      expect((await f.app.inject({method:"POST",url:`/api/generation/preflight/${event.requestId}`,payload:{request:event.request}})).statusCode).toBe(200);
    });
    expect(x.events.some(event=>event.type==="error")).toBe(false);
    expect(observed[0]).toEqual({kind:"scan",outlet:"OLD"});
    if(mode==="normal"||mode==="quiet"){
      expect(observed[1]).toEqual({kind:"activated",content:"SCANNED",outlet:"OLD",timers:["M04Outlet.1"]});
      expect(observed[2]).toEqual({kind:"preflight",outlet:"FINAL"});
      expect((await f.readStory()).chatMetadata.variables).toEqual({scanCount:1,activationCount:1});
    }else expect(observed).toHaveLength(1);
    if(publicWi){
      expect(f.browser.context.extensionPrompts.customWIOutlet_story.value).toBe("OLD");
      expect(x.events.find(event=>event.type==="macro_result")).toMatchObject({result:{outletEntries:{story:["FINAL"]}}});
    }else expect(f.browser.context.extensionPrompts.customWIOutlet_story.value).toBe("FINAL");
    expect(f.browser.draft.isMacroDraftActive()).toBe(false);
  }finally{f.browser.MacrosParser.unregisterMacro("m04ReadFreshOutlet");f.cleanup();}
});

it.each([false,true])("awaits an actual embedding-derived FORCE event once and rejects edited source snapshots (edit=%s)",async edit=>{
  const f=await fixture(true,"");let forced=0;
  f.browser.eventSource.on(f.browser.event_types.WORLDINFO_FORCE_ACTIVATE,async(entries:any[])=>{
    await Promise.resolve();forced++;expect(entries.map(item=>item.uid)).toEqual([1]);f.browser.variables.incrementLocalVariable("forcedCount");
  });
  try {
    const profile=(await f.app.inject({method:"POST",url:"/api/settings/providers",payload:{name:"embedding",settings:{kind:"openai-compatible",baseUrl:"http://provider.test/v1",model:"embed-fixed",contextLimitTokens:4096,maxTokens:128}}})).json();
    await f.app.inject({method:"PATCH",url:"/api/settings/provider-tasks",payload:{embedding:profile.id}});
    const settings=await f.readSettings();settings.vectors={enabled_world_info:true,query:1,max_entries:1,score_threshold:.8};
    await f.app.inject({method:"PUT",url:"/api/extensions/settings",payload:{extensionSettings:settings}});
    const book={entries:{1:{uid:1,key:["NEVER_LITERAL"],vectorized:true,content:"SEMANTIC",position:1}}};
    await f.app.inject({method:"POST",url:"/api/worldinfo/edit",payload:{name:"M04Vectors",data:book}});
    const wi=(await f.app.inject({method:"GET",url:"/api/worldinfo/settings"})).json();
    await f.app.inject({method:"PUT",url:"/api/worldinfo/settings",payload:{...wi,world_info:{globalSelect:["M04Vectors"],charLore:[]}}});
    if(edit)f.setEmbeddingResponse(async body=>{
      await f.app.inject({method:"POST",url:"/api/worldinfo/edit",payload:{name:"M04Vectors",data:{entries:{1:{...book.entries[1],content:"EDITED"}}}}});
      return new Response(JSON.stringify({data:body.input.map((_text:string,index:number)=>({index,embedding:[1,0]}))}),{headers:{"Content-Type":"application/json"}});
    });
    const x=await f.exchange(`/api/conversations/${f.story.id}/messages`,{content:"query",browserPreflight:true});await x.finish();
    expect(x.events.some(event=>event.type==="error")).toBe(false);expect(f.embeddingRequests).toHaveLength(2);
    expect(f.embeddingRequests.every(item=>item.model==="embed-fixed")).toBe(true);
    expect(forced).toBe(edit?0:1);expect(f.requests).toHaveLength(1);
    const request=JSON.stringify(f.requests[0]!.messages);expect(request.includes("SEMANTIC")).toBe(!edit);
    expect((await f.readStory()).chatMetadata.variables?.forcedCount??0).toBe(edit?0:1);
    if(edit)expect(x.events.find(event=>event.type==="lorebook")).toMatchObject({report:{results:[{diagnostics:expect.arrayContaining([expect.stringContaining("向量查询期间发生变化")])}]}});
  }finally{f.cleanup();}
});
