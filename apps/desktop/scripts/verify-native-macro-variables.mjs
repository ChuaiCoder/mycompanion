import assert from 'node:assert/strict';
import {createServer} from 'node:http';

// Uses a disposable model endpoint with the real renderer -> SSE -> repository
// path, including settings saves after a native global-variable commit.
export async function verifyNativeMacroVariables(window,service){
  const evaluate=code=>window.webContents.executeJavaScript(code),bodies=[];
  const provider=(await service.inject({method:'GET',url:'/api/settings/provider'})).json();
  const model=createServer(async(request,response)=>{
    let raw='';for await(const chunk of request)raw+=chunk;
    bodies.push(JSON.parse(raw));response.setHeader('Content-Type','application/json');
    response.end(JSON.stringify({choices:[{message:{content:'Native variables reply'}}]}));
  });
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
  try{
    const saved=await service.inject({method:'PUT',url:'/api/settings/provider',payload:{...provider,baseUrl:'http://127.0.0.1:'+model.address().port+'/v1'}});
    assert.equal(saved.statusCode,200);
    const result=await evaluate(`(async()=>{
      const core=await import('/script.js'),vars=await import('/scripts/variables.js'),host=await import('/plugin-runtime/desktop-host.js');
      const previous=core.chat_metadata.scenario;
      core.chat_metadata.scenario='NATIVE_STORE={{incvar::engineNativeLocal}}/{{incglobalvar::engineNativeGlobal}} ORDER={{getvar::engineOrder}}';
      vars.setLocalVariable('engineNativeLocal',0);vars.setGlobalVariable('engineNativeGlobal',0);await host.flush();
      const count=core.chat.length;
      try{
        core.setExtensionPrompt('review-unused','{{incvar::reviewUnused}}',-1,0,false,0);
        core.setExtensionPrompt('review-depth','{{incvar::reviewDepth}}',1,-1,false,0);
        core.setExtensionPrompt('review-filter','{{incvar::reviewFilter}}',1,0,false,0,async()=>false);
        core.setExtensionPrompt('review-scan','{{incvar::reviewScan}}',-1,0,true,0);
        core.setExtensionPrompt('review-sent','{{incvar::reviewSent}}',1,0,false,0);
        await host.prepareExtensionPrompts({skipWIAN:true});
        const skipSnapshot={sent:vars.getLocalVariable('reviewSent'),scan:vars.existsLocalVariable('reviewScan')};
        const world=await import('/scripts/world-info.js');
        await world.getWorldInfoPrompt([],4096,true);
        const scanSnapshot={sent:vars.getLocalVariable('reviewSent'),scan:vars.getLocalVariable('reviewScan')};
        delete core.extension_prompts['review-scan'];delete core.extension_prompts['review-sent'];
        await core.generateQuietPrompt({quietPrompt:'Preview native variables',dryRun:true});
        const preview={local:vars.getLocalVariable('engineNativeLocal'),global:vars.getGlobalVariable('engineNativeGlobal')};
        core.setExtensionPrompt('native-variable-order','{{setvar::engineOrder::8}}',1,0,false,0);
        const reply=await core.generateQuietPrompt({quietPrompt:'Generate native variables'});
        const live={local:vars.getLocalVariable('engineNativeLocal'),global:vars.getGlobalVariable('engineNativeGlobal')};
        await core.saveSettings();await host.flush();
        const excludedEffects=['reviewUnused','reviewDepth','reviewFilter'].filter(key=>vars.existsLocalVariable(key));
        return {preview,reply,live,skipSnapshot,scanSnapshot,excludedEffects,messageCount:core.chat.length,beforeCount:count,story:core.getCurrentChatId()};
      }finally{
        for(const key of ['unused','depth','filter','scan','sent'])delete core.extension_prompts['review-'+key];
        for(const key of ['Unused','Depth','Filter','Scan','Sent'])vars.deleteLocalVariable('review'+key);
        if(previous===undefined)delete core.chat_metadata.scenario;else core.chat_metadata.scenario=previous;
        delete core.extension_prompts['native-variable-order'];vars.deleteLocalVariable('engineOrder');
        await core.saveMetadata();
      }
    })()`);
    assert.deepEqual(result.preview,{local:0,global:0});assert.deepEqual(result.live,{local:1,global:1});
    assert.deepEqual(result.skipSnapshot,{sent:1,scan:false});assert.deepEqual(result.scanSnapshot,{sent:1,scan:1});
    assert.deepEqual(result.excludedEffects,[]);
    assert.equal(result.messageCount,result.beforeCount);assert.equal(result.reply,'Native variables reply');
    assert.equal(bodies.length,1);assert(JSON.stringify(bodies[0].messages).includes('NATIVE_STORE=1/1 ORDER=8'));
    const chat=(await service.inject({method:'GET',url:'/api/conversations/'+result.story})).json();
    const settings=(await service.inject({method:'GET',url:'/api/extensions/settings'})).json().extensionSettings;
    assert.equal(chat.chatMetadata.variables.engineNativeLocal,1);assert.equal(settings.variables.global.engineNativeGlobal,1);
    return {passed:true,providerRequests:bodies.length,stages:['native-dry-run-does-not-persist-macros','native-quiet-commits-once-and-updates-live-browser-stores','ordinary-browser-saves-preserve-native-global-commit','browser-snapshot-filters-before-macros-and-separates-scan-only-from-skipWIAN']};
  }finally{
    await service.inject({method:'PUT',url:'/api/settings/provider',payload:provider});
    model.closeAllConnections();await new Promise(resolve=>model.close(resolve));
  }
}
