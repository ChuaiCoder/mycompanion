import assert from 'node:assert/strict';
import {createServer} from 'node:http';

export async function verifyPluginPresets(window,service){
  const stages=[],requests=[];
  const model=createServer(async(request,response)=>{let raw='';for await(const chunk of request)raw+=chunk;requests.push(JSON.parse(raw));response.setHeader('Content-Type','application/json');response.end(JSON.stringify({choices:[{message:{content:'Preset reply'}}]}));});
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
  const evaluate=async code=>{try{return await window.webContents.executeJavaScript(code);}catch(error){throw new Error('Preset fixture '+code.slice(0,130)+': '+error.message);}};
  const wait=async code=>{const end=Date.now()+10000;while(!await evaluate(code)){if(Date.now()>end)throw new Error('Preset fixture wait: '+code);await new Promise(resolve=>setTimeout(resolve,20));}};
  try{
    const initial={kind:'ollama',baseUrl:`http://127.0.0.1:${model.address().port}/v1`,model:'preset-original',temperature:0.6,maxTokens:1500};
    assert.equal((await service.inject({method:'PUT',url:'/api/settings/provider',payload:initial})).statusCode,200);
    const identity=await evaluate(`(async()=>{window.presetModule=await import('/scripts/preset-manager.js');window.presetManager=presetModule.getPresetManager('openai');window.presetOai=await import('/scripts/openai.js');window.presetCore=await import('/script.js');window.presetEvents=await import('/plugin-runtime/compat-runtime.js');await presetModule.loadPresets();await (await import('/plugin-runtime/openai-settings.js')).refreshOpenAISettings();document.querySelector('button[aria-label="设置"]').click();return presetManager===(await import('/plugin-runtime/scripts/preset-manager.js')).getPresetManager();})()`);
    assert(identity);await wait(`document.querySelector('#settings_preset_openai')===presetManager.select[0]`);
    await evaluate(`[...document.querySelectorAll('nav button')].find(button=>button.querySelector('span')?.textContent==='故事').click()`);
    assert.equal(await evaluate(`document.querySelector('#settings_preset_openai')===presetManager.select[0]`),true);
    await evaluate(`document.querySelector('button[aria-label="设置"]').click()`);
    stages.push('canonical-manager-identity-and-real-select-in-react-settings');

    const selected=await evaluate(`(async()=>{window.presetLive=presetOai.oai_settings;window.presetSequence=[];window.presetBefore=async event=>{await new Promise(resolve=>setTimeout(resolve,5));presetSequence.push('before:'+event.presetName);if(event.presetName==='First')event.preset.temperature=1.1;};window.presetAfter=()=>presetSequence.push('after');window.presetChanged=event=>presetSequence.push('changed:'+event.name);presetEvents.eventSource.on(presetEvents.event_types.OAI_PRESET_CHANGED_BEFORE,presetBefore);presetEvents.eventSource.on(presetEvents.event_types.OAI_PRESET_CHANGED_AFTER,presetAfter);presetEvents.eventSource.on(presetEvents.event_types.PRESET_CHANGED,presetChanged);await presetManager.savePreset('First',{temperature:0.4,top_p:0.65,openai_max_tokens:2100,stream_openai:false,custom_model:'unbound-ignored',custom_url:'http://example.invalid',extensions:{fixture:{value:1}},future:{nested:['retained']},prompts:[{identifier:'test',content:'preserved'}]});await presetOai.sendOpenAIRequest('normal',[{role:'user',content:'Preset input'}]);return {same:presetLive===presetOai.oai_settings,value:presetManager.findPreset('First'),name:presetManager.getSelectedPresetName(),sequence:presetSequence};})()`);
    assert.deepEqual(selected,{same:true,value:'0',name:'First',sequence:['before:First','after','changed:First']});
    assert.equal(requests[0].temperature,1.1);assert.equal(requests[0].top_p,0.65);assert.equal(requests[0].max_tokens,2100);assert.equal(requests[0].model,'preset-original');
    const current=(await service.inject({method:'GET',url:'/api/settings/provider'})).json();assert.equal(current.temperature,1.1);assert.equal(current.baseUrl,initial.baseUrl);
    stages.push('awaited-preset-events-file-aliases-real-sampling-and-unbound-connection');

    await evaluate(`(async()=>{presetOai.oai_settings.bind_preset_to_connection=true;await presetManager.savePreset('Second',{temperature:0.2,stream_openai:false,custom_model:'bound-model',custom_url:${JSON.stringify(initial.baseUrl)},extensions:{fixture:{value:2}}});await presetOai.sendOpenAIRequest('normal',[{role:'user',content:'Bound request'}]);})()`);
    assert.equal(requests[1].model,'bound-model');assert.equal(requests[1].temperature,0.2);
    await wait(`[...document.querySelectorAll('.settings-form input')].some(input=>input.value==='bound-model')`);
    stages.push('bound-preset-updates-actual-provider-request-and-native-settings-ui');

    const extensions=await evaluate(`(async()=>{await presetManager.writePresetExtensionField({name:'First',path:'fixture.nonSelected',value:{value:7}});await presetManager.writePresetExtensionField({path:'fixture.active',value:[1,2]});return {first:presetManager.readPresetExtensionField({name:'First',path:'fixture.nonSelected'}),live:presetManager.readPresetExtensionField({path:'fixture.active'}),stored:presetManager.getCompletionPresetByName('Second').extensions.fixture.active};})()`);
    assert.deepEqual(extensions,{first:{value:7},live:[1,2],stored:[1,2]});
    stages.push('selected-and-nonselected-extension-fields-persist-in-the-correct-preset');

    const inserted=await evaluate(`(async()=>{const {presets,preset_names}=presetManager.getPresetList();presets.push({temperature:0.75,extensions:{helper:{created:true}}});preset_names.Helper=presets.length-1;presetManager.select.append($('<option>',{value:String(presets.length-1),text:'Helper',selected:false}));await presetManager.savePreset('Helper',presets[preset_names.Helper],{skipUpdate:true});return {selected:presetManager.getSelectedPresetName(),listed:presetManager.getAllPresets().includes('Helper')};})()`);
    assert.deepEqual(inserted,{selected:'Second',listed:true});
    assert((await service.inject({method:'GET',url:'/api/presets/openai'})).json().entries.some(entry=>entry.name==='Helper'));
    stages.push('helper-style-live-list-mutation-and-skipUpdate-save-without-selection');

    await evaluate(`(()=>{window.presetFetch=window.fetch;window.presetHeld=false;window.presetGate=new Promise(resolve=>{window.releasePresetGate=resolve;});window.fetch=async(...args)=>{if(String(args[0]).includes('/extension-patch')&&!presetHeld){presetHeld=true;await presetGate;}return presetFetch(...args);};presetOai.oai_settings.bind_preset_to_connection=false;window.presetSwitch1=presetManager.selectPreset(presetManager.findPreset('First'));window.presetSwitch2=presetManager.selectPreset(presetManager.findPreset('Second'));})()`);
    await wait(`presetHeld`);await evaluate(`releasePresetGate()`);await evaluate(`Promise.all([presetSwitch1,presetSwitch2])`);await evaluate(`void(window.fetch=presetFetch)`);
    assert.equal(await evaluate(`presetManager.getSelectedPresetName()`),'Second');assert.equal((await service.inject({method:'GET',url:'/api/settings/provider'})).json().temperature,0.2);
    stages.push('delayed-consecutive-switches-complete-in-order-with-last-selection-persisted');

    const failures=await evaluate(`(async()=>{window.fetch=(...args)=>String(args[0]).includes('/api/presets/')?Promise.resolve(Response.json({error:'fixture persistence error'},{status:503})):presetFetch(...args);const errors=[];for(const action of [()=>presetManager.savePreset('Failed',{temperature:0.9}),()=>presetManager.deletePreset('Second')]){try{await action();}catch(error){errors.push(error.message);}}window.fetch=presetFetch;return {count:errors.length,selected:presetManager.getSelectedPresetName(),failed:presetManager.getAllPresets().includes('Failed'),second:presetManager.getAllPresets().includes('Second')};})()`);
    assert.deepEqual(failures,{count:2,selected:'Second',failed:false,second:true});
    const rejected=await evaluate(`(async()=>{let failed=false;window.fetch=(...args)=>{if(String(args[0]).includes('/extension-patch')&&!failed){failed=true;return Promise.resolve(Response.json({error:{message:'preset apply failed'}},{status:503}));}return presetFetch(...args);};let error='';try{await presetManager.selectPreset(presetManager.findPreset('First'));}catch(reason){error=reason.message;}finally{window.fetch=presetFetch;}return {error,selected:presetManager.getSelectedPresetName(),temperature:presetOai.oai_settings.temp_openai};})()`);
    assert.match(rejected.error,/preset apply failed/);assert.equal(rejected.selected,'Second');assert.equal(rejected.temperature,0.2);
    stages.push('failed-persistence-retains-lists-and-failed-provider-application-rolls-back-selection');

    await evaluate(`(async()=>{presetManager.select.val(presetManager.findPreset('Helper')).trigger('change');await presetOai.getPresetApplicationPromise();await presetManager.renamePreset('Renamed');await presetManager.deletePreset('First');})()`);
    assert.equal(await evaluate(`presetManager.getSelectedPresetName()`),'Renamed');assert.equal(await evaluate(`presetManager.getAllPresets().includes('First')`),false);
    await evaluate(`presetManager.deletePreset('Renamed')`);assert.equal(await evaluate(`presetManager.getSelectedPresetName()`),'Second');
    stages.push('jquery-change-application-promise-rename-delete-and-fallback-selection');

    await new Promise(resolve=>{window.webContents.once('did-finish-load',resolve);window.webContents.reload();});
    const reloaded=await evaluate(`(async()=>{await (await import('/plugin-runtime/desktop-host.js')).start();window.presetModule=await import('/scripts/preset-manager.js');window.presetManager=presetModule.getPresetManager();window.presetOai=await import('/scripts/openai.js');return {names:presetManager.getAllPresets(),selected:presetManager.getSelectedPresetName(),extension:presetManager.readPresetExtensionField({path:'fixture.active'}),temp:presetOai.oai_settings.temp_openai};})()`);
    assert.deepEqual(reloaded,{names:['Second'],selected:'Second',extension:[1,2],temp:0.2});
    stages.push('full-document-reload-restores-preset-list-selection-and-extension-data');
    await evaluate(`(async()=>{await presetManager.deletePreset();presetOai.oai_settings.bind_preset_to_connection=false;presetOai.oai_settings.stream_openai=true;await (await import('/script.js')).saveSettings();})()`);
    assert.equal(await evaluate(`presetManager.getSelectedPresetName()`),'');
    stages.push('deleting-last-preset-keeps-current-generation-settings-and-clears-selection');
    return {passed:true,stages};
  }finally{await evaluate(`if(window.presetFetch)void(window.fetch=presetFetch);`).catch(()=>{});model.closeAllConnections();await new Promise(resolve=>model.close(resolve));}
}
