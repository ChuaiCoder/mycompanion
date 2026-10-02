// Independently implemented against the public Tavern preset contract. Preset
// documents remain data; neither the upstream UI nor preset packs are embedded.
export const presetManagerSource = String.raw`
import {$,lodash} from '/plugin-runtime/libraries.js';
import {oai_settings,loadOpenAISettings,refreshOpenAISettings} from '/plugin-runtime/openai-settings.js';
import {saveSettings,extension_settings} from '/plugin-runtime/settings.js';
import {eventSource,event_types} from '/plugin-runtime/compat-runtime.js';
import {Popup} from '/plugin-runtime/popup.js';
const presets=[], preset_names=Object.create(null);
const clone=value=>structuredClone(value);
const aliases={temperature:'temp_openai',frequency_penalty:'freq_pen_openai',presence_penalty:'pres_pen_openai',top_p:'top_p_openai',top_k:'top_k_openai',top_a:'top_a_openai',min_p:'min_p_openai',repetition_penalty:'repetition_penalty_openai'};
const connectionFields=new Set(['chat_completion_source','group_models','sort_models','reverse_proxy','proxy_password','show_external_models','bypass_status_check','workers_ai_account_id','vertexai_auth_mode','vertexai_region','vertexai_express_project_id','azure_base_url','azure_deployment_name','azure_api_version','openrouter_use_fallback','openrouter_providers','openrouter_quantizations','openrouter_allow_fallbacks','openrouter_middleout','nanogpt_provider','nanogpt_payg_override']);
const connection=key=>connectionFields.has(key)||key.endsWith('_model')||key.endsWith('_endpoint')||key.startsWith('custom_');
const internal=new Set(['preset_settings_openai','bind_preset_to_connection']);
const assign=(target,source)=>Object.defineProperties(target,Object.getOwnPropertyDescriptors(clone(source)));
const select=$('<select>',{id:'settings_preset_openai','data-preset-manager-for':'openai','aria-label':'聊天补全预设'});
let ready,queue=Promise.resolve(),application=Promise.resolve();
const report=error=>{console.error(error);globalThis.toastr?.error(error.message,'预设操作失败');};
const notify=()=>window.dispatchEvent(new CustomEvent('mycompanion:presets-changed'));
const enqueue=action=>{const next=queue.catch(()=>{}).then(action);queue=next;return next;};
async function request(path,body){
  const response=await fetch('/api/presets/'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify({apiId:'openai',...body})})});
  if(!response.ok)throw new Error('Preset HTTP '+response.status+': '+await response.text());
  return response.json();
}
function render(){
  const name=oai_settings.preset_settings_openai;
  select.empty();
  for(const [name,index] of Object.entries(preset_names))select.append($('<option>',{value:String(index),text:name}));
  select.val(Object.hasOwn(preset_names,name)?String(preset_names[name]):null);
  notify();
}
function put(name,preset){
  const index=Object.hasOwn(preset_names,name)?preset_names[name]:presets.length;
  presets[index]=clone(preset);preset_names[name]=index;
}
export async function loadPresets(){
  return ready??=(async()=>{
    await loadOpenAISettings();
    const {entries}=await request('openai');
    presets.splice(0);for(const key of Object.keys(preset_names))delete preset_names[key];
    for(const {name,preset} of entries)put(name,preset);
    // The selected preset's live extensions are saved with application settings
    // even if an extension's separate preset-file debounce has not fired yet.
    // Restore that durable active snapshot before the Helper reads the list.
    const selected=oai_settings.preset_settings_openai;
    if(Object.hasOwn(preset_names,selected) && Object.hasOwn(extension_settings.__mycompanion_openai?.settings??{},'extensions'))
      presets[preset_names[selected]].extensions=clone(oai_settings.extensions);
    render();
  })().catch(error=>{ready=undefined;throw error;});
}
export function getChatCompletionPreset(settings=oai_settings){
  const result=clone(settings);
  for(const [file,live] of Object.entries(aliases))if(Object.hasOwn(result,live)){result[file]=result[live];delete result[live];}
  for(const key of internal)delete result[key];
  return result;
}
async function saveSnapshot(name,settings,triggerUi=true){
  const preset=getChatCompletionPreset(settings),result=await request('save',{name,preset});
  put(result.name,preset);render();
  if(triggerUi)await apply(result.name);
  return result.name;
}
async function apply(name){
  if(!Object.hasOwn(preset_names,name))throw new Error('Preset not found: '+name);
  await refreshOpenAISettings();
  const before=clone(oai_settings),previousName=before.preset_settings_openai;
  // Extensions may debounce their file write while immediately updating live
  // settings. Capture the outgoing extension data before switching owners; a
  // new owner's debounce must not cancel the only durable copy of this one.
  // Do not autosave unrelated sampling/prompt edits, or overwrite a same-name
  // preset that savePreset has just explicitly replaced.
  if(previousName!==name && Object.hasOwn(preset_names,previousName)) {
    const stored=presets[preset_names[previousName]];
    if(!lodash.isEqual(stored.extensions??{},before.extensions??{})) {
      const snapshot={...clone(stored),extensions:clone(before.extensions??{})};
      await request('save',{name:previousName,preset:snapshot});
      put(previousName,snapshot);
    }
  }
  const preset=clone(presets[preset_names[name]]),settingsToUpdate=Object.create(null);
  for(const key of Object.keys(preset))settingsToUpdate[key]=['',aliases[key]||key,typeof preset[key]==='boolean',connection(key)];
  await eventSource.emit(event_types.OAI_PRESET_CHANGED_BEFORE,{preset,presetName:name,presetNameBefore:before.preset_settings_openai,settingsToUpdate,settings:oai_settings,savePreset:saveSnapshot});
  const updates={extensions:{},preset_settings_openai:name};
  for(const [key,value] of Object.entries(preset)){
    if(internal.has(key))continue;
    const mapping=settingsToUpdate[key]||['',aliases[key]||key,false,connection(key)];
    if(mapping[3]&&!oai_settings.bind_preset_to_connection)continue;
    Object.defineProperty(updates,mapping[1],{value:clone(value),writable:true,enumerable:true,configurable:true});
  }
  assign(oai_settings,updates);
  try{await saveSettings();}
  catch(error){
    // Roll back only our unchanged applied fields, preserving later live edits.
    for(const key of Object.keys(updates))if(lodash.isEqual(oai_settings[key],updates[key])){
      if(Object.hasOwn(before,key))assign(oai_settings,{[key]:before[key]});else delete oai_settings[key];
    }
    render();
    try{await saveSettings();}catch(recovery){report(recovery);}
    throw error;
  }
  render();
  await eventSource.emit(event_types.OAI_PRESET_CHANGED_AFTER);
  await eventSource.emit(event_types.PRESET_CHANGED,{apiId:'openai',name});
}
export const getPresetApplicationPromise=()=>application;
const manager={
  apiId:'openai',select,
  getAllPresets:()=>select.find('option').map((_,el)=>el.text).toArray(),
  findPreset:name=>{const option=select.find('option').toArray().find(el=>el.text===name);return option?.value;},
  getSelectedPreset:()=>select.val()??undefined,
  getSelectedPresetName:()=>select.find('option:selected').text(),
  getPresetList(api='openai'){return api==='openai'?{presets,preset_names,settings:oai_settings}:{presets:[],preset_names:{},settings:{}};},
  getCompletionPresetByName:name=>Object.hasOwn(preset_names,name)?presets[preset_names[name]]:undefined,
  getPresetSettings:()=>getChatCompletionPreset(),
  isKeyedApi:()=>false,isAdvancedFormatting:()=>false,
  selectPreset(value){
    const name=Object.keys(preset_names).find(name=>String(preset_names[name])===String(value));
    application=enqueue(async()=>{await loadPresets();if(name===undefined)throw new Error('Preset value not found: '+value);await apply(name);});
    return application;
  },
  savePreset(name,settings,{skipUpdate=false}={}){
    const supplied=settings==null?null:clone(settings);
    return enqueue(async()=>{await loadPresets();if(supplied===null)await refreshOpenAISettings();const preset=supplied??getChatCompletionPreset();const saved=await request('save',{name,preset});
      if(!skipUpdate){put(saved.name,preset);render();await apply(saved.name);}
    });
  },
  updatePreset(options){return manager.savePreset(manager.getSelectedPresetName(),null,options);},
  async savePresetAs(){const name=await Popup.show.input('预设名称','',manager.getSelectedPresetName());if(name)await manager.savePreset(name);},
  updateList(name,preset){put(name,preset);render();application=enqueue(()=>apply(name));return application;},
  renamePreset(newName){const oldName=manager.getSelectedPresetName(),preset=getChatCompletionPreset();return enqueue(async()=>{
    const saved=await request('rename',{name:oldName,newName,preset}),index=preset_names[oldName];
    delete preset_names[oldName];preset_names[saved.name]=index;presets[index]=preset;
    oai_settings.preset_settings_openai=saved.name;render();await saveSettings();
  });},
  deletePreset(name=manager.getSelectedPresetName()){return enqueue(async()=>{
    await loadPresets();if(!Object.hasOwn(preset_names,name))return false;
    await request('delete',{name});delete preset_names[name];
    if(oai_settings.preset_settings_openai===name){
      oai_settings.preset_settings_openai='';render();
      const next=Object.keys(preset_names)[0];
      if(next!==undefined){try{await apply(next);}catch(error){await saveSettings();throw error;}}
      else await saveSettings();
    }
    render();return true;
  });},
  getDefaultPreset:name=>request('restore',{name}),
  readPresetExtensionField({name,path}){
    const selected=manager.getSelectedPresetName(),target=!name||name===selected?oai_settings:manager.getCompletionPresetByName(name);
    if(!target)return null;
    const extensions=lodash.isPlainObject(target.extensions)?target.extensions:{};
    return path?lodash.get(extensions,path,null):extensions;
  },
  writePresetExtensionField({name=manager.getSelectedPresetName(),path,value}){return enqueue(async()=>{
    const selected=name===manager.getSelectedPresetName(),stored=manager.getCompletionPresetByName(name);
    const change=source=>{const result=lodash.isPlainObject(source)?clone(source):{};if(path){lodash.set(result,path,clone(value));return result;}return clone(value);};
    if(stored){const snapshot=clone(stored);snapshot.extensions=change(snapshot.extensions);await request('save',{name,preset:snapshot});assign(stored,snapshot);}
    if(selected){oai_settings.extensions=change(oai_settings.extensions);await saveSettings();}
    notify();
  });},
};
select.on('change',()=>{void manager.selectPreset(select.val()).catch(error=>{render();report(error);});});
export function getPresetManager(apiId=''){return !apiId||apiId==='openai'?manager:null;}
// The same native select is displayed in the React settings page. Keeping its
// identity while navigating also preserves extension-added options/handlers.
export function mountPresetSelect(container){container.append(select[0]);return()=>select.detach();}
export async function flushPresetWrites(){await queue;}
`;
