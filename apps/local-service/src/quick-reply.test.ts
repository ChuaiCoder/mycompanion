import {expect,it} from "vitest";
import {buildApp} from "./app.js";
import {apps} from "./test-helpers.js";
import {createSlashFixture} from "./slash-runtime-fixture.js";
import {QUICK_REPLY_PRESETS_KEY} from "./quick-reply-repository.js";
import {browserMacroHarness} from "./browser-macro-test-helper.js";
import {readFileSync,writeFileSync} from "node:fs";
import {join,resolve} from "node:path";
import {createHash} from "node:crypto";
import {createContext,runInContext} from "node:vm";
import {parse} from "acorn";

const set=(name:string,qrList:Record<string,unknown>[])=>({version:2,name,disableSend:false,placeBeforeInput:false,injectInput:false,qrList});
const qr=(label:string,message:string,extra:Record<string,unknown>={})=>({id:1,label,message,automationId:"wi",...extra});
async function fixture(sets:Record<string,unknown>[],isMacroDraftActive?:()=>boolean){
  const app=buildApp();apps.push(app);
  for(const item of sets)expect((await app.inject({method:"POST",url:"/api/quick-replies/save",payload:item})).statusCode).toBe(200);
  const h=await createSlashFixture(undefined,undefined,{quickReplies:true,...(isMacroDraftActive?{isMacroDraftActive}:{}),fetch:async(url:any,init?:RequestInit)=>{
    const response=await app.inject({method:(init?.method??"GET") as any,url:String(url),...(init?.body?{payload:JSON.parse(String(init.body))}:{})});
    return new Response(response.body,{status:response.statusCode,headers:{"Content-Type":String(response.headers["content-type"]??"application/json")}});
  }});
  await h.api.loadQuickReplies();return {app,h};
}

it("persists original save/delete/get shapes, survives unrelated settings replacement and restores QR facts through backup",async()=>{
  const {app,h}=await fixture([set("Automation",[qr("Run","/setvar key=value yes")])]);
  try{
    const list=async()=> (await app.inject({url:"/api/quick-replies/list"})).json();expect((await list())[0].name).toBe("Automation");
    expect((await app.inject({method:"PUT",url:"/api/extensions/settings",payload:{extensionSettings:{vectors:{query:4},variables:{global:{count:2}}}}})).statusCode).toBe(200);
    expect((await list())[0].name).toBe("Automation");
    const legacy=(await app.inject({method:"POST",url:"/api/settings/get",payload:{}})).json();expect(legacy.quickReplyPresets).toEqual(await list());
    const backupResponse=await app.inject({url:"/api/backup"});expect(backupResponse.statusCode,backupResponse.body).toBe(200);
    const backup=backupResponse.json();expect(backup.extensionSettings[QUICK_REPLY_PRESETS_KEY]).toEqual(await list());
    expect((await app.inject({method:"POST",url:"/api/quick-replies/delete",payload:{name:"Automation"}})).statusCode).toBe(200);expect(await list()).toEqual([]);
    const restored=await app.inject({method:"POST",url:"/api/backup/restore",payload:{backup,strategy:"overwrite"}});expect(restored.statusCode,restored.body).toBe(200);
    expect((await list())[0].name).toBe("Automation");
  }finally{h.close();}
});

it("executes genuine named /run with scoped QR arguments, dotted fallback, legacy migration and native textarea behavior",async()=>{
  const legacy={name:"Legacy",version:1,quickReplySlots:[{label:"Old",mes:"/pass migrated",automationId:"legacy"}]};
  const {h}=await fixture([set("Scripts",[qr("Greeting","/setvar key=ran {{arg::who}} | /pass Hello {{arg::who}}")]),legacy]);
  try{
    h.settings.quickReplyV2={isEnabled:true,config:{setList:[{set:"Scripts",isVisible:true}]}};
    expect((await h.api.executeSlashCommandsWithOptions('/run who=Reader Greeting',{handleParserErrors:false})).pipe).toBe("Hello Reader");
    expect(h.context.chatMetadata.variables.ran).toBe("Reader");
    expect((await h.api.executeSlashCommandsWithOptions('/run Legacy.Old',{handleParserErrors:false})).pipe).toBe("migrated");
    await expect(h.api.executeQuickReplyByName("absent")).rejects.toThrow('No Quick Reply found');
  }finally{h.close();}
});

it("uses actual native composer callbacks for text QRs and preserves disableSend and the real disabled button",async()=>{
  const {h}=await fixture([set("Text",[qr("Greeting","Hi {{user}}")]),{...set("Fill",[qr("Draft","/pass remains input")]),disableSend:true}]);
  try{
    const inputs:string[]=[],sent:string[]=[],errors:unknown[]=[];
    h.api.connectQuickReplyDocument({input:(value:string)=>inputs.push(value),send:(value:string)=>{sent.push(value);return Promise.resolve();},error:(error:unknown)=>errors.push(error)});
    h.settings.quickReplyV2={isEnabled:true,config:{setList:[{set:"Text"},{set:"Fill"}]}};
    await h.api.executeQuickReplyByName("Greeting");expect(inputs).toEqual(["Hi Reader "]);expect(sent).toEqual(["Hi Reader "]);
    await h.api.executeQuickReplyByName("Draft");expect(h.textarea.value).toBe("/pass remains input ");expect(sent).toHaveLength(1);
    h.sendButton.disabled=true;await h.api.executeQuickReplyByName("Greeting");expect(sent).toHaveLength(1);expect(errors).toEqual([]);
  }finally{h.close();}
});

it("matches automation IDs across global/chat/character configs in original order and awaits real slash writes",async()=>{
  const {h}=await fixture([set("Global",[qr("G","/setvar key=order {{getvar::order}}G"),qr("wrong","/setvar key=wrong yes",{automationId:"other"})]),
    set("Chat",[qr("C","/setvar key=order {{getvar::order}}C")]),set("Character",[qr("H","/setvar key=order {{getvar::order}}H")])]);
  try{
    h.context.characters[0].avatar="Actor.png";
    h.settings.quickReplyV2={isEnabled:true,config:{setList:[{set:"Global"},{set:"Missing"}]},characterConfigs:{"Actor.png":{setList:[{set:"Character"}]}}};
    h.context.chatMetadata.quickReply={setList:[{set:"Chat"}]};
    await h.api.eventSource.emit(h.api.event_types.WORLD_INFO_ACTIVATED,[{automationId:"wi"},{automationId:"wi"},{automationId:""}]);
    expect(h.context.chatMetadata.variables.order).toBe("GCH");expect(h.context.chatMetadata.variables.wrong).toBeUndefined();
    h.settings.quickReplyV2.isEnabled=false;await h.api.eventSource.emit(h.api.event_types.WORLD_INFO_ACTIVATED,[{automationId:"wi"}]);
    expect(h.context.chatMetadata.variables.order).toBe("GCH");
    h.settings.quickReplyV2.isEnabled=true;h.context.groupId="group";await h.api.eventSource.emit(h.api.event_types.WORLD_INFO_ACTIVATED,[{automationId:"wi"}]);
    expect(h.context.chatMetadata.variables.order).toBe("GCHGC");
  }finally{h.close();}
});

it("retains prevent-auto-execute nesting and stops delayed/remaining automation on the actual invocation signal",async()=>{
  const {h}=await fixture([set("Guard",[qr("Start","/trigger",{automationId:"start"}),qr("Nested","/setvar key=nested yes",{automationId:"nested"}),
    qr("Delay","/delay 60000 | /setvar key=late yes",{automationId:"cancel"}),qr("After","/setvar key=after yes",{automationId:"cancel"})])]);
  try{
    h.settings.quickReplyV2={isEnabled:true,config:{setList:[{set:"Guard"}]}};
    h.api.SlashCommandParser.addCommandObject(h.api.SlashCommand.fromProps({name:"trigger",callback:async()=>{await h.api.runQuickReplyAutomation("handleWIActivation",[{automationId:"nested"}]);return "";}}));
    await h.api.eventSource.emit(h.api.event_types.WORLD_INFO_ACTIVATED,[{automationId:"start"}]);expect(h.context.chatMetadata.variables.nested).toBeUndefined();
    const controller=new AbortController(),entries=[{automationId:"cancel"}];
    const running=h.api.withQuickReplyWorldInfoSignal(entries,controller.signal,()=>h.api.eventSource.emit(h.api.event_types.WORLD_INFO_ACTIVATED,entries));
    await new Promise(resolve=>setTimeout(resolve,5));expect(h.timers.size).toBe(1);controller.abort(new Error("cancel automation"));await running;
    expect(h.timers.size).toBe(0);expect(h.context.chatMetadata.variables.late).toBeUndefined();expect(h.context.chatMetadata.variables.after).toBeUndefined();
  }finally{h.close();}
});

it("returns actual QR slash mutations from a real awaited browser WI effect draft without canonical saves",async()=>{
  const b=browserMacroHarness(),{h}=await fixture([set("Draft",[qr("Update","/incvar count | /incglobalvar count")])],()=>b.draft.isMacroDraftActive());
  try{
    h.settings.quickReplyV2={isEnabled:true,config:{setList:[{set:"Draft"}]}};
    b.context.chatMetadata.variables={count:99};b.settings.variables={global:{count:88}};
    b.eventSource.on(b.event_types.WORLD_INFO_ACTIVATED,async(entries:any[])=>{
      h.context.chatMetadata=b.context.chatMetadata;h.settings.variables=b.settings.variables;
      await h.api.runQuickReplyAutomation("handleWIActivation",entries);
    });
    let result:any;
    b.setFetch(async(_url:any,init?:RequestInit)=>{result=JSON.parse(String(init?.body));return new Response('{}',{status:200,headers:{'Content-Type':'application/json'}});});
    // Use the same exported evaluator which the real effect responder invokes.
    const response=await b.respondToEffectRequest({requestId:"qr",conversationId:null,branchId:null,evaluation:{invocationId:"qr",ordinal:0,
      kind:"world-info-activated",local:{count:1},global:{count:2},payload:{scope:0,entries:[{automationId:"wi"}],timedWorldInfo:{}}}},new AbortController().signal);
    expect(response).toBeUndefined();
    expect(result).toMatchObject({result:{local:{count:2},global:{count:3}}});
    expect(b.context.chatMetadata.variables).toEqual({count:99});expect(b.settings.variables.global).toEqual({count:88});
    expect(h.traces.filter(item=>item[0]==="localSave"||item[0]==="globalSave")).toEqual([]);
  }finally{h.close();}
});

it.skipIf(!process.env.SILLYTAVERN_WORLD_INFO_ORACLE_ROOT)("matches pristine Quick Reply activation ordering, duplicate configs, nesting guard and failure continuation",async()=>{
  const path=join(resolve(process.env.SILLYTAVERN_WORLD_INFO_ORACLE_ROOT!),"public/scripts/extensions/quick-reply/src/AutoExecuteHandler.js"),source=readFileSync(path,"utf8");
  const sha=createHash("sha256").update(source).digest("hex");
  const manifest=JSON.parse(readFileSync(new URL("../quick-reply-upstream.json",import.meta.url),"utf8"));
  expect(sha).toBe(manifest.files.find((item:any)=>item.upstreamPath.endsWith("AutoExecuteHandler.js")).upstreamSha256);
  const ast:any=parse(source,{ecmaVersion:"latest",sourceType:"module"}),node=ast.body.map((item:any)=>item.declaration??item).find((item:any)=>item?.id?.name==="AutoExecuteHandler");
  const original:any[]=[],product:any[]=[],warnings:any[]=[],vm=createContext({warn:(...args:any[])=>warnings.push(args.map(String))});
  runInContext(source.slice(node.start,node.end),vm);const Original=runInContext("AutoExecuteHandler",vm);
  const rawSets=[set("Global",[qr("G","/oracle-capture G"),qr("Failure","/oracle-fail"),qr("Skip","/oracle-capture wrong",{automationId:"other"}),
    qr("Parent","/oracle-nested",{automationId:"parent"})]),
    set("Chat",[qr("C","/oracle-capture C")]),set("Character",[qr("H","/oracle-capture H")])];
  const {h}=await fixture(rawSets);
  try{
    h.context.characters[0].avatar="Actor.png";
    h.settings.quickReplyV2={isEnabled:true,config:{setList:[{set:"Global"},{set:"Missing"}]},characterConfigs:{"Actor.png":{setList:[{set:"Character"}]}}};
    h.context.chatMetadata.quickReply={setList:[{set:"Chat"},{set:"Global"}]};
    h.api.SlashCommandParser.addCommandObject(h.api.SlashCommand.fromProps({name:"oracle-capture",callback:(_args:any,value:string)=>{product.push(value);return "";}}));
    h.api.SlashCommandParser.addCommandObject(h.api.SlashCommand.fromProps({name:"oracle-fail",callback:()=>{product.push("failure");throw new Error("fixture failure");}}));
    const entries=[{automationId:"wi"},{automationId:"wi"},{automationId:""}];let handler:any;
    h.api.SlashCommandParser.addCommandObject(h.api.SlashCommand.fromProps({name:"oracle-nested",callback:async()=>{
      await h.api.runQuickReplyAutomation("handleWIActivation",entries);return "";}}));
    const originalSets=Object.fromEntries(rawSets.map((item:any)=>[item.name,{qrList:item.qrList.map((value:any)=>({...value,preventAutoExecute:true,
      execute:async(args:any)=>{expect(args).toEqual({isAutoExecute:true});if(value.label==="Failure"){original.push("failure");throw new Error("fixture failure");}
        if(value.label==="Parent"){await handler.handleWIActivation(entries);return;}
        original.push(value.message.replace("/oracle-capture ",""));}}))}]));
    const link=(name:string)=>({set:originalSets[name]??null}),settings={isEnabled:true,config:{setList:[link("Global"),link("Missing")]},
      chatConfig:{setList:[link("Chat"),link("Global")]},charConfig:{setList:[link("Character")]}};
    handler=new Original(settings);const phases:any[]=[];
    for(const phase of ["matching","disabled","nesting-guard"]){
      settings.isEnabled=phase!=="disabled";h.settings.quickReplyV2.isEnabled=settings.isEnabled;
      const startOriginal=original.length,startProduct=product.length;
      const activated=phase==="nesting-guard"?[{automationId:"parent"}]:entries;
      await handler.handleWIActivation(activated);await h.api.eventSource.emit(h.api.event_types.WORLD_INFO_ACTIVATED,activated);
      expect(product.slice(startProduct)).toEqual(original.slice(startOriginal));
      phases.push({name:phase,original:original.slice(startOriginal),product:product.slice(startProduct)});
    }
    expect(warnings).toHaveLength(2);
    const report=process.env.MYCOMPANION_QUICK_REPLY_ORACLE_REPORT;
    if(report)writeFileSync(resolve(report),JSON.stringify({passed:true,commit:manifest.commit,autoExecuteHandlerSha256:sha,phases,warnings},null,2));
  }finally{h.close();}
});
