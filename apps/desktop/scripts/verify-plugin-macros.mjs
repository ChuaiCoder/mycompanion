import assert from 'node:assert/strict';
import {createServer} from 'node:http';

export async function verifyPluginMacros(window,service){
  const stages=[],requests=[];
  const model=createServer(async(request,response)=>{
    let raw='';for await(const chunk of request)raw+=chunk;const body=JSON.parse(raw);requests.push(body);
    if(body.stream){response.setHeader('Content-Type','text/event-stream');response.end('data: {"choices":[{"delta":{"content":"Macro reply"}}]}\n\ndata: [DONE]\n\n');}
    else{response.setHeader('Content-Type','application/json');response.end(JSON.stringify({choices:[{message:{content:'Macro reply'}}]}));}
  });
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
  const evaluate=code=>window.webContents.executeJavaScript(code);
  const wait=async code=>{const end=Date.now()+10000;while(!await evaluate(code)){if(Date.now()>end)throw Error('Macro wait: '+code);await new Promise(resolve=>setTimeout(resolve,20));}};
  try{
    const baseline=await evaluate(`(async()=>{
      window.macroCore=await import('/script.js');window.macroApi=await import('/scripts/macros.js');window.macroVars=await import('/scripts/variables.js');
      window.macroHost=await import('/plugin-runtime/compat-runtime.js');
      const response=await fetch('/api/characters/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ch_name:'Macro actor',first_mes:'Macro opening',description:'Character sees {{char}} in {{random::sun::rain}}'})});
      if(!response.ok)throw Error(await response.text());const avatar=await response.text();
      await macroCore.getCharacters();await macroCore.selectCharacterById(macroCore.characters.findIndex(item=>item.avatar===avatar));
      const alias=await import('/plugin-runtime/scripts/macros.js');
      return {story:macroCore.getCurrentChatId(),avatar,same:alias.MacrosParser===macroApi.MacrosParser&&macroCore.substituteParams===macroHost.substituteParams&&macroHost.getContext().substituteParams===macroCore.substituteParams};
    })()`);
    assert(baseline.same);stages.push('canonical-macro-registry-and-host-substitution-in-real-extension-document');
    const registration=await evaluate(`(()=>{
      const nonces=[];macroHost.getContext().registerMacro('fixtureMacro',nonce=>{nonces.push(nonce);return 'VALUE';},'Fixture');
      const text=macroCore.substituteParamsExtended('{{fixtureMacro}}/{{fixtureMacro}}/{{original}}/{{original}}',{fixtureMacro:'overridden',original:'dynamic'});
      const original=macroCore.substituteParams('{{original}}/{{original}}',{original:'once'});
      return {text,original,calls:nonces.length,sameNonce:nonces[0]===nonces[1]};
    })()`);
    assert.deepEqual(registration,{text:'VALUE/VALUE/dynamic/dynamic',original:'once/',calls:2,sameNonce:true});
    stages.push('registered-callback-precedence-per-occurrence-nonce-and-original-once');

    assert.equal(await evaluate(`macroCore.substituteParams('{{getvar::macroCount}}/{{incvar::macroCount}}/{{setvar::macroCount::4}}{{addvar::macroCount::2}}/{{getvar::macroCount}}{{setglobalvar::macroShared::shared}}')`),'7/7//7');
    await evaluate(`(async()=>{await (await import('/plugin-runtime/chat.js')).flushChatSaves();await macroCore.saveSettings();})()`);
    assert.equal((await service.inject({method:'GET',url:'/api/conversations/'+baseline.story})).json().chatMetadata.variables.macroCount,7);
    assert.equal((await service.inject({method:'GET',url:'/api/extensions/settings'})).json().extensionSettings.variables.global.macroShared,'shared');
    stages.push('ordered-variable-macros-save-real-chat-metadata-and-global-sqlite-settings');

    const matching=await evaluate(`(async()=>{
      const regex=await import('/scripts/extensions/regex/engine.js');
      macroApi.MacrosParser.registerMacro('fixturePattern',()=> 'A+B');
      const rule={findRegex:'/{{fixturePattern}}/g',replaceString:'{{getvar::macroCount}}-{{fixtureMacro}}',substituteRegex:2,placement:[1],trimStrings:[]};
      return {replaced:regex.runRegexScript(rule,'A+B AAB'),last:macroApi.getLastMessageId({filter:item=>!item.is_user}),message:macroCore.substituteParams('{{lastCharMessage}}')};
    })()`);
    assert.deepEqual(matching,{replaced:'7-VALUE AAB',last:0,message:'Macro opening'});
    stages.push('registered-and-variable-macros-drive-real-regex-find-replacement-and-chat-history');

    await service.inject({method:'PUT',url:'/api/settings/provider',payload:{kind:'ollama',baseUrl:`http://127.0.0.1:${model.address().port}/v1`,model:'macro-fixture',maxTokens:400}});
    const preview=(await service.inject({method:'POST',url:'/api/conversations/'+baseline.story+'/prompt-preview',payload:{draft:'Budget sample'}})).json();
    const weather=/Character sees Macro actor in (sun|rain)/.exec(preview.messages.map(message=>message.content).join('\n'))?.[1];
    assert(weather);
    const cardText='Character name: Macro actor\n\nDescription:\nCharacter sees Macro actor in '+weather;
    const counted=(await service.inject({method:'POST',url:'/api/extensions/token-count',payload:{text:cardText,model:'macro-fixture'}})).json();
    assert.equal(preview.regions.find(region=>region.key==='character_core').tokens,counted.token_count);
    stages.push('native-card-macros-expand-before-budget-using-the-extension-bpe-endpoint');
    await evaluate(`(async()=>{await (await import('/plugin-runtime/openai-settings.js')).refreshOpenAISettings();await macroCore.generateRaw({prompt:'{{fixtureMacro}}/{{getvar::macroCount}}/{{getglobalvar::macroShared}}',systemPrompt:'{{char}}/{{lastCharMessage}}'});})()`);
    assert.deepEqual(requests[0].messages,[{role:'system',content:'Macro actor/Macro opening'},{role:'user',content:'VALUE/7/shared'}]);
    assert.equal(requests.length,1);
    assert.equal((await service.inject({method:'GET',url:'/api/conversations/'+baseline.story})).json().messages.length,1);
    stages.push('raw-generation-sends-expanded-macros-to-model-without-writing-chat');

    await evaluate(`macroCore.generateRaw({prompt:'{{random::sun::rain}}'})`);
    assert(['sun','rain'].includes(requests[1].messages.at(-1).content));
    stages.push('original-tavern-random-syntax-expands-in-real-extension-model-request');

    await evaluate(`(()=>{macroCore.setExtensionPrompt('macro-injection','MACRO_INJECT {{fixtureMacro}}/{{incvar::macroCount}}/{{getvar::macroCount}}',2,0,false,0);$('#send_textarea').val('Actual macro send').trigger('input');$('#send_but').trigger('click');})()`);
    await wait(`!macroCore.is_send_press&&macroCore.chat.at(-1)?.mes==='Macro reply'`);
    // Native completion also schedules a separate non-streaming memory job.
    const nativeRequests=requests.filter(request=>request.stream);
    assert.equal(nativeRequests.length,1);
    assert(nativeRequests[0].messages.some(message=>message.content==='MACRO_INJECT VALUE/8/8'));
    assert(nativeRequests[0].messages.some(message=>/Character sees Macro actor in (sun|rain)/.test(message.content)));
    await evaluate(`(async()=>{delete macroCore.extension_prompts['macro-injection'];await (await import('/plugin-runtime/chat.js')).flushChatSaves();})()`);
    const stored=(await service.inject({method:'GET',url:'/api/conversations/'+baseline.story})).json();
    assert.equal(stored.chatMetadata.variables.macroCount,8);assert(!JSON.stringify(stored.messages).includes('MACRO_INJECT'));
    stages.push('native-send-expands-browser-callback-and-variable-injection-once-before-model-request');

    const switched=await evaluate(`(async()=>{
      macroVars.setLocalVariable('beforeSwitch','captured');
      const response=await fetch('/api/characters/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ch_name:'Macro second',first_mes:'Second'})});const avatar=await response.text();
      await macroCore.getCharacters();await macroCore.selectCharacterById(macroCore.characters.findIndex(item=>item.avatar===avatar));
      const first=macroVars.getLocalVariable('macroCount');macroVars.setLocalVariable('macroCount',99);
      await (await import('/plugin-runtime/chat.js')).flushChatSaves();
      return {first,global:macroVars.getGlobalVariable('macroShared'),story:macroCore.getCurrentChatId()};
    })()`);
    assert.equal(switched.first,'');assert.equal(switched.global,'shared');
    const first=(await service.inject({method:'GET',url:'/api/conversations/'+baseline.story})).json();
    assert.equal(first.chatMetadata.variables.beforeSwitch,'captured');assert.equal(first.chatMetadata.variables.macroCount,8);
    assert.equal((await service.inject({method:'GET',url:'/api/conversations/'+switched.story})).json().chatMetadata.variables.macroCount,99);
    stages.push('story-navigation-flushes-captured-local-writes-and-isolates-current-chat-variables');

    await new Promise(resolve=>{window.webContents.once('did-finish-load',resolve);window.webContents.reload();});
    const reloaded=await evaluate(`(async()=>{
      await (await import('/plugin-runtime/desktop-host.js')).start();const core=await import('/script.js'),vars=await import('/scripts/variables.js'),macros=await import('/scripts/macros.js');
      await core.getCharacters();await core.selectCharacterById(core.characters.findIndex(item=>item.avatar===${JSON.stringify(baseline.avatar)}));
      const result={local:vars.getLocalVariable('macroCount'),global:vars.getGlobalVariable('macroShared'),registryEmpty:!macros.MacrosParser.has('fixtureMacro')};
      vars.deleteGlobalVariable('macroShared');await core.saveSettings();return result;
    })()`);
    assert.deepEqual(reloaded,{local:8,global:'shared',registryEmpty:true});
    stages.push('full-document-reload-restores-durable-variables-without-serializing-callback-functions');
    return {passed:true,stages};
  }finally{model.closeAllConnections();await new Promise(resolve=>model.close(resolve));}
}
