import assert from 'node:assert/strict';
import {createServer} from 'node:http';

export async function verifyPluginOpenAISettings(window,service){
  const requests=[],stages=[];
  const model=createServer(async(request,response)=>{let raw='';for await(const chunk of request)raw+=chunk;const body=JSON.parse(raw);requests.push(body);
    if(body.stream){response.setHeader('Content-Type','text/event-stream');response.end('data: {"choices":[{"delta":{"content":"Settings reply"}}]}\n\ndata: [DONE]\n\n');}
    else {response.setHeader('Content-Type','application/json');response.end(JSON.stringify({choices:[{message:{content:'Settings reply'}}]}));}});
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
  const evaluate=async code=>{try{return await window.webContents.executeJavaScript(code);}catch(error){throw new Error('OpenAI settings fixture '+code.slice(0,90)+': '+error.message);}};
  const wait=async predicate=>{const end=Date.now()+10000;while(!await predicate()){if(Date.now()>end)throw new Error('Settings fixture wait timed out');await new Promise(resolve=>setTimeout(resolve,20));}};
  try{
    const initial={kind:'ollama',baseUrl:`http://127.0.0.1:${model.address().port}/v1`,model:'settings-baseline',temperature:0.6,maxTokens:1700};
    assert.equal((await service.inject({method:'PUT',url:'/api/settings/provider',payload:initial})).statusCode,200);
    const shared=await evaluate(`(async()=>{window.settingsCore=await import('/script.js');window.settingsOai=await import('/scripts/openai.js');window.settingsBridge=await import('/plugin-runtime/openai-settings.js');window.settingsRuntime=await import('/plugin-runtime/compat-runtime.js');await settingsBridge.refreshOpenAISettings();return settingsOai.oai_settings===settingsBridge.oai_settings && settingsRuntime.getContext().oaiSettings===settingsOai.oai_settings;})()`);
    assert(shared);
    await evaluate(`(async()=>{Object.assign(settingsOai.oai_settings,{custom_model:'extension-model',temp_openai:1.3,openai_max_tokens:2345,openai_max_context:10000,stream_openai:false,seed:17,top_p_openai:0.7,fixtureUnknown:{nested:['retained']}});settingsOai.proxies.push({name:'fixture-proxy',url:'http://example.invalid/v1',password:'fixture'});await settingsCore.saveSettings();})()`);
    const stored=(await service.inject({method:'GET',url:'/api/settings/provider'})).json();
    assert.equal(stored.model,'extension-model');assert.equal(stored.temperature,1.3);assert.equal(stored.maxTokens,2345);assert.equal(stored.contextLimitTokens,10000);
    assert.equal((await evaluate(`settingsOai.sendOpenAIRequest('normal',[{role:'user',content:'Extension settings input'}])`)).choices[0].message.content,'Settings reply');
    assert.equal(requests[0].stream,false);assert.equal(requests[0].model,'extension-model');assert.equal(requests[0].seed,17);assert.equal(requests[0].top_p,0.7);
    stages.push('shared-settings-save-updates-real-provider-and-request-sampling');

    const lookups=await evaluate(`(async()=>{const settings=settingsOai.oai_settings;settings.custom_model='gpt-4o';const tokens=await (await import('/scripts/tokenizers.js')).getTokenCountAsync('お誕生日おめでとう');const explicit=settingsOai.getChatCompletionModel({chat_completion_source:'makersuite',google_model:'explicit-google'});settings.media_inlining=false;const disabled=settingsOai.isImageInliningSupported();settings.media_inlining=true;const enabled=settingsOai.isImageInliningSupported();settings.custom_model='extension-model';return {tokens,explicit,disabled,enabled};})()`);
    assert.deepEqual(lookups,{tokens:14,explicit:'explicit-google',disabled:false,enabled:true});
    assert.equal((await service.inject({method:'GET',url:'/api/settings/provider'})).json().model,'extension-model');
    stages.push('unsaved-model-selection-affects-tokenizer-without-persistence-and-media-toggle-is-live');

    await evaluate(`(async()=>{const response=await fetch('/api/conversations/'+settingsCore.getCurrentChatId()+'/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:'Native settings input'})});if(!response.ok)throw new Error(await response.text());await response.text();await settingsCore.reloadCurrentChat();})()`);
    const native=requests.find(item=>item.stream);assert.equal(native.model,'extension-model');assert.equal(native.temperature,1.3);assert.equal(native.max_tokens,2345);
    stages.push('native-conversation-uses-the-provider-parameters-saved-by-extension');

    await evaluate(`(()=>{window.settingsFetch=window.fetch;window.settingsGate=new Promise(resolve=>{window.releaseSettingsGate=resolve;});window.settingsHeld=false;window.fetch=async(...args)=>{if(String(args[0]).includes('/extension-patch')&&!settingsHeld){settingsHeld=true;await settingsGate;}return settingsFetch(...args);};settingsOai.oai_settings.custom_model='queued-first';window.settingsSave1=settingsCore.saveSettings();settingsOai.oai_settings.custom_model='queued-last';window.settingsSave2=settingsCore.saveSettings();})()`);
    await wait(()=>evaluate(`settingsHeld`));await evaluate(`releaseSettingsGate()`);await evaluate(`Promise.all([settingsSave1,settingsSave2])`);await evaluate(`void(window.fetch=settingsFetch)`);
    assert.equal((await service.inject({method:'GET',url:'/api/settings/provider'})).json().model,'queued-last');
    stages.push('queued-setting-snapshots-rebase-on-own-prior-save-with-last-edit-preserved');

    await evaluate(`(()=>{settingsGate=new Promise(resolve=>{releaseSettingsGate=resolve;});settingsHeld=false;window.fetch=async(...args)=>{if(String(args[0]).includes('/extension-patch')&&!settingsHeld){settingsHeld=true;await settingsGate;}return settingsFetch(...args);};settingsOai.oai_settings.custom_model='stale-queued';window.settingsSave1=settingsCore.saveSettings();})()`);
    await wait(()=>evaluate(`settingsHeld`));
    await service.inject({method:'PUT',url:'/api/settings/provider',payload:{...initial,model:'newer-native',maxTokens:2600}});
    await evaluate(`releaseSettingsGate()`);await evaluate(`settingsSave1`);await evaluate(`void(window.fetch=settingsFetch)`);
    assert.equal((await service.inject({method:'GET',url:'/api/settings/provider'})).json().model,'newer-native');
    assert.equal(await evaluate(`settingsOai.oai_settings.custom_model`),'newer-native');assert.equal(await evaluate(`settingsOai.oai_settings.openai_max_tokens`),2600);
    stages.push('late-extension-save-preserves-newer-native-model-and-token-limit');

    const retried=await evaluate(`(async()=>{settingsOai.oai_settings.custom_model='retry-model';window.fetch=(...args)=>String(args[0]).includes('/extension-patch')?Promise.resolve(Response.json({error:{message:'Settings save fixture error'}},{status:503})):settingsFetch(...args);let failure='';try{await settingsCore.saveSettings();}catch(error){failure=error.message;}finally{window.fetch=settingsFetch;}await settingsCore.saveSettings();return failure;})()`);
    assert.match(retried,/Settings save fixture error/);assert.equal((await service.inject({method:'GET',url:'/api/settings/provider'})).json().model,'retry-model');
    stages.push('failed-provider-save-surfaces-error-and-next-save-recovers');

    await service.inject({method:'PUT',url:'/api/settings/provider',payload:{...initial,model:'refresh-first'}});
    await evaluate(`(()=>{window.settingsReadReleases=[];window.settingsReadReady=[];window.settingsReadCount=0;window.settingsReadGates=[0,1].map(index=>new Promise(resolve=>{settingsReadReleases[index]=resolve;}));window.fetch=async(...args)=>{if(String(args[0])==='/api/settings/provider'){const index=settingsReadCount++;const response=await settingsFetch(...args);settingsReadReady[index]=true;await settingsReadGates[index];return response;}return settingsFetch(...args);};window.settingsRefresh1=settingsBridge.refreshOpenAISettings();})()`);
    await wait(()=>evaluate(`settingsReadReady[0]===true`));
    await service.inject({method:'PUT',url:'/api/settings/provider',payload:{...initial,model:'refresh-current'}});
    await evaluate(`void(window.settingsRefresh2=settingsBridge.refreshOpenAISettings())`);await wait(()=>evaluate(`settingsReadReady[1]===true`));
    await evaluate(`settingsReadReleases[0]()`);await evaluate(`settingsRefresh1.then(()=>null)`);
    assert.equal(await evaluate(`settingsOai.oai_settings.custom_model`),'refresh-first');
    await evaluate(`settingsReadReleases[1]()`);await evaluate(`settingsRefresh2.then(()=>null)`);await evaluate(`void(window.fetch=settingsFetch)`);
    assert.equal(await evaluate(`settingsOai.oai_settings.custom_model`),'refresh-current');
    stages.push('concurrent-provider-reads-apply-completed-snapshots-before-newer-pending-reads');

    await new Promise(resolve=>{window.webContents.once('did-finish-load',resolve);window.webContents.reload();});
    const reloaded=await evaluate(`(async()=>{const host=await import('/plugin-runtime/desktop-host.js');await host.start();const core=await import('/scripts/openai.js');const context=(await import('/plugin-runtime/compat-runtime.js')).getContext();return {model:core.getChatCompletionModel(),extra:core.oai_settings.fixtureUnknown,proxy:core.proxies.find(item=>item.name==='fixture-proxy'),same:context.oaiSettings===core.oai_settings};})()`);
    assert.equal(reloaded.model,'refresh-current');assert.deepEqual(reloaded.extra,{nested:['retained']});assert.equal(reloaded.proxy.url,'http://example.invalid/v1');assert(reloaded.same);
    stages.push('full-document-reload-preserves-unknown-settings-and-proxy-list');
    await evaluate(`(async()=>{const core=await import('/scripts/openai.js');core.oai_settings.stream_openai=true;delete core.oai_settings.fixtureUnknown;core.proxies.splice(0,core.proxies.length);await (await import('/script.js')).saveSettings();})()`);
    return {stages,passed:true};
  }finally{await evaluate(`if(window.settingsFetch)window.fetch=settingsFetch;`).catch(()=>{});model.closeAllConnections();await new Promise(resolve=>model.close(resolve));}
}
