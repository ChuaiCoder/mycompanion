import assert from 'node:assert/strict';
import {createServer} from 'node:http';

export async function verifyPluginRegex(window,service){
  const stages=[],requests=[];
  const model=createServer(async(request,response)=>{let raw='';for await(const chunk of request)raw+=chunk;const body=JSON.parse(raw);requests.push(body);if(body.stream){response.setHeader('Content-Type','text/event-stream');response.end('data: {"choices":[{"delta":{"content":"model"}}]}\n\ndata: [DONE]\n\n');}else{response.setHeader('Content-Type','application/json');response.end(JSON.stringify({choices:[{message:{content:'model'}}]}));}});
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
  const evaluate=async code=>{try{return await window.webContents.executeJavaScript(code);}catch(error){throw new Error('Regex fixture '+code.slice(0,100)+': '+error.message);}};
  const wait=async code=>{const end=Date.now()+10000;while(!await evaluate(code)){if(Date.now()>end)throw new Error('Regex fixture wait: '+code);await new Promise(resolve=>setTimeout(resolve,20));}};
  let original;
  try{
    original=await evaluate(`(async()=>{window.regexCore=await import('/script.js');window.regexEngine=await import('/scripts/extensions/regex/engine.js');window.regexExtensions=await import('/scripts/extensions.js');window.regexSettings=regexExtensions.extension_settings;window.regexManager=(await import('/scripts/preset-manager.js')).getPresetManager();window.regexOai=(await import('/scripts/openai.js')).oai_settings;return Object.fromEntries(['regex','character_allowed_regex','preset_allowed_regex','disabledExtensions'].map(key=>[key,regexSettings[key]??null]));})()`);
    const created=(await service.inject({method:'POST',url:'/api/characters/import/commit',payload:{filename:'regex.json',card:{spec:'chara_card_v2',spec_version:'2.0',data:{name:'Regex Actor',description:'Fixture',first_mes:'Opening',personality:'',scenario:'',mes_example:'',creator_notes:'',system_prompt:'',post_history_instructions:'',alternate_greetings:[],tags:[],creator:'MyCompanion',character_version:'1',extensions:{unrelated:{keep:true}}}}}})).json();
    assert(created.id);
    const conversation=(await service.inject({method:'POST',url:'/api/conversations',payload:{characterId:created.id}})).json();
    await evaluate(`(async()=>{await regexCore.getCharacters();window.regexCharacter=regexCore.characters.find(item=>item.id===${JSON.stringify(created.id)});window.regexIndex=regexCore.characters.indexOf(regexCharacter);await regexCore.selectCharacterById(regexIndex);})()`);
    await evaluate(`[...document.querySelectorAll('nav button')].find(button=>button.querySelector('span')?.textContent==='故事').click()`);
    await wait(`!!document.querySelector('[data-conversation-id="${conversation.id}"]')`);
    await evaluate(`document.querySelector('[data-conversation-id="${conversation.id}"]').click()`);
    await wait(`regexCore.getCurrentChatId()===${JSON.stringify(conversation.id)}`);
    assert.equal(await evaluate(`import('/plugin-runtime/scripts/extensions/regex/engine.js').then(module=>module.RegexProvider===regexEngine.RegexProvider)`),true);
    stages.push('canonical-regex-module-on-real-selected-character-and-conversation');

    const priority=await evaluate(`(async()=>{window.regexRule=(from,to,extra={})=>({id:crypto.randomUUID(),scriptName:from,findRegex:from,replaceString:to,placement:[1],disabled:false,trimStrings:[],...extra});regexSettings.disabledExtensions=[];regexSettings.character_allowed_regex=[];await regexEngine.saveScriptsByType([regexRule('x','G')],regexEngine.SCRIPT_TYPES.GLOBAL);await regexManager.savePreset('RegexFixture',{...regexManager.getPresetSettings(),extensions:{regex_scripts:[regexRule('G','P')]}});await regexEngine.saveScriptsByType([regexRule('P','C')],regexEngine.SCRIPT_TYPES.SCOPED);const denied=regexEngine.getRegexedString('x',1);regexEngine.allowPresetScripts('openai','RegexFixture');regexEngine.allowScopedScripts(regexCharacter);await regexCore.saveSettings();return {denied,allowed:regexEngine.getRegexedString('x',1),order:regexEngine.getRegexScripts({allowedOnly:true}).map(rule=>rule.replaceString),unrelated:regexCharacter.data.extensions.unrelated.keep};})()`);
    assert.deepEqual(priority,{denied:'G',allowed:'C',order:['G','P','C'],unrelated:true});
    stages.push('global-preset-character-order-and-persisted-scope-allowlists');

    const options=await evaluate(`(()=>{regexSettings.regex=[regexRule('a','b',{promptOnly:true,minDepth:1,maxDepth:2}),regexRule('b','c',{promptOnly:true,runOnEdit:true})];const values=[regexEngine.getRegexedString('a',1),regexEngine.getRegexedString('a',1,{isPrompt:true,depth:1}),regexEngine.getRegexedString('a',1,{isPrompt:true,depth:0}),regexEngine.getRegexedString('a',1,{isPrompt:true,depth:1,isEdit:true})];regexSettings.disabledExtensions=['regex'];values.push(regexEngine.getRegexedString('a',1,{isPrompt:true,depth:1}));regexSettings.disabledExtensions=[];return values;})()`);
    assert.deepEqual(options,['a','c','a','a','a']);
    stages.push('synchronous-filtering-for-prompt-display-depth-edit-and-extension-disable');

    const fields=await evaluate(`(async()=>{await Promise.all([regexExtensions.writeExtensionField(regexIndex,'unrelated.a',1),regexExtensions.writeExtensionField(regexIndex,'unrelated.b',2)]);const before=JSON.stringify(regexCharacter.data.extensions);window.regexFetch=window.fetch;window.fetch=(...args)=>String(args[0]).includes('/extension-field')?Promise.resolve(Response.json({error:'field save failed'},{status:503})):regexFetch(...args);let failed=false;try{await regexExtensions.writeExtensionField(regexIndex,'unrelated.a',99);}catch{failed=true;}finally{window.fetch=regexFetch;}return {data:regexCharacter.data.extensions.unrelated,failed,unchanged:before===JSON.stringify(regexCharacter.data.extensions)};})()`);
    assert.deepEqual(fields,{data:{keep:true,a:1,b:2},failed:true,unchanged:true});
    await evaluate(`(()=>{window.regexFieldGate=new Promise(resolve=>{window.regexFieldRelease=resolve;});window.regexFieldHeld=false;window.fetch=async(...args)=>{if(String(args[0]).includes('/extension-field')){regexFieldHeld=true;await regexFieldGate;}return regexFetch(...args);};window.regexFieldWrite=regexExtensions.writeExtensionField(regexIndex,'unrelated.a',7);})()`);
    await wait(`regexFieldHeld`);await evaluate(`regexCharacter.data.extensions.unrelated.a=9;regexFieldRelease()`);await evaluate(`regexFieldWrite`);await evaluate(`void(window.fetch=regexFetch)`);
    assert.equal(await evaluate(`regexCharacter.data.extensions.unrelated.a`),9);
    assert.equal(await evaluate(`JSON.parse(regexCharacter.json_data).data.extensions.unrelated.a`),9);
    stages.push('real-character-field-writes-preserve-unrelated-fields-and-failure-does-not-mutate-live-state');

    await service.inject({method:'PUT',url:'/api/settings/provider',payload:{kind:'ollama',baseUrl:`http://127.0.0.1:${model.address().port}/v1`,model:'regex-fixture',maxTokens:400}});
    await evaluate(`(async()=>{await (await import('/plugin-runtime/openai-settings.js')).refreshOpenAISettings();await regexEngine.saveScriptsByType([],regexEngine.SCRIPT_TYPES.PRESET);await regexEngine.saveScriptsByType([],regexEngine.SCRIPT_TYPES.SCOPED);await regexEngine.saveScriptsByType([regexRule('raw','saved'),regexRule('saved','request',{promptOnly:true}),regexRule('model','stored',{placement:[2]}),regexRule('stored','**shown**',{placement:[2],markdownOnly:true}),regexRule('stored','history-copy',{placement:[2],promptOnly:true}),regexRule('edited','edit-result',{placement:[2],runOnEdit:true}),regexRule('edit-result','bad-edit',{placement:[2],runOnEdit:false})],regexEngine.SCRIPT_TYPES.GLOBAL);const response=await fetch('/api/conversations/'+regexCore.getCurrentChatId()+'/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:'raw'})});if(!response.ok)throw new Error(await response.text());await response.text();await regexCore.reloadCurrentChat();})()`);
    assert.equal(requests[0].messages.at(-1).content,'request');
    const persisted=(await service.inject({method:'GET',url:`/api/conversations/${conversation.id}`})).json();
    assert.equal(persisted.messages.at(-2).content,'saved');assert.equal(persisted.messages.at(-1).content,'stored');
    await wait(`document.querySelector('#chat > .mes:last-of-type .mes_text strong')?.textContent==='shown'`);
    stages.push('native-generation-transforms-saved-input-output-and-prompt-copy-while-real-display-stays-separate');
    const unrelatedSave=await evaluate(`(async()=>{const content=document.querySelector('#chat > .mes:last-of-type .mes_text');const marker=document.createElement('button');marker.id='regex-preserved-child';content.append(marker);regexSettings.fixtureUnrelatedRegexCounter=1;await regexCore.saveSettings();const retained=document.getElementById('regex-preserved-child')===marker;delete regexSettings.fixtureUnrelatedRegexCounter;marker.remove();return retained;})()`);
    assert.equal(unrelatedSave,true);
    const rawResult=await evaluate(`(async()=>{const count=regexCore.chat.length;const text=await regexCore.generateRaw({prompt:'Raw regex input'});return {text,unchanged:regexCore.chat.length===count};})()`);
    assert.deepEqual(rawResult,{text:'stored',unchanged:true});
    stages.push('extension-raw-generation-applies-output-rules-without-writing-chat');

    const preview=(await service.inject({method:'POST',url:`/api/conversations/${conversation.id}/prompt-preview`,payload:{draft:'raw'}})).json();
    assert.match(JSON.stringify(preview),/history-copy/);
    const edited=(await service.inject({method:'PATCH',url:`/api/conversations/${conversation.id}/messages/${persisted.messages.at(-1).id}`,payload:{content:'edited'}})).json();
    assert.equal(edited.content,'edit-result');
    assert.equal(await evaluate(`regexEngine.getRegexedString('stored',6,{isMarkdown:true})`),'stored');
    stages.push('assistant-history-prompt-rules-and-edit-gating-without-cross-placement-rewrites');

    await evaluate(`(async()=>{await regexEngine.saveScriptsByType([regexRule('Opening','Regex greeting',{placement:[2]})],regexEngine.SCRIPT_TYPES.SCOPED);await regexCore.saveSettings();})()`);
    const greeting=(await service.inject({method:'GET',url:`/api/conversations/${conversation.id}/greeting`})).json();
    assert.equal(greeting.message?.mes??greeting.mes,'Regex greeting');
    const newStory=(await service.inject({method:'POST',url:'/api/conversations',payload:{characterId:created.id}})).json();
    assert.equal(newStory.messages[0].content,'Regex greeting');
    await new Promise(resolve=>{window.webContents.once('did-finish-load',resolve);window.webContents.reload();});
    const reloaded=await evaluate(`(async()=>{await (await import('/plugin-runtime/desktop-host.js')).start();window.regexCore=await import('/script.js');window.regexEngine=await import('/scripts/extensions/regex/engine.js');window.regexExtensions=await import('/scripts/extensions.js');window.regexSettings=regexExtensions.extension_settings;window.regexManager=(await import('/scripts/preset-manager.js')).getPresetManager();return {global:regexEngine.getScriptsByType(0).length,preset:regexManager.getSelectedPresetName(),allowed:regexSettings.character_allowed_regex.includes(${JSON.stringify(created.avatar??created.id+'.png')})};})()`);
    assert.deepEqual(reloaded,{global:7,preset:'RegexFixture',allowed:true});
    stages.push('scoped-greeting-and-document-reload-retain-rules-preset-selection-and-allowlists');
    await evaluate(`(async()=>{await regexManager.deletePreset('RegexFixture');for(const [key,value] of Object.entries(${JSON.stringify(original)})){if(value===null)delete regexSettings[key];else regexSettings[key]=value;}await regexCore.saveSettings();})()`);
    return {passed:true,stages};
  }finally{await evaluate(`if(window.regexFetch)void(window.fetch=regexFetch);`).catch(()=>{});model.closeAllConnections();await new Promise(resolve=>model.close(resolve));}
}
