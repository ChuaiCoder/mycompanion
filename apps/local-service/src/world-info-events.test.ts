import { expect, it, vi } from "vitest";
import { encodeWorldInfoGraph, decodeWorldInfoGraph } from "./world-info-event-graph.js";
import { browserMacroHarness } from "./browser-macro-test-helper.js";
import { runMacroBoundary, type BrowserEffectCall, type BrowserEffectResult, type BrowserEffectResolver } from "./macro-boundary.js";
import { MacroEvaluationSession } from "./prompt-macros.js";
import { matchLorebookEntries } from "./worldbook-engine.js";
import { getWorldInfoActivatedEntries, getWorldInfoOutlets } from "./world-info-activation.js";
import { createWorldInfoEffectsDraft, getWorldInfoEffects } from "./world-info-effects.js";
import type { CharacterLorebookEntry } from "@mycompanion/shared";
import { parseRegexFromString, worldInfoSettingsSchema } from "@mycompanion/shared";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { parse } from "acorn";
import { countTextTokens } from "./tokenizer-service.js";

const characterId="00000000-0000-4000-8000-000000000001";
const entry=(index:number,content:string,key:string,extra:Record<string,unknown>={}):CharacterLorebookEntry=>({index,name:String(index),
  content,keys:[key],secondaryKeys:[],enabled:true,constant:false,caseSensitive:false,selective:true,sourceEnabled:true,
  insertionOrder:100-index,worldInfo:{world:"events",uid:index,useProbability:false,...extra}});
function bridge(h=browserMacroHarness(),signal=new AbortController().signal) {
  let result:BrowserEffectResult|undefined;
  h.setFetch(async(_url:string|URL|Request,init?:RequestInit)=>{const value=JSON.parse(String(init?.body));if(value.error)throw new Error(value.error);result=value.result;return new Response('{}',{status:200});});
  const effects=Object.assign(vi.fn(async(call:BrowserEffectCall)=>{
    result=undefined;await h.respondToEffectRequest({conversationId:h.context.conversationId,branchId:h.context.branchId,requestId:crypto.randomUUID(),evaluation:call},signal);
    return result!;
  }),{dispose:(id:string)=>h.endEffectInvocation(id)}) satisfies BrowserEffectResolver;
  const macros=vi.fn(async(call:any)=>h.evaluateBrowserMacro({conversationId:h.context.conversationId,branchId:h.context.branchId,evaluation:call}));
  return {h,effects,macros,signal};
}

it("round-trips graph aliases, Map/Set keys, cycles and scalars while reusing identities across loops",()=>{
  const nativeObjects:object[]=[],browserObjects:object[]=[];
  const item:any={uid:1,missing:undefined,positive:Infinity,negative:-Infinity,nan:NaN,big:123n};item.self=item;
  const native:any={entries:[item],activated:new Map([["one",item]]),selected:new Set([item])};
  const browser=decodeWorldInfoGraph(encodeWorldInfoGraph(native,nativeObjects),browserObjects),remembered=browser.entries[0];
  expect(browser.activated.get("one")).toBe(remembered);expect(browser.selected.has(remembered)).toBe(true);expect(remembered.self).toBe(remembered);
  browser.entries[0].content="changed";browser.activated.set(remembered,browser.entries);browser.selected.add(browser.entries);
  const updated=decodeWorldInfoGraph(encodeWorldInfoGraph(browser,browserObjects),nativeObjects);
  expect(updated).toBe(native);expect(native.entries[0]).toBe(item);expect(native.activated.get(item)).toBe(native.entries);
  const next=decodeWorldInfoGraph(encodeWorldInfoGraph(native,nativeObjects),browserObjects);
  expect(next.entries[0]).toBe(remembered);expect(next.entries[0].content).toBe("changed");expect(next.entries[0].big).toBe(123n);
  expect(()=>encodeWorldInfoGraph({callback(){}})).toThrow("transportable data");
});

it("handles special property names as data without altering object prototypes",()=>{
  const raw=JSON.parse('{"__proto__":{"polluted":true},"constructor":"own"}');
  const restored=decodeWorldInfoGraph(encodeWorldInfoGraph(raw));
  expect(Object.getPrototypeOf(restored)).toBe(Object.prototype);expect(Object.hasOwn(restored,"__proto__")).toBe(true);
  expect(restored.__proto__.polluted).toBe(true);expect(({} as any).polluted).toBeUndefined();
});

it.each([false,true])("awaits real browser scan listeners once, retaining entry/timer identity and the variable draft across recursion (experimental=%s)",async experimental=>{
  const b=bridge(),session=new MacroEvaluationSession({variables:{count:0}},{variables:{global:{count:0}}});
  const local={count:99},global={count:88},timers={sticky:{old:{hash:0,start:0,end:1}}};
  b.h.context.chatMetadata={variables:local,timedWorldInfo:timers};b.h.settings.variables={global};
  let firstEntry:any,firstTimed:any;const loops:number[]=[];
  b.h.eventSource.on(b.h.event_types.WORLDINFO_SCAN_DONE,async(args:any)=>{
    loops.push(args.state.loopCount);await Promise.resolve();
    expect(b.h.context.chatMetadata.variables).toBe(local);expect(b.h.settings.variables.global).toBe(global);
    expect(b.h.context.chatMetadata.timedWorldInfo).toBe(timers);expect(b.h.draft.isMacroDraftActive()).toBe(true);
    b.h.variables.incrementLocalVariable("count");b.h.variables.incrementGlobalVariable("count");
    if(!firstEntry){firstEntry=args.sortedEntries[0];firstTimed=args.timedEffects;expect(args.new.successful[0]).toBe(firstEntry);
      firstEntry.content="LISTENER";firstEntry.order=305;firstEntry.position=7;firstEntry.outletName="story";
    }else {expect(args.sortedEntries[0]).toBe(firstEntry);expect(args.timedEffects).toBe(firstTimed);args.state.next=0;}
  });
  const report=await runMacroBoundary(session,b.signal,b.macros,()=>matchLorebookEntries(characterId,
    [entry(0,"second","first"),entry(1,"{{getvar::count}}/{{getglobalvar::count}}","second")],"Actor","first",1000,
    {macroSession:session,recursive:true,experimentalMacroEngine:experimental}),b.effects);
  expect(loops).toEqual([1,2]);expect(session.local).toEqual({count:2});expect(session.global).toEqual({count:2});
  expect(report.results.map(item=>item.content)).toEqual(["LISTENER","1/1"]);expect(report.results[0]!.insertionOrder).toBe(305);
  expect(getWorldInfoOutlets(report)).toEqual({story:"LISTENER"});expect(getWorldInfoActivatedEntries(report)[0]!.content).toBe("LISTENER");
  expect(local).toEqual({count:99});expect(global).toEqual({count:88});expect(timers).toEqual({sticky:{old:{hash:0,start:0,end:1}}});
  expect(b.h.localSave).not.toHaveBeenCalled();expect(b.h.globalSave).not.toHaveBeenCalled();expect(b.h.draft.isMacroDraftActive()).toBe(false);
  expect(b.effects.mock.calls.filter(([call])=>call.kind==="world-info-scan")).toHaveLength(2);
});

it("imports listener-added activation entries and honors mutated scalar loop/budget state",async()=>{
  const b=bridge(),session=new MacroEvaluationSession();let calls=0;
  b.h.eventSource.on(b.h.event_types.WORLDINFO_SCAN_DONE,async(args:any)=>{
    calls++;if(calls===1){const inserted={...args.sortedEntries[0],uid:90,content:"ADDED",position:7,outletName:"extra",order:9};
      args.activated.entries.set("events.90",inserted);args.activated.text="listener scan text";args.state.next=2;args.budget.current=999;
      args.sortedEntries.push({...inserted,uid:91,key:["listener scan text"],content:"NEXT"});
    }else args.state.next=0;
  });
  const report=await runMacroBoundary(session,b.signal,b.macros,()=>matchLorebookEntries(characterId,[entry(0,"ROOT","first")],"Actor","first",1000,{macroSession:session}),b.effects);
  expect(calls).toBe(2);expect(report.results.some(item=>item.uid===90&&item.content==="ADDED")).toBe(true);
  expect(getWorldInfoOutlets(report)).toEqual({extra:"ADDED"});expect(getWorldInfoActivatedEntries(report).some(item=>item.uid===90)).toBe(true);
});

it("runs genuine TimedEffects methods against draft metadata and returns accepted timer mutations",async()=>{
  const b=bridge(),session=new MacroEvaluationSession(),draft=createWorldInfoEffectsDraft({},characterId,[],4);
  b.h.eventSource.on(b.h.event_types.WORLDINFO_SCAN_DONE,(args:any)=>{
    args.timedEffects.setTimedEffect("sticky",args.sortedEntries[0],true);
    expect((b.h.context.chatMetadata.timedWorldInfo as any).sticky["events.0"]).toMatchObject({start:4,end:7});
  });
  const report=await runMacroBoundary(session,b.signal,b.macros,()=>matchLorebookEntries(characterId,[entry(0,"ROOT","first",{sticky:3})],"Actor","first",1000,
    {macroSession:session,effectsDraft:draft,dryRun:false}),b.effects);
  expect((getWorldInfoEffects(report)!.timedWorldInfo as any).sticky["events.0"]).toMatchObject({start:4,end:7});
  expect(b.h.context.chatMetadata).toEqual({});
});

it("takes actual world/uid force activations before scanning, honors decorators, and resets after a completed scan",async()=>{
  const b=bridge(),session=new MacroEvaluationSession();const forced={world:"events",uid:0,hash:10,key:[],keysecondary:[],content:"FORCED",order:50,disable:false,constant:false,useProbability:false};
  await b.h.eventSource.emit(b.h.event_types.WORLDINFO_FORCE_ACTIVATE,[forced]);
  const scan=(content="UNMATCHED")=>runMacroBoundary(session,b.signal,b.macros,()=>matchLorebookEntries(characterId,[entry(0,content,"missing")],"Actor","no match",1000,{macroSession:session}),b.effects);
  const first=await scan();expect(first.block).toBe("FORCED");expect(first.results[0]!.insertionOrder).toBe(50);
  expect((await scan()).block).toBe("");
  await b.h.eventSource.emit(b.h.event_types.WORLDINFO_FORCE_ACTIVATE,[forced]);
  expect((await scan("@@dont_activate\nBLOCKED")).block).toBe("");
});

it.each(["navigation","abort"])("releases an awaited scope on %s without late restoration or invoking the next listener",async mode=>{
  const controller=new AbortController(),b=bridge(undefined,controller.signal),session=new MacroEvaluationSession({variables:{count:1}});
  b.h.context.conversationId="old";b.h.context.branchId="old-branch";b.h.context.chatMetadata={variables:{count:99}};
  let enter!:(value?:unknown)=>void,finish!:(value?:unknown)=>void;
  const entered=new Promise(resolve=>{enter=resolve;}),pending=new Promise(resolve=>{finish=resolve;}),second=vi.fn();
  b.h.eventSource.on(b.h.event_types.WORLDINFO_SCAN_DONE,async()=>{b.h.variables.setLocalVariable("count",2);enter();await pending;});
  b.h.eventSource.on(b.h.event_types.WORLDINFO_SCAN_DONE,second);
  const running=runMacroBoundary(session,controller.signal,b.macros,()=>matchLorebookEntries(characterId,[entry(0,"ROOT","first")],"Actor","first",1000,{macroSession:session}),b.effects);
  const rejected=expect(running).rejects.toThrow();await entered;
  if(mode==="navigation"){
    b.h.scopes.cancelInvocationScopesForContext({conversationId:"new",branchId:"new-branch"},b.h.context);
    Object.assign(b.h.context,{conversationId:"new",branchId:"new-branch",chatMetadata:{variables:{count:77}}});
  }else controller.abort(new Error("cancel event"));
  await rejected;expect(b.h.draft.isMacroDraftActive()).toBe(false);expect(second).not.toHaveBeenCalled();expect(session.local).toEqual({count:1});
  const metadata=b.h.context.chatMetadata;finish();await Promise.resolve();await Promise.resolve();expect(b.h.context.chatMetadata).toBe(metadata);
  expect(b.h.context.chatMetadata.variables).toEqual({count:mode==="navigation"?77:99});
});

it.skipIf(!process.env.SILLYTAVERN_WORLD_INFO_ORACLE_ROOT)("matches pristine awaited scan mutation, forced activation and TimedEffects algorithms through the real browser bridge",async()=>{
  const sourceRoot=resolve(process.env.SILLYTAVERN_WORLD_INFO_ORACLE_ROOT!),source=readFileSync(join(sourceRoot,"public/scripts/world-info.js"),"utf8");
  const utils=readFileSync(join(sourceRoot,"public/scripts/utils.js"),"utf8"),sha=(text:string)=>createHash("sha256").update(text).digest("hex");
  expect(sha(source)).toBe("111c7f47945839e75b021e09bdbb112a54f0a9b7857d2b95435f573efc7cd9a5");
  const declaration=(body:string,name:string)=>{
    const node:any=parse(body,{ecmaVersion:"latest",sourceType:"module"}).body.map((item:any)=>item.type==="ExportNamedDeclaration"?item.declaration:item)
      .find((item:any)=>item?.id?.name===name||item?.declarations?.some((value:any)=>value.id?.name===name));
    if(!node)throw new Error("Missing pristine declaration "+name);return body.slice(node.start,node.end);
  };
  const names=["sortFn","DEFAULT_WEIGHT","MAX_SCAN_DEPTH","KNOWN_DECORATORS","scan_state","world_info_logic","defaultGlobalScanData",
    "world_info_position","wi_anchor_position","WorldInfoBuffer","WorldInfoTimedEffects","parseDecorators","filterGroupsByScoring","filterGroupsByTimedEffects","filterByInclusionGroups","checkWorldInfo"];
  const originals:any[]=[],metadata:Record<string,any>={},originalPhases:any[]=[],productPhases:any[]=[];
  const settings=worldInfoSettingsSchema.parse({world_info_recursive:false}),console={debug(){},log(){},warn(){},error(){}};
  const makeListener=(emitForce:(entries:any[])=>Promise<void>,phases:any[])=>{let remembered:any,timed:any;
    return async(args:any)=>{
      await Promise.resolve();phases.push({...args.state});
      if(args.state.loopCount===1){remembered=args.sortedEntries[0];timed=args.timedEffects;
        expect(args.new.successful[0]).toBe(remembered);remembered.content="EDITED";remembered.order=411;remembered.position=7;remembered.outletName="story";
        args.timedEffects.setTimedEffect("sticky",remembered,true);
        const added={...remembered,uid:90,hash:990,content:"ADDED",order:299,sticky:0};args.activated.entries.set("oracle.90",added);
        args.state.next=2;args.budget.current=999;args.budget.overflowed=false;
        await emitForce([{...args.sortedEntries[1],content:"FORCED"}]);
      }else{expect(args.sortedEntries[0]).toBe(remembered);expect(args.timedEffects).toBe(timed);args.state.next=0;}
    };
  };
  let originalListener!:(args:any)=>Promise<void>;
  const vm=createContext({...settings,chat_metadata:metadata,structuredClone,parseRegexFromString,console,toastr:{warning(){}},
    getContext:()=>({extensionPrompts:{},tagMap:{}}),getCharaFilename:()=>"Actor",getTagKeyForEntity:()=>undefined,this_chid:characterId,
    getExtensionPromptByName:async()=>"",getSortedEntries:async()=>originals,getTokenCountAsync:async(text:string)=>countTextTokens(text),
    substituteParams:(text:string)=>text,getRegexedString:(text:string)=>text,regex_placement:{WORLD_INFO:5},DEFAULT_DEPTH:4,
    extension_prompt_roles:{SYSTEM:0},shouldWIAddPrompt:false,event_types:{WORLDINFO_SCAN_DONE:"scan"},eventSource:{emit:async(_type:string,args:any)=>originalListener(args)},
  });
  runInContext(names.map(name=>declaration(source,name)).join("\n")+"\n"+["getStringHash","escapeRegex"].map(name=>declaration(utils,name)).join("\n"),vm);
  originalListener=makeListener(async entries=>{const map=runInContext("WorldInfoBuffer.externalActivations",vm);for(const raw of entries)map.set(raw.world+"."+raw.uid,raw);},originalPhases);
  const inputs=[entry(0,"ROOT","first",{world:"oracle",sticky:2}),entry(1,"UNMATCHED","missing",{world:"oracle"})];
  for(const value of inputs){const raw={...value.worldInfo,key:value.keys,keysecondary:value.secondaryKeys,content:value.content,decorators:[],disable:false,constant:false,
    selective:true,order:value.insertionOrder,caseSensitive:null,selectiveLogic:0,useProbability:false,probability:100,position:1};
    originals.push({...raw,hash:runInContext("getStringHash",vm)(JSON.stringify(raw))});}
  vm.world_info_budget=50;
  const original=await runInContext("checkWorldInfo",vm)(["first"],2000,false,{trigger:"normal"});
  const b=bridge(),session=new MacroEvaluationSession();
  b.h.eventSource.on(b.h.event_types.WORLDINFO_SCAN_DONE,makeListener(entries=>b.h.eventSource.emit(b.h.event_types.WORLDINFO_FORCE_ACTIVATE,entries),productPhases));
  const product=await runMacroBoundary(session,b.signal,b.macros,()=>matchLorebookEntries(characterId,inputs,"Actor","first",1000,{macroSession:session,dryRun:false,
    effectsDraft:createWorldInfoEffectsDraft({},characterId,[],1)}),b.effects);
  const originalEntries=[...original.allActivatedEntries].map((raw:any)=>({uid:raw.uid,content:raw.content,order:raw.order}));
  const productEntries=getWorldInfoActivatedEntries(product).map(raw=>({uid:raw.uid,content:raw.content,order:raw.order}));
  const timers=(value:any)=>Object.fromEntries(Object.entries(value).map(([type,entries]:any)=>[type,Object.fromEntries(Object.entries(entries).map(([key,effect]:any)=>{
    const {hash:_hash,...rest}=effect;return [key,rest];}))]));
  expect(productEntries).toEqual(originalEntries);expect(productPhases).toEqual(originalPhases);
  expect(getWorldInfoOutlets(product)).toEqual(Object.fromEntries(Object.entries(original.outletEntries).map(([key,values]:any)=>[key,values.join("\n")])));
  expect(timers(getWorldInfoEffects(product)!.timedWorldInfo)).toEqual(timers(metadata.timedWorldInfo));
  const report=process.env.MYCOMPANION_WORLD_INFO_EVENT_ORACLE_REPORT;
  if(report)writeFileSync(resolve(report),JSON.stringify({passed:true,commit:"7e8663cd9c184a550b37238218bdd32c6efc68e9",worldSourceSha256:sha(source),
    originalEntries,productEntries,originalPhases,productPhases,originalOutlets:original.outletEntries,productOutlets:getWorldInfoOutlets(product),
    originalTimers:metadata.timedWorldInfo,productTimers:getWorldInfoEffects(product)!.timedWorldInfo,
    normalization:"Timer hash is a native raw-entry JSON fingerprint; compare timing fields independently of host normalization field order."},null,2));
});
