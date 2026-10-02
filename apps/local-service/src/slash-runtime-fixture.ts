import { readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { parse } from "acorn";
import * as macroEngine from "@mycompanion/macro-engine";
import { createCharacterMacroFieldsLazy, readCharacterMacroFields } from "@mycompanion/shared";
import { slashUpstreamAssets } from "./plugin-runtime-slash-upstream-assets.js";
import { slashRuntimeSource } from "./plugin-runtime-slash.js";
import { slashAdapterSource } from "./plugin-runtime-slash-adapter.js";
import { compatibilityRuntimeSource } from "./plugin-runtime-host.js";
import { variablesRuntimeSource } from "./plugin-runtime-variables.js";
import { macrosRuntimeSource } from "./plugin-runtime-macros.js";
import { scriptDataSource } from "./plugin-runtime-script-data.js";
import { expandTavernRandom } from "./tavern-random-core.js";
import { tavernTimeValue } from "./tavern-time-core.js";

// Execute the real served ESM graph; only native persistence/DOM boundaries are
// supplied by the fixture. The fixed-pristine oracle is opt-in and never needed
// by ordinary offline tests or distributed application code.
export async function createSlashFixture(upstreamRoot?: string,beforeSource?: string) {
  const context: Record<string, any> = {name1:"Reader",name2:"Actor",characterId:0,conversationId:"story-a",branchId:"branch-a",
    characters:[{name:"Actor",data:{}}],chat:[],chatMetadata:{variables:{}}};
  const settings = {variables:{global:{}}}, traces: any[] = [], timers = new Set<ReturnType<typeof setTimeout>>();
  let liveContext = context;
  const contextListeners: Function[] = [], windowListeners: Record<string,Function[]> = {};
  const power_user: Record<string,any> = {experimental_macro_engine:false,stscript:{parser:{flags:{}}}};
  const toastr = Object.fromEntries(["info","warning","error","success"].map(name=>[name,(...args:any[])=>{traces.push([name,...args]);return {css:()=>{}};}])) as Record<string,any>;
  toastr.options = {};
  const bindings: Record<string,any> = {...macroEngine,createCharacterMacroFieldsLazy,readCharacterMacroFields,expandTavernRandom,tavernTimeValue,
    context,settings,power_user,toastr,crypto:{randomUUID},
    bindChatContext:(value:any)=>{Object.assign(value,context);liveContext=value;},
    applyChatContext:(next:any)=>{if(next.chat)liveContext.chat.splice(0,liveContext.chat.length,...next.chat);if(next.chatMetadata)Object.assign(liveContext.chatMetadata,next.chatMetadata);},
    saveMetadataDebounced:()=>traces.push(["localSave",structuredClone(liveContext.chatMetadata)]),
    saveSettingsDebounced:()=>traces.push(["globalSave",structuredClone(settings)]),
    saveChatConditional:async()=>{traces.push(["chatSave"]);},
    saveSettings:async()=>{},onExtensionSettingsSaved:(fn:Function)=>{contextListeners.push(fn);return ()=>{};},
    messageFormatting:(value:string)=>value,addOneMessage:(message:any)=>traces.push(["render",message]),
    getCharacterCardFields:()=>({}),getCharacterCardFieldsLazy:()=>({})};
  const boundary = (names:string[]) => names.map(name=>`export const ${name}=globalThis.__bindings.${name};`).join("\n");
  const modules: Record<string,string> = {
    ...Object.fromEntries(Object.entries(slashUpstreamAssets).map(([path,source])=>[path.replace("/plugin-runtime", ""),source])),
    "/scripts/slash-commands.js":slashRuntimeSource,
    "/plugin-runtime/slash-adapter.js":slashAdapterSource,
    "/plugin-runtime/slash-utils.js":"export * from '/scripts/slash-commands/SlashUtils.js';",
    "/scripts/utils.js":"export * from '/scripts/slash-commands/SlashUtils.js'; export const escapeHtml = value=>String(value).replace(/[&<>]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[char]));",
    "/plugin-runtime/compat-runtime.js":compatibilityRuntimeSource,
    "/plugin-runtime/macros.js":macrosRuntimeSource,
    "/plugin-runtime/variables.js":variablesRuntimeSource,
    "/plugin-runtime/macro-draft.js":"export const isMacroDraftActive=()=>false;",
    "/plugin-runtime/vendor/macro-engine.js":boundary(Object.keys(macroEngine)),
    "/plugin-runtime/character-macro-fields.js":boundary(["createCharacterMacroFieldsLazy","readCharacterMacroFields"]),
    "/plugin-runtime/settings.js":boundary(["saveSettings","saveSettingsDebounced","onExtensionSettingsSaved"])+"\nexport const extension_settings=globalThis.__bindings.settings;",
    "/plugin-runtime/chat.js":boundary(["bindChatContext","applyChatContext","saveChatConditional","saveMetadataDebounced"])+"\nexport const saveMetadata=saveChatConditional;",
    "/plugin-runtime/message-rendering.js":boundary(["messageFormatting","addOneMessage"]),
    "/plugin-runtime/script-data.js":scriptDataSource,
    "/plugin-runtime/openai-settings.js":"export const oai_settings={openai_max_context:4096,openai_max_tokens:256};export const getChatCompletionModel=()=> 'fixture-model';",
    "/plugin-runtime/random-macros.js":boundary(["expandTavernRandom"]),
    "/plugin-runtime/time-macros.js":boundary(["tavernTimeValue"]),
    "/plugin-runtime/i18n.js":"export const getCurrentLocale=()=> 'zh-CN';",
    "/scripts/power-user.js":boundary(["power_user"]),
    "/scripts/i18n.js":"export const t=(strings,...values)=>typeof strings==='string'?strings:strings.reduce((out,str,i)=>out+str+(values[i]??''),'');",
    "/lib.js":"export const hljs=globalThis.hljs;export const DOMPurify={sanitize:value=>value};"+boundary(["toastr"]),
    "/scripts/popup.js":"export const POPUP_TYPE={TEXT:1}; export const callGenericPopup=async(...args)=>globalThis.__traces.push(['popup',...args]);",
    "/scripts/extensions.js":"export {extension_settings} from '/plugin-runtime/settings.js';export {saveMetadataDebounced} from '/plugin-runtime/chat.js';",
    "/plugin-runtime/templates.js":"export function renderExtensionTemplate(){throw new Error('Template DOM boundary is not available in this fixture');}export const renderExtensionTemplateAsync=renderExtensionTemplate;",
    "/script.js":`import {getContext} from '/plugin-runtime/compat-runtime.js';
      export {substituteParams} from '/plugin-runtime/macros.js';export {saveSettingsDebounced} from '/plugin-runtime/settings.js';
      export {extension_prompt_roles} from '/plugin-runtime/compat-runtime.js';export {system_message_types} from '/plugin-runtime/script-data.js';
      export const chat=getContext().chat,chat_metadata=getContext().chatMetadata,characters=getContext().characters;
      export const getCurrentChatId=()=>getContext().conversationId;`,
    "/entry.js":`export * from '/scripts/slash-commands.js';export * from '/plugin-runtime/slash-adapter.js';
      export {getContext,applyHostContext,registeredCommand,registerCommand,eventSource,event_types} from '/plugin-runtime/compat-runtime.js';
      export {SlashCommandParser,PARSER_FLAG} from '/scripts/slash-commands/SlashCommandParser.js';
      export {SlashCommand} from '/scripts/slash-commands/SlashCommand.js';export * from '/scripts/slash-commands/SlashCommandArgument.js';
      export {SlashCommandAbortController} from '/scripts/slash-commands/SlashCommandAbortController.js';
      export {SlashCommandClosure} from '/scripts/slash-commands/SlashCommandClosure.js';export {SlashCommandScope} from '/scripts/slash-commands/SlashCommandScope.js';`,
  };
  if(beforeSource)modules["/scripts/slash-commands.js"]=beforeSource;
  if (upstreamRoot) {
    const raw = (path:string)=>readFileSync(resolve(upstreamRoot,"public",path.replace(/^\//,"")),"utf8");
    const removeImports = (source:string,predicate:(node:any)=>boolean)=>{
      const ast:any=parse(source,{ecmaVersion:"latest",sourceType:"module"});
      for(const node of ast.body.filter(predicate).sort((a:any,b:any)=>b.start-a.start)) source=source.slice(0,node.start)+source.slice(node.end);
      return source;
    };
    for(const path of Object.keys(modules).filter(path=>path.startsWith("/scripts/slash-commands/")&&!/(SlashUtils|VariableCommands|DefaultCommands|SlashExecution|SlashCommandCommonEnumsProvider|SlashCommandReturnHelper)\.js$/.test(path))) {
      modules[path]=raw(path).replaceAll("from '../utils.js'","from '/plugin-runtime/slash-utils.js'");
    }
    modules["/scripts/slash-commands/SlashCommandParser.js"]=removeImports(modules["/scripts/slash-commands/SlashCommandParser.js"]!,
      node=>node.type==="ImportDeclaration"&&node.source.value.includes("AutoComplete"))+"\nimport {parseMacroContext} from '/oracle-macro-context.js';";
    // The original indexMacros calls remain. Its genuine parser helper is
    // extracted with Acorn; unavailable editor classes are never invoked.
    const helper=raw("/scripts/autocomplete/EnhancedMacroAutoCompleteOption.js"), ast:any=parse(helper,{ecmaVersion:"latest",sourceType:"module"});
    modules["/oracle-macro-context.js"]="import {ValidFlagSymbols} from '/plugin-runtime/vendor/macro-engine.js';\nconst MACRO_VARIABLE_SHORTHAND_PATTERN=/[a-zA-Z](?:[\\w\\-_]*[\\w])?/;\n"+
      ast.body.filter((rawNode:any)=>{const node=rawNode.declaration??rawNode;return ["FunctionDeclaration","VariableDeclaration"].includes(node.type);})
        .map((node:any)=>helper.slice(node.start,node.end)).join("\n");
    modules["/scripts/slash-commands/VariableCommands.js"]="export {registerVariableCommands} from '/scripts/variables.js';";
    modules["/scripts/variables.js"]=raw("/scripts/variables.js");
    // Import bridging is shared; original callbacks and wrappers are selected
    // from pristine source declarations, never from their adapted bodies.
    const defaults=raw("/scripts/slash-commands.js"), defaultAst:any=parse(defaults,{ecmaVersion:"latest",sourceType:"module"});
    const funcs=(names:string[])=>defaultAst.body.map((node:any)=>node.declaration??node).filter((node:any)=>node.type==="FunctionDeclaration"&&names.includes(node.id?.name))
      .map((node:any)=>defaults.slice(node.start,node.end)).join("\n\n");
    const functionNames=["runCallback","abortCallback","delayCallback","echoCallback"];
    const imports=removeImports(modules["/scripts/slash-commands/DefaultCommands.js"]!,node=>node.type!=="ImportDeclaration");
    const registrations=defaultAst.body.find((node:any)=>node.declaration?.id?.name==="initDefaultSlashCommands").declaration.body.body;
    const selected=registrations.filter((node:any)=>functionNames.includes(node.expression?.arguments?.[0]?.arguments?.[0]?.properties?.find((p:any)=>p.key?.name==="callback")?.value?.name)
      ||node.expression?.arguments?.[0]?.arguments?.[0]?.properties?.find((p:any)=>p.key?.name==="name")?.value?.value==="pass");
    modules["/scripts/slash-commands/DefaultCommands.js"]=imports+funcs(functionNames)+"\nexport function registerDefaultCommands(){\n"+selected.map((node:any)=>defaults.slice(node.start,node.end)).join("\n")+"\n}";
    const executionImports=removeImports(modules["/scripts/slash-commands/SlashExecution.js"]!,node=>node.type!=="ImportDeclaration");
    modules["/scripts/slash-commands/SlashExecution.js"]=executionImports+"\nconst parser=new SlashCommandParser();\n"+funcs(["executeSlashCommandsWithOptions","executeSlashCommands"])+"\nexport {executeSlashCommandsWithOptions,executeSlashCommands};";
  }
  const code=await build({entryPoints:["/entry.js"],bundle:true,write:false,format:"iife",globalName:"slashFixture",platform:"browser",
    plugins:[{name:"served-runtime",setup(buildApi){buildApi.onResolve({filter:/.*/},args=>({path:args.path.startsWith("/")?args.path:posix.resolve(posix.dirname(args.importer),args.path),namespace:"runtime"}));
      buildApi.onLoad({filter:/.*/,namespace:"runtime"},args=>{if(!(args.path in modules))throw new Error("Unmapped fixture import: "+args.path);return {contents:modules[args.path]!,loader:"js"};});}}]});
  const realm=createContext({__bindings:bindings,__traces:traces,console,crypto:{randomUUID},Event,Date,Intl,performance,structuredClone,Promise,
    setTimeout:(fn:Function,ms:number)=>{const timer=setTimeout(()=>{timers.delete(timer);fn();},ms);timers.add(timer);return timer;},
    clearTimeout:(timer:ReturnType<typeof setTimeout>)=>{timers.delete(timer);clearTimeout(timer);},
    window:{addEventListener:(name:string,fn:Function)=>{(windowListeners[name]??=[]).push(fn);}},
    document:{querySelector:()=>null}});
  runInContext(readFileSync(createRequire(import.meta.url).resolve("@highlightjs/cdn-assets/highlight.min.js"),"utf8"),realm);
  runInContext(code.outputFiles[0]!.text,realm);
  const api:any=runInContext("slashFixture",realm);
  return {api,context:api.getContext(),settings,power_user,traces,timers,close:()=>{api.abortSlashExecutions();for(const timer of timers)clearTimeout(timer);timers.clear();},
    pagehide:()=>windowListeners.pagehide?.forEach(fn=>fn()),
    acceptGenerationBranch:(detail:any)=>windowListeners['mycompanion:generation-branch-accepted']?.forEach(fn=>fn({detail}))};
}
