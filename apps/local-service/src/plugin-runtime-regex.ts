import { createTavernRegexEngine } from "./tavern-regex-core.js";
export const regexCoreSource = `export const createTavernRegexEngine = ${createTavernRegexEngine.toString()};`;
export const regexRuntimeSource = String.raw`
import {createTavernRegexEngine} from '/plugin-runtime/regex-core.js';
import {getContext,substituteParams} from '/plugin-runtime/compat-runtime.js';
import {extension_settings,saveSettings,saveSettingsDebounced} from '/plugin-runtime/settings.js';
import {getPresetManager} from '/plugin-runtime/presets.js';
import {writeExtensionField} from '/plugin-runtime/character-fields.js';
import {lodash} from '/plugin-runtime/libraries.js';
import {getCharacters} from '/plugin-runtime/characters.js';
import {updateMessageBlock} from '/plugin-runtime/message-rendering.js';
const engine=createTavernRegexEngine((text,escape=value=>value,characterOverride)=>substituteParams(text,{name2Override:characterOverride,postProcessFn:escape}));
export const {regex_placement,substitute_find_regex,RegexProvider,runRegexScript}=engine;
export const SCRIPT_TYPES={GLOBAL:0,PRESET:2,SCOPED:1},SCRIPT_TYPE_UNKNOWN=-1;
const selected=()=>getContext().characters[getContext().characterId];
export const getCurrentPresetAPI=()=>getPresetManager()?.apiId??null;
export const getCurrentPresetName=()=>getPresetManager()?.getSelectedPresetName()??null;
export const isScopedScriptsAllowed=character=>!!character?.avatar&&(Array.isArray(extension_settings.character_allowed_regex)?extension_settings.character_allowed_regex.includes(character.avatar):!!character?.data?.extensions?.regex_scripts?.some(script=>!script.disabled));
export const isPresetScriptsAllowed=(api,name)=>!!api&&!!name&&!!extension_settings.preset_allowed_regex?.[api]?.includes(name);
export function getScriptsByType(type,{allowedOnly=false}={}){
  let scripts;
  if(type===SCRIPT_TYPES.GLOBAL)scripts=extension_settings.regex;
  else if(type===SCRIPT_TYPES.SCOPED){if(allowedOnly&&!isScopedScriptsAllowed(selected()))return [];scripts=selected()?.data?.extensions?.regex_scripts;}
  else if(type===SCRIPT_TYPES.PRESET){if(allowedOnly&&!isPresetScriptsAllowed(getCurrentPresetAPI(),getCurrentPresetName()))return [];scripts=getPresetManager()?.readPresetExtensionField({path:'regex_scripts'});}
  return Array.isArray(scripts)?scripts:[];
}
export const getRegexScripts=(options={})=>Object.values(SCRIPT_TYPES).flatMap(type=>getScriptsByType(type,options));
export const getRegexDisplayKey=()=>JSON.stringify([getRegexScripts({allowedOnly:true}),extension_settings.disabledExtensions?.includes('regex'),getContext().chat.length,getContext().name1,getContext().name2]);
export function getRegexedString(text,placement,options={}){
  if(typeof text!=='string')return '';
  if(extension_settings.disabledExtensions?.includes('regex')||!text||placement===undefined)return text;
  return engine.getRegexedString(text,placement,getRegexScripts({allowedOnly:true}),options);
}
function allow(path,value,enabled){
  if(!value)return;
  let list=lodash.get(extension_settings,path);
  if(!Array.isArray(list)){if(!enabled)return;lodash.set(extension_settings,path,list=[]);}
  const index=list.indexOf(value);
  if(enabled&&index<0)list.push(value);else if(!enabled&&index>=0)list.splice(index,1);else return;
  saveSettingsDebounced();
}
export const allowScopedScripts=character=>allow(['character_allowed_regex'],character?.avatar,true);
export const disallowScopedScripts=character=>allow(['character_allowed_regex'],character?.avatar,false);
export const allowPresetScripts=(api,name)=>{if(api)allow(['preset_allowed_regex',api],name,true);};
export const disallowPresetScripts=(api,name)=>{if(api)allow(['preset_allowed_regex',api],name,false);};
export async function saveScriptsByType(scripts,type){
  if(!Array.isArray(scripts))throw new TypeError('Regex scripts must be an array');
  if(type===SCRIPT_TYPES.GLOBAL){extension_settings.regex=scripts;await saveSettings();}
  else if(type===SCRIPT_TYPES.SCOPED)await writeExtensionField(getContext().characterId,'regex_scripts',scripts);
  else if(type===SCRIPT_TYPES.PRESET)await getPresetManager().writePresetExtensionField({path:'regex_scripts',value:scripts});
}
export function formatRegexDisplay(text,name,isSystem,isUser,messageId,isReasoning){
  if(isSystem)return text;
  return getRegexedString(text,isReasoning?regex_placement.REASONING:isUser?regex_placement.USER_INPUT:regex_placement.AI_OUTPUT,
    {isMarkdown:true,characterOverride:name,...(messageId>=0?{depth:getContext().chat.length-Number(messageId)-1}:{})});
}
window.addEventListener('mycompanion:regex-rules',event=>{void(async()=>{
  await getCharacters();const character=getContext().characters.find(item=>item.id===event.detail.id);
  if(event.detail.enabled&&character&&!isScopedScriptsAllowed(character)){allowScopedScripts(character);await saveSettings();}
  for(const [index,message] of getContext().chat.entries())updateMessageBlock(index,message);
})().catch(error=>console.error('Regex refresh failed',error));});
`;
