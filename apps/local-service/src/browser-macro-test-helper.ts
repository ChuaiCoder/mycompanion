import { runInNewContext } from "node:vm";
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { macrosRuntimeSource } from "./plugin-runtime-macros.js";
import { macroRegistrySource } from "./plugin-runtime-macro-registry.js";
import { variablesRuntimeSource } from "./plugin-runtime-variables.js";
import { scriptDataSource } from "./plugin-runtime-script-data.js";
import { macroDraftSource, macroBoundaryBrowserSource } from "./plugin-runtime-macro-draft.js";
import { expandTavernRandom } from "./tavern-random-core.js";
import { tavernTimeValue } from "./tavern-time-core.js";
import { MacroEngine, MacroRegistry, MacroEnvironmentBuilder, env_provider_order, createVariableStores, createLegacyVariableMacroRules } from "@mycompanion/macro-engine";
import { createCharacterMacroFieldsLazy, readCharacterMacroFields } from "@mycompanion/shared";

/** Evaluate the exact served sources; imports are wired to their real contracts. */
export function browserMacroHarness() {
  const context = { name1:"Reader", name2:"Actor", characterId:0, conversationId:null as string|null, branchId:null as string|null,
    characters:[{name:"Actor",data:{}}] as Record<string, any>[],
    chat:[] as Record<string, unknown>[], chatMetadata:{} as Record<string, unknown> };
  const settings: Record<string, any> = {}, localSave=vi.fn(), globalSave=vi.fn(), warning=vi.fn();
  let macros:any;
  let browserFetch=globalThis.fetch;
  const powerUser:Record<string, any>={experimental_macro_engine:false};
  const oaiSettings={openai_max_context:4096,openai_max_tokens:256,chat_completion_source:"custom",custom_model:"fixture"};
  const bindings:Record<string, any> = { getContext:()=>context, extension_settings:settings, saveMetadataDebounced:localSave,
    saveSettingsDebounced:globalSave, isTrueBoolean:(value:unknown)=>value===true||value==='true',
    Date, Intl, Promise, Error, AbortController, structuredClone, TextDecoder, TextEncoder, ReadableStream, Response,
    fetch:(...args:Parameters<typeof globalThis.fetch>)=>browserFetch(...args),
    console:{warn:warning}, crypto:{randomUUID}, document:{querySelector:()=>null},
    oai_settings:oaiSettings,getChatCompletionModel:()=>oaiSettings.custom_model,expandTavernRandom,
    tavernTimeValue,getCurrentLocale:()=>"zh-CN",MacroEngine,MacroRegistry,MacroEnvironmentBuilder,env_provider_order,createVariableStores,createLegacyVariableMacroRules,
    createCharacterMacroFieldsLazy,readCharacterMacroFields,
    substituteParams:(...args:any[])=>macros.substituteParams(...args),power_user:powerUser };
  const load=(source:string)=>runInNewContext(source.replace(/^import .*;\r?\n/gm,"").replace(/^export \{.*\} from .*;\r?\n/gm,"").replace(/^export /gm,"")+
    "\n;({"+[...source.matchAll(/^export (?:(?:async )?function|const|class) (\w+)/gm)].map(match=>match[1]).join(",")+"})",{...bindings});
  const draft=load(macroDraftSource);Object.assign(bindings,draft);
  const variables=load(variablesRuntimeSource);
  Object.assign(bindings,{getVariableMacros:variables.getVariableMacros,getLocalVariable:variables.getLocalVariable,getGlobalVariable:variables.getGlobalVariable,variableStores:variables.variableStores});
  const scriptData=load(scriptDataSource);Object.assign(bindings,scriptData);
  macros=load(macrosRuntimeSource);
  Object.assign(bindings,{registry:MacroRegistry,MacrosParser:macros.MacrosParser});
  return { ...macros, ...load(macroBoundaryBrowserSource), scriptData, draft, registry:load(macroRegistrySource).MacroRegistry,
    variables, context, settings, localSave, globalSave, warning, powerUser, oaiSettings, load,
    setFetch:(fetch:typeof globalThis.fetch)=>{browserFetch=fetch;} };
}
