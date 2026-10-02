import { runInNewContext } from "node:vm";
import { expect,it,vi } from "vitest";
import { browserMacroHarness } from "./browser-macro-test-helper.js";
import { chatPersistenceSource } from "./plugin-runtime-chat.js";
import { extensionSettingsSource } from "./plugin-runtime-settings.js";
import { macroDraftSource } from "./plugin-runtime-macro-draft.js";
import type { BrowserMacroCall } from "./macro-boundary.js";

const event=(call:Partial<BrowserMacroCall>)=>({conversationId:null,branchId:null,evaluation:{ordinal:0,content:"",context:{},environment:{},local:{count:0},global:{count:0},...call}});
it.each([false,true])("keeps imported metadata and cached variable map references inside the restored draft (new=%s)",newEngine=>{
  const h=browserMacroHarness(),local={count:99,nested:{count:98},list:[7,8]},global={count:88},metadata={variables:local};
  h.context.chatMetadata=metadata;h.settings.variables={global};const variables=h.settings.variables;
  const cachedMetadata=h.context.chatMetadata,cachedLocal=local,cachedGlobal=global,cachedNested=local.nested,cachedArray=local.list;
  h.MacrosParser.registerMacro("m04CachedRefs",()=>{
    expect(h.context.chatMetadata).toBe(cachedMetadata);expect(h.settings.variables).toBe(variables);
    cachedLocal.count++;cachedGlobal.count++;cachedMetadata.variables.count++;
    cachedNested.count++;cachedArray.push(3);
    return String(cachedLocal.count)+"/"+cachedGlobal.count;
  });
  try{
    const result=h.evaluateBrowserMacro(event({content:"{{m04CachedRefs}}",local:{count:3,nested:{count:2},list:[1,2]},global:{count:4},context:{experimentalMacroEngine:newEngine,replaceCharacterCard:false}}));
    expect(result).toEqual({content:"5/5",local:{count:5,nested:{count:3},list:[1,2,3]},global:{count:5}});
    expect(h.context.chatMetadata).toBe(metadata);expect(metadata.variables).toBe(local);expect(h.settings.variables).toBe(variables);expect(variables.global).toBe(global);
    expect(local.nested).toBe(cachedNested);expect(local.list).toBe(cachedArray);
    expect(local).toEqual({count:99,nested:{count:98},list:[7,8]});expect(global).toEqual({count:88});expect(h.warning).not.toHaveBeenCalled();
  }finally{h.MacrosParser.unregisterMacro("m04CachedRefs");}
});
it.each([false,true])("executes real closures and providers using the selected draft and restores live state (new=%s)",newEngine=>{
  const h=browserMacroHarness(),savedMetadata={variables:{count:99}},savedVariables={global:{count:88}};
  h.context.chatMetadata=savedMetadata;h.settings.variables=savedVariables;
  let closureCalls=0,providerCalls=0;
  h.MacroEnvBuilder.registerProvider((env:any)=>{providerCalls++;env.extra.boundary="provided";});
  h.MacrosParser.registerMacro("m04Closure",()=>{closureCalls++;h.variables.incrementLocalVariable("count");h.variables.incrementGlobalVariable("count");return "closure";});
  h.registry.registerMacro("m04Registry",{handler:({env}:any)=>env.system.model+":"+env.names.char+":"+env.extra.boundary});
  try {
    const result=h.evaluateBrowserMacro(event({content:"{{m04Closure}}|{{m04Registry}}|{{model}}|{{maxContext}}|{{maxResponse}}|{{original}}|{{original}}",
      context:{experimentalMacroEngine:newEngine,replaceCharacterCard:false,model:"draft-model",characterName:"DraftActor",contextLimitTokens:8000,maxResponseTokens:96,original:"once"}}));
    expect(result).toEqual({content:"closure|draft-model:DraftActor:provided|draft-model|8000|96|once|",local:{count:1},global:{count:1}});
    expect(closureCalls).toBe(1);expect(providerCalls).toBe(1);
    expect(h.localSave).not.toHaveBeenCalled();expect(h.globalSave).not.toHaveBeenCalled();
    expect(h.context.chatMetadata).toBe(savedMetadata);expect(h.settings.variables).toBe(savedVariables);
    expect(h.context.name2).toBe("Actor");expect(h.oaiSettings.custom_model).toBe("fixture");
    expect(h.oaiSettings.openai_max_context).toBe(4096);expect(h.powerUser.experimental_macro_engine).toBe(false);
    expect(h.draft.isMacroDraftActive()).toBe(false);expect(h.warning).not.toHaveBeenCalled();
  } finally {h.MacrosParser.unregisterMacro("m04Closure");h.registry.unregisterMacro("m04Registry");}
});

it.each([false,true])("uses raw request-owned card sources and escapes only replacement values (new=%s)",newEngine=>{
  const h=browserMacroHarness();h.context.characters[0]!.data.description="live description";
  const card=h.evaluateBrowserMacro(event({content:"{{description}}/{{description}}",context:{experimentalMacroEngine:newEngine},
    environment:{characterFieldSources:{description:"{{incvar::count}}"}}}));
  expect(card.content).toBe("1/1");expect(card.local).toEqual({count:1});expect(h.context.chatMetadata).toEqual({});
  h.MacrosParser.registerMacro("m04EscapedValue","\n[a].*");
  try{
    const escaped=h.evaluateBrowserMacro(event({content:"^({{m04EscapedValue}})$",context:{experimentalMacroEngine:newEngine,replaceCharacterCard:false,escapeRegex:true}}));
    expect(escaped.content).toBe("^(\\n\\[a\\]\\.\\*)$");
  }finally{h.MacrosParser.unregisterMacro("m04EscapedValue");}
  expect(h.scriptData.getCharacterCardFieldsLazy().description).toBe("live description");
});

it("rejects a switched story before invoking closures and cancels a pending SSE read",async()=>{
  const h=browserMacroHarness();let calls=0;h.MacrosParser.registerMacro("m04Stale",()=>{calls++;return "old";});
  try{expect(()=>h.evaluateBrowserMacro({...event({content:"{{m04Stale}}"}),conversationId:"old"})).toThrow("故事已切换");expect(calls).toBe(0);}
  finally{h.MacrosParser.unregisterMacro("m04Stale");}
  const controller=new AbortController(),cancel=vi.fn();
  const response=new Response(new ReadableStream({cancel}),{headers:{"Content-Type":"text/event-stream"}});
  const result=h.readMacroResult(response,controller.signal),failed=expect(result).rejects.toThrow("cancel reader");
  controller.abort(new Error("cancel reader"));await failed;expect(cancel).toHaveBeenCalledTimes(1);
});

it.each([chatPersistenceSource,extensionSettingsSource])("does not capture, debounce or enqueue canonical saves during a synchronous macro draft",async source=>{
  const fetch=vi.fn(),timers=vi.fn(),capture=vi.fn();
  const stripped=(value:string)=>value.replace(/^import .*;\r?\n/gm,"").replace(/^export /gm,"");
  const draft=runInNewContext(stripped(macroDraftSource)+"\n;({runInMacroDraft,isMacroDraftActive})");
  const settings=source===extensionSettingsSource;
  const runtime=runInNewContext(stripped(source)+"\n;("+(settings?"{saveSettings,saveSettingsDebounced,registerSettingsParticipant}":"{saveChatConditional,saveMetadataDebounced,bindChatContext}")+")",{
    ...draft,window:{clearTimeout:vi.fn(),setTimeout:timers},clearTimeout:vi.fn(),setTimeout:timers,fetch,
  });
  if(settings)runtime.registerSettingsParticipant("test",capture);
  else runtime.bindChatContext({conversationId:"story",branchId:"branch",chat:[],chatMetadata:{}});
  const promise=draft.runInMacroDraft(()=>{settings?runtime.saveSettingsDebounced():runtime.saveMetadataDebounced();return settings?runtime.saveSettings():runtime.saveChatConditional();});
  await promise;expect(fetch).not.toHaveBeenCalled();expect(timers).not.toHaveBeenCalled();expect(capture).not.toHaveBeenCalled();
  expect(()=>draft.runInMacroDraft(()=>{throw new Error("draft failed");})).toThrow("draft failed");expect(draft.isMacroDraftActive()).toBe(false);
});
