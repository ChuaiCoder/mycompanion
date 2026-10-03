import { runInNewContext } from "node:vm";
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { macrosRuntimeSource } from "./plugin-runtime-macros.js";
import { macroRegistrySource } from "./plugin-runtime-macro-registry.js";
import { variablesRuntimeSource } from "./plugin-runtime-variables.js";
import { scriptDataSource } from "./plugin-runtime-script-data.js";
import { macroDraftSource, macroBoundaryBrowserSource } from "./plugin-runtime-macro-draft.js";
import { invocationScopesBrowserSource } from "./plugin-runtime-invocation-scopes.js";
import { worldInfoEventsBrowserSource } from "./plugin-runtime-world-info-events.js";
import { eventBusSource } from "./plugin-runtime-events.js";
import { createWorldInfoRuntime } from "./world-info-upstream-runtime.js";
import { encodeWorldInfoGraph, decodeWorldInfoGraph } from "./world-info-event-graph.js";
import { expandTavernRandom } from "./tavern-random-core.js";
import { tavernTimeValue } from "./tavern-time-core.js";
import { MacroEngine, MacroRegistry, MacroEnvironmentBuilder, env_provider_order, createVariableStores, createLegacyVariableMacroRules } from "@mycompanion/macro-engine";
import { createCharacterMacroFieldsLazy, readCharacterMacroFields } from "@mycompanion/shared";

/** Evaluate the exact served sources; imports are wired to their real contracts. */
export function browserMacroHarness() {
  const context = { name1:"Reader", name2:"Actor", characterId:0, conversationId:null as string|null, branchId:null as string|null,
    characters:[{name:"Actor",data:{}}] as Record<string, any>[],
    chat:[] as Record<string, unknown>[], chatMetadata:{} as Record<string, unknown>, extensionPrompts:{} as Record<string, any> };
  const settings: Record<string, any> = {}, localSave=vi.fn(), globalSave=vi.fn(), warning=vi.fn();
  let macros:any;
  let browserFetch=globalThis.fetch;
  const powerUser:Record<string, any>={experimental_macro_engine:false};
  const oaiSettings={openai_max_context:4096,openai_max_tokens:256,chat_completion_source:"custom",custom_model:"fixture"};
  const bindings:Record<string, any> = { getContext:()=>context, extension_settings:settings, saveMetadataDebounced:localSave,
    saveSettingsDebounced:globalSave, isTrueBoolean:(value:unknown)=>value===true||value==='true',
    Date, Intl, Promise, Error, AbortController, structuredClone, TextDecoder, TextEncoder, ReadableStream, Response,
    fetch:(...args:Parameters<typeof globalThis.fetch>)=>browserFetch(...args),
    console:{warn:warning,error:warning,log:vi.fn(),debug:vi.fn()}, crypto:{randomUUID}, document:{querySelector:()=>null},
    createWorldInfoRuntime,encodeWorldInfoGraph,decodeWorldInfoGraph,
    oai_settings:oaiSettings,getChatCompletionModel:()=>oaiSettings.custom_model,expandTavernRandom,
    tavernTimeValue,getCurrentLocale:()=>"zh-CN",MacroEngine,MacroRegistry,MacroEnvironmentBuilder,env_provider_order,createVariableStores,createLegacyVariableMacroRules,
    createCharacterMacroFieldsLazy,readCharacterMacroFields,
    substituteParams:(...args:any[])=>macros.substituteParams(...args),power_user:powerUser };
  const load=(source:string)=>runInNewContext(source.replace(/^import .*;\r?\n/gm,"").replace(/^export \{.*\} from .*;\r?\n/gm,"").replace(/^export /gm,"")+
    "\n;({"+[...source.matchAll(/^export (?:(?:async )?function|const|class) (\w+)/gm)].map(match=>match[1]).join(",")+"})",{...bindings});
  const draft=load(macroDraftSource);Object.assign(bindings,draft);
  const scopes=load(invocationScopesBrowserSource);Object.assign(bindings,scopes);
  const EventBus=runInNewContext(eventBusSource+'\nEventBus',{console:bindings.console});
  const eventSource=new EventBus(),event_types={WORLDINFO_SCAN_DONE:'worldinfo_scan_done',WORLDINFO_FORCE_ACTIVATE:'worldinfo_force_activate',WORLD_INFO_ACTIVATED:'world_info_activated'};
  Object.assign(bindings,{eventSource,event_types});
  Object.assign(bindings,{withQuickReplyWorldInfoSignal:(_entries:unknown,_signal:unknown,operation:()=>Promise<unknown>)=>operation()});
  const worldEvents=load(worldInfoEventsBrowserSource);Object.assign(bindings,worldEvents);
  Object.assign(bindings,{applyWorldInfoOutlets:({conversationId,branchId,outlets}:any)=>{
    if(context.conversationId!==conversationId||context.branchId!==branchId)return false;
    for(const key of Object.keys(context.extensionPrompts))if(key.startsWith('customWIOutlet_'))delete context.extensionPrompts[key];
    for(const [key,value] of Object.entries(outlets))context.extensionPrompts['customWIOutlet_'+key]={value,position:-1,depth:0,scan:false,role:0};
    return true;
  }});
  const variables=load(variablesRuntimeSource);
  Object.assign(bindings,{getVariableMacros:variables.getVariableMacros,getLocalVariable:variables.getLocalVariable,getGlobalVariable:variables.getGlobalVariable,variableStores:variables.variableStores});
  const scriptData=load(scriptDataSource);Object.assign(bindings,scriptData);
  macros=load(macrosRuntimeSource);
  Object.assign(bindings,{withWorldInfoOutlets:macros.withWorldInfoOutlets});
  Object.assign(bindings,{registry:MacroRegistry,MacrosParser:macros.MacrosParser});
  return { ...macros, ...load(macroBoundaryBrowserSource), scriptData, draft, registry:load(macroRegistrySource).MacroRegistry,
    variables, context, settings, localSave, globalSave, warning, powerUser, oaiSettings, load, scopes, eventSource, event_types, worldEvents,
    setFetch:(fetch:typeof globalThis.fetch)=>{browserFetch=fetch;} };
}
