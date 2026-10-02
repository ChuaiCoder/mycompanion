// Independently authored storage adapter for Tavern's legacy variable contract.
// Local writes use the chat queue (which captures the current story); global
// writes use the existing settings queue. Neither creates a parallel store.
export const variablesRuntimeSource = String.raw`
import {getContext} from '/plugin-runtime/compat-runtime.js';
import {saveMetadataDebounced} from '/plugin-runtime/chat.js';
import {extension_settings,saveSettingsDebounced} from '/plugin-runtime/settings.js';
import {createVariableStores,createLegacyVariableMacroRules} from '/plugin-runtime/vendor/macro-engine.js';
import {isMacroDraftActive} from '/plugin-runtime/macro-draft.js';
export const variableStores=createVariableStores(
  ()=>getContext().chatMetadata.variables??={},
  ()=>((extension_settings.variables??={}).global??={}),
  global=>{if(!isMacroDraftActive())global?saveSettingsDebounced():saveMetadataDebounced();});
export const getLocalVariable=(...args)=>variableStores.local.get(...args);
export const getGlobalVariable=(...args)=>variableStores.global.get(...args);
export const setLocalVariable=(...args)=>variableStores.local.set(...args);
export const setGlobalVariable=(...args)=>variableStores.global.set(...args);
export const addLocalVariable=(...args)=>variableStores.local.add(...args);
export const addGlobalVariable=(...args)=>variableStores.global.add(...args);
export const incrementLocalVariable=(...args)=>variableStores.local.inc(...args);
export const incrementGlobalVariable=(...args)=>variableStores.global.inc(...args);
export const decrementLocalVariable=(...args)=>variableStores.local.dec(...args);
export const decrementGlobalVariable=(...args)=>variableStores.global.dec(...args);
export const existsLocalVariable=(...args)=>variableStores.local.has(...args);
export const existsGlobalVariable=(...args)=>variableStores.global.has(...args);
export const deleteLocalVariable=(...args)=>variableStores.local.delete(...args);
export const deleteGlobalVariable=(...args)=>variableStores.global.delete(...args);
export function resolveVariable(name,scope=null){
  if(scope?.existsVariable(name))return scope.getVariable(name);
  if(existsLocalVariable(name))return getLocalVariable(name);
  return existsGlobalVariable(name)?getGlobalVariable(name):name;
}
export function getVariableMacros(){
  return createLegacyVariableMacroRules(variableStores);
}
`;
