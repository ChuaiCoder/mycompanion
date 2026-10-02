// Project-owned variable operations shared by browser persistence and native request drafts.
import {isTrueBoolean} from "./boolean.js";
export function createVariableStores(readLocal,readGlobal,onChange=()=>{}) {
const put=(object,key,value)=>Object.defineProperty(object,key,{value,enumerable:true,writable:true,configurable:true});
const own=(object,key)=>Object.hasOwn(object,key)?object[key]:undefined;
const store=global=>global?readGlobal():readLocal();
const save=global=>onChange(global);
function convert(value,type){
  switch(typeof type==='string'?type.trim().toLowerCase():''){
    case 'string':case 'str':return String(value);
    case 'null':return null;
    case 'undefined':case 'none':return undefined;
    case 'number':return Number(value);
    case 'int':return parseInt(value,10);
    case 'float':return parseFloat(value);
    case 'bool':case 'boolean':return isTrueBoolean(value);
    case 'array':case 'list':try{const parsed=JSON.parse(value);return Array.isArray(parsed)?parsed:[];}catch{return [];}
    case 'object':case 'dict':case 'dictionary':try{const parsed=JSON.parse(value);return typeof parsed==='object'?parsed:{};}catch{return {};}
    default:return value;
  }
}
function get(global,name,args={}){
  let value=own(store(global),args.key??name);
  if(args.index!==undefined){
    try{
      value=JSON.parse(value);const numeric=Number(args.index);
      value=own(value,Number.isNaN(numeric)?args.index:numeric);
      if(typeof value==='object')value=JSON.stringify(value);
    }catch{/* Tavern leaves malformed JSON unchanged. */}
  }
  return value?.trim?.()===''||Number.isNaN(Number(value))?(value||''):Number(value);
}
function set(global,name,value,args={}){
  if(!name)throw new Error('Variable name cannot be empty or undefined.');
  const target=store(global);
  if(args.index===undefined)put(target,name,value);
  else{
    try{
      const numeric=Number(args.index),isKey=Number.isNaN(numeric);
      const container=JSON.parse(own(target,name)??'null')??(isKey?{}:[]);
      put(container,isKey?args.index:numeric,convert(value,args.as));
      put(target,name,JSON.stringify(container));
    }catch{/* Invalid existing containers are retained, as in Tavern. */}
  }
  save(global);return value;
}
function add(global,name,value){
  const current=get(global,name)||0;
  try{const list=JSON.parse(current);if(Array.isArray(list)){list.push(value);set(global,name,JSON.stringify(list));return list;}}catch{}
  const next=Number.isNaN(Number(value))||Number.isNaN(Number(current))?String(current||'')+value:Number(current)+Number(value);
  if(typeof next==='number'&&Number.isNaN(next))return '';
  set(global,name,next);return next;
}
const exists=(global,name)=>own(store(global),name)!==undefined;
function remove(global,name){if(exists(global,name)){delete store(global)[name];save(global);}return '';}
const getLocalVariable=(name,args)=>get(false,name,args);
const getGlobalVariable=(name,args)=>get(true,name,args);
const setLocalVariable=(name,value,args)=>set(false,name,value,args);
const setGlobalVariable=(name,value,args)=>set(true,name,value,args);
const addLocalVariable=(name,value)=>add(false,name,value);
const addGlobalVariable=(name,value)=>add(true,name,value);
const incrementLocalVariable=name=>add(false,name,1);
const incrementGlobalVariable=name=>add(true,name,1);
const decrementLocalVariable=name=>add(false,name,-1);
const decrementGlobalVariable=name=>add(true,name,-1);
const existsLocalVariable=name=>exists(false,name);
const existsGlobalVariable=name=>exists(true,name);
const deleteLocalVariable=name=>remove(false,name);
const deleteGlobalVariable=name=>remove(true,name);
const variableStores = {
  local:{get:getLocalVariable,set:setLocalVariable,add:addLocalVariable,inc:incrementLocalVariable,dec:decrementLocalVariable,has:existsLocalVariable,delete:deleteLocalVariable},
  global:{get:getGlobalVariable,set:setGlobalVariable,add:addGlobalVariable,inc:incrementGlobalVariable,dec:decrementGlobalVariable,has:existsGlobalVariable,delete:deleteGlobalVariable},
};

return variableStores;
}

// Project-owned legacy replacement order, shared by the browser and native drafts.
export function createLegacyVariableMacroRules(stores) {
  return [false,true].flatMap(global=>{
    const {get,set,add}=stores[global?'global':'local'];
    const suffix=global?'globalvar':'var';
    return [
      {regex:new RegExp('{{set'+suffix+'::([^:]+)::([^}]*)}}','gi'),replace:(_,name,value)=>{set(name.trim(),value);return '';}},
      {regex:new RegExp('{{add'+suffix+'::([^:]+)::([^}]+)}}','gi'),replace:(_,name,value)=>{add(name.trim(),value);return '';}},
      {regex:new RegExp('{{inc'+suffix+'::([^}]+)}}','gi'),replace:(_,name)=>add(name.trim(),1)},
      {regex:new RegExp('{{dec'+suffix+'::([^}]+)}}','gi'),replace:(_,name)=>add(name.trim(),-1)},
      {regex:new RegExp('{{get'+suffix+'::([^}]+)}}','gi'),replace:(_,name)=>get(name.trim())},
    ];
  });
}
