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
import {invocationScopesBrowserSource} from "./plugin-runtime-invocation-scopes.js";
import {quickReplyUpstreamSource} from "./quick-reply-upstream.js";
import {quickReplyRuntimeSource} from "./plugin-runtime-quick-reply.js";
import {quickReplyDocumentSource} from "./plugin-runtime-quick-reply-document.js";
import {generationControlsSource} from "./plugin-runtime-generation-controls.js";
import {popupRuntimeSource} from "./plugin-runtime-popup.js";
import {slashPopupSource} from "./plugin-runtime-slash-popup.js";
import {slashInjectSource} from "./plugin-runtime-slash-inject.js";
import {quietGenerationSource} from "./plugin-runtime-quiet-generation.js";

// Execute the real served ESM graph; only native persistence/DOM boundaries are
// supplied by the fixture. The fixed-pristine oracle is opt-in and never needed
// by ordinary offline tests or distributed application code.
export async function createSlashFixture(upstreamRoot?: string,beforeSource?: string,options:{quickReplies?:boolean;generationControls?:boolean;domWindow?:any;onNativeStop?:()=>void;fetch?:typeof globalThis.fetch;isMacroDraftActive?:()=>boolean;saveSettings?:()=>Promise<void>}={}) {
  const context: Record<string, any> = {name1:"Reader",name2:"Actor",characterId:0,conversationId:"story-a",branchId:"branch-a",
    characters:[{name:"Actor",data:{}}],chat:[],chatMetadata:{variables:{}}};
  const settings:Record<string,any> = {variables:{global:{}}}, traces: any[] = [], timers = new Set<ReturnType<typeof setTimeout>>();
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
    saveSettings:async()=>{traces.push(["settingsSave"]);await options.saveSettings?.();},onExtensionSettingsSaved:(fn:Function)=>{contextListeners.push(fn);return ()=>{};},
    reloadCurrentChat:async()=>{traces.push(["chatReload",liveContext.conversationId]);},
    stopGeneration:()=>{const active=Boolean(liveContext.nativeGenerating);liveContext.nativeGenerating=false;traces.push(["generationStop",active]);options.onNativeStop?.();return active;},
    getTokenCountAsync:async(text:string)=>{traces.push(["tokenCount",text]);return 7;},
    messageFormatting:(value:string)=>value,addOneMessage:(message:any)=>traces.push(["render",message]),
    getCharacterCardFields:()=>({}),getCharacterCardFieldsLazy:()=>({})};
  const boundary = (names:string[]) => names.map(name=>`export const ${name}=globalThis.__bindings.${name};`).join("\n");
  const modules: Record<string,string> = {
    ...Object.fromEntries(Object.entries(slashUpstreamAssets).map(([path,source])=>[path.replace("/plugin-runtime", ""),source])),
    "/scripts/slash-commands.js":slashRuntimeSource,
    "/plugin-runtime/slash-adapter.js":slashAdapterSource,
    "/plugin-runtime/slash-popup.js":slashPopupSource,
    "/plugin-runtime/slash-inject.js":slashInjectSource,
    "/plugin-runtime/quiet-generation.js":quietGenerationSource,
    "/plugin-runtime/slash-utils.js":"export * from '/scripts/slash-commands/SlashUtils.js';",
    "/scripts/utils.js":"export * from '/scripts/slash-commands/SlashUtils.js'; export const escapeHtml = value=>String(value).replace(/[&<>]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[char]));",
    "/plugin-runtime/compat-runtime.js":compatibilityRuntimeSource,
    "/plugin-runtime/macros.js":macrosRuntimeSource,
    "/plugin-runtime/variables.js":variablesRuntimeSource,
    "/plugin-runtime/macro-draft.js":"export const isMacroDraftActive=()=>globalThis.__bindings.isMacroDraftActive?.()??false;",
    "/plugin-runtime/invocation-scopes.js":invocationScopesBrowserSource,
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
    "/scripts/tokenizers.js":boundary(["getTokenCountAsync"]),
    "/lib.js":"export const hljs=globalThis.hljs;export const DOMPurify={sanitize:value=>value};"+boundary(["toastr"]),
    "/scripts/popup.js":"export const POPUP_TYPE={TEXT:1,CONFIRM:2,INPUT:3},POPUP_RESULT={AFFIRMATIVE:1};export class Popup{constructor(){throw new Error('Use a DOM fixture for popup commands');}}export const PopupUtils={}; export const callGenericPopup=async(...args)=>globalThis.__traces.push(['popup',...args]);",
    "/scripts/extensions.js":"export {extension_settings} from '/plugin-runtime/settings.js';export {saveMetadataDebounced} from '/plugin-runtime/chat.js';export {getContext} from '/plugin-runtime/compat-runtime.js';",
    "/plugin-runtime/templates.js":"export function renderExtensionTemplate(){throw new Error('Template DOM boundary is not available in this fixture');}export const renderExtensionTemplateAsync=renderExtensionTemplate;",
    "/script.js":`import {getContext} from '/plugin-runtime/compat-runtime.js';
      export {substituteParams} from '/plugin-runtime/macros.js';export {saveSettings,saveSettingsDebounced} from '/plugin-runtime/settings.js';
      export {saveChatConditional} from '/plugin-runtime/chat.js';
      export const reloadCurrentChat=globalThis.__bindings.reloadCurrentChat,stopGeneration=globalThis.__bindings.stopGeneration;
      export {extension_prompt_roles,extension_prompt_types,extension_prompts,setExtensionPrompt,eventSource,event_types} from '/plugin-runtime/compat-runtime.js';export {system_message_types} from '/plugin-runtime/script-data.js';
      export const chat=getContext().chat,chat_metadata=getContext().chatMetadata,characters=getContext().characters;
      export const getCurrentChatId=()=>getContext().conversationId;`,
    "/entry.js":`export * from '/scripts/slash-commands.js';export * from '/plugin-runtime/slash-adapter.js';
      export {getContext,applyHostContext,registeredCommand,registerCommand,eventSource,event_types,snapshotExtensionPrompts,setExtensionPrompt} from '/plugin-runtime/compat-runtime.js';
      export {SlashCommandParser,PARSER_FLAG} from '/scripts/slash-commands/SlashCommandParser.js';
      export {SlashCommand} from '/scripts/slash-commands/SlashCommand.js';export * from '/scripts/slash-commands/SlashCommandArgument.js';
      export {SlashCommandAbortController} from '/scripts/slash-commands/SlashCommandAbortController.js';
      export {SlashCommandClosure} from '/scripts/slash-commands/SlashCommandClosure.js';export {SlashCommandScope} from '/scripts/slash-commands/SlashCommandScope.js';`,
  };
  if(options.domWindow){
    const require=createRequire(import.meta.url);
    bindings.DOMPurify=require('dompurify')(options.domWindow);
    bindings.$=require('jquery')(options.domWindow);
    modules['/lib.js']="export const hljs=globalThis.hljs;"+boundary(['DOMPurify','$','toastr'])+"\nexport const Cropper=undefined;";
    modules['/scripts/popup.js']=popupRuntimeSource;
    modules['/plugin-runtime/i18n.js']="export const getCurrentLocale=()=> 'en-US',translate=value=>value,applyLocale=value=>value;";
    modules['/entry.js']+="\nexport * from '/scripts/popup.js';";
  }
  if(options.generationControls){
    modules["/plugin-runtime/generation-controls.js"]=generationControlsSource;
    modules["/script.js"]=modules["/script.js"]!.replace(
      "export const reloadCurrentChat=globalThis.__bindings.reloadCurrentChat,stopGeneration=globalThis.__bindings.stopGeneration;",
      "export const reloadCurrentChat=globalThis.__bindings.reloadCurrentChat;\nexport {stopGeneration} from '/plugin-runtime/generation-controls.js';");
    modules["/entry.js"]+="\nimport {connectGenerationControls} from '/plugin-runtime/generation-controls.js';\n"+
      "connectGenerationControls({stop:globalThis.__bindings.stopGeneration,busy:()=>{},error:error=>{throw error;}});\n"+
      "export * from '/plugin-runtime/generation-controls.js';";
  }
  if(options.quickReplies){
    modules["/plugin-runtime/quick-reply-upstream.js"]=quickReplyUpstreamSource;
    modules["/plugin-runtime/quick-reply.js"]=quickReplyRuntimeSource;
    modules["/plugin-runtime/quick-reply-document.js"]=quickReplyDocumentSource;
    modules["/entry.js"]+="\nexport * from '/plugin-runtime/quick-reply.js';";
    modules["/entry.js"]+="\nexport * from '/plugin-runtime/quick-reply-document.js';";
  }
  bindings.isMacroDraftActive=options.isMacroDraftActive;
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
    const functionNames=["runCallback","abortCallback","delayCallback","echoCallback","setInputCallback","getMessagesCallback","trimStartCallback","trimEndCallback","inputCallback","popupCallback","buttonsCallback","injectCallback","listInjectsCallback","flushInjectsCallback","closureToFilter","processChatSlashCommands"];
    const imports=removeImports(modules["/scripts/slash-commands/DefaultCommands.js"]!,node=>node.type!=="ImportDeclaration");
    const registrations=defaultAst.body.find((node:any)=>node.declaration?.id?.name==="initDefaultSlashCommands").declaration.body.body;
    const names=["run","abort","delay","pass","echo","upper","lower","substr","replace","test","match","setinput","messages",
      "array-wrap","array-unwrap","trimstart","trimend","stop","chat-reload","forcesave","tokens","input","popup","buttons","inject","listinjects","flushinject"];
    const selected=registrations.filter((node:any)=>names.includes(node.expression?.arguments?.[0]?.arguments?.[0]?.properties?.find((p:any)=>p.key?.name==="name")?.value?.value));
    modules["/scripts/slash-commands/DefaultCommands.js"]=imports+"\nimport {Popup,callGenericPopup} from '/scripts/popup.js';\n"+
      "import {chat_metadata,extension_prompt_types,extension_prompt_roles,setExtensionPrompt,eventSource,event_types} from '/script.js';\n"+
      "import {getContext,saveMetadataDebounced} from '/scripts/extensions.js';\nconst SCRIPT_PROMPT_KEY='script_inject_';\n"+
      funcs(functionNames)+"\nexport {processChatSlashCommands};\nexport function registerDefaultCommands(){\n"+selected.map((node:any)=>defaults.slice(node.start,node.end)).join("\n")+"\n}";
    const rawUtils=raw("/scripts/utils.js"),utilsAst:any=parse(rawUtils,{ecmaVersion:"latest",sourceType:"module"}),originalUtilities=["regexFromString","stringToRange","trimToStartSentence","trimToEndSentence"];
    modules["/scripts/slash-commands/SlashUtils.js"]=removeImports(modules["/scripts/slash-commands/SlashUtils.js"]!,node=>originalUtilities.includes((node.declaration??node)?.id?.name))+"\n"+
      utilsAst.body.filter((node:any)=>originalUtilities.includes(node.declaration?.id?.name)).map((node:any)=>rawUtils.slice(node.start,node.end)).join("\n");
    const executionImports=removeImports(modules["/scripts/slash-commands/SlashExecution.js"]!,node=>node.type!=="ImportDeclaration");
    modules["/scripts/slash-commands/SlashExecution.js"]=executionImports+"\nconst parser=new SlashCommandParser();\n"+funcs(["executeSlashCommandsWithOptions","executeSlashCommands"])+"\nexport {executeSlashCommandsWithOptions,executeSlashCommands};";
  }
  modules['/entry.js']+="\nexport {generateQuietPrompt} from '/plugin-runtime/quiet-generation.js';";
  const code=await build({entryPoints:["/entry.js"],bundle:true,write:false,format:"iife",globalName:"slashFixture",platform:"browser",
    plugins:[{name:"served-runtime",setup(buildApi){buildApi.onResolve({filter:/.*/},args=>({path:args.path.startsWith("/")?args.path:posix.resolve(posix.dirname(args.importer),args.path),namespace:"runtime"}));
      buildApi.onLoad({filter:/.*/,namespace:"runtime"},args=>{if(!(args.path in modules))throw new Error("Unmapped fixture import: "+args.path);return {contents:modules[args.path]!,loader:"js"};});}}]});
  const textarea=options.domWindow?.document.querySelector('#send_textarea')??{value:"",focus:()=>traces.push(["focus"]),dispatchEvent:(event:Event)=>{traces.push(["input",textarea.value,event.type,event.bubbles]);return true;}};
  const sendButton=options.domWindow?.document.querySelector('#send_but')??{disabled:false,click:()=>traces.push(["send",textarea.value])};
  const dom=options.domWindow;
  const realm=createContext({__bindings:bindings,__traces:traces,console,toastr,crypto:{randomUUID},Event:dom?.Event??Event,DOMException:dom?.DOMException??DOMException,Date,Intl,performance,structuredClone,Promise,
    Node:dom?.Node,HTMLButtonElement:dom?.HTMLButtonElement,CSS:dom?.CSS,
    $:bindings.$??((selector:string)=>({val:(value:unknown)=>{if(selector!=="#send_textarea")throw new Error("Unmapped fixture DOM selector");textarea.value=String(value??"");return [textarea];}})),
    fetch:options.fetch??globalThis.fetch,
    setTimeout:(fn:Function,ms:number)=>{const timer=setTimeout(()=>{timers.delete(timer);fn();},ms);timers.add(timer);return timer;},
    clearTimeout:(timer:ReturnType<typeof setTimeout>)=>{timers.delete(timer);clearTimeout(timer);},
    window:dom??{addEventListener:(name:string,fn:Function)=>{(windowListeners[name]??=[]).push(fn);}},
    document:dom?.document??{body:{dataset:{}},querySelector:(selector:string)=>selector==="#send_textarea"?textarea:selector==="#send_but"?sendButton:null}});
  runInContext(readFileSync(createRequire(import.meta.url).resolve("@highlightjs/cdn-assets/highlight.min.js"),"utf8"),realm);
  runInContext(code.outputFiles[0]!.text,realm);
  const api:any=runInContext("slashFixture",realm);
  return {api,context:api.getContext(),settings,power_user,traces,timers,textarea,sendButton,close:()=>{api.abortSlashExecutions();for(const timer of timers)clearTimeout(timer);timers.clear();},
    pagehide:()=>dom?dom.dispatchEvent(new dom.Event('pagehide')):windowListeners.pagehide?.forEach(fn=>fn()),
    acceptGenerationBranch:(detail:any)=>dom?dom.dispatchEvent(new dom.CustomEvent('mycompanion:generation-branch-accepted',{detail})):windowListeners['mycompanion:generation-branch-accepted']?.forEach(fn=>fn({detail}))};
}
