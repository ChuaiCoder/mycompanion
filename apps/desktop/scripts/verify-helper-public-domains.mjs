// Project-owned inputs sent to the byte-unchanged, user-installed Helper.
// This runner exercises real Electron DOM/media, HTTP and SQLite contracts.
import assert from 'node:assert/strict';

function silenceBytes(seconds) {
  const samples = Math.round(seconds * 8000), bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF',0); bytes.writeUInt32LE(bytes.length-8,4); bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16); bytes.writeUInt16LE(1,20); bytes.writeUInt16LE(1,22);
  bytes.writeUInt32LE(8000,24); bytes.writeUInt32LE(16000,28); bytes.writeUInt16LE(2,32);
  bytes.writeUInt16LE(16,34); bytes.write('data',36); bytes.writeUInt32LE(samples*2,40);
  return bytes;
}
export const helperPublicAudioFixtures = new Map([2,2.25,2.5].map(seconds=>['e02-audio-'+seconds+'.wav',silenceBytes(seconds)]));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9rS3lGQAAAABJRU5ErkJggg==';

export async function verifyHelperPublicDomains({getWindow,getService,waitFor,conversationId,providerRequests,providerBase,restart,reproduceChatDelete=false}) {
  const report = {passed:false,stages:[],sourceElectronOnly:true,completeE02:false,
    boundaries:['No final EXE verification','Controlled silence decoding/time progression is not acoustic quality','Original deprecated audio and event-handle semantics are preserved','Arbitrary delayed third-party writes are not covered by host save queues']};
  const stage = (name,evidence) => {report.stages.push({name,...(evidence?{evidence}:{})}); console.log('Passed: '+name);};
  let evaluation = 0;
  const evaluate = async (source,gesture=false) => {
    evaluation++;
    const value = await getWindow().webContents.executeJavaScript(`(async()=>{try{
      window.__e02PublicEvaluation=${evaluation};
      if(!window.__e02UnhandledCapture){window.__e02UnhandledCapture=true;window.addEventListener('unhandledrejection',event=>console.error('E02_UNHANDLED '+JSON.stringify({evaluation:window.__e02PublicEvaluation,message:event.reason?.message||String(event.reason),stack:event.reason?.stack,chatId:window.__e02Core?.getCurrentChatId(),chat:window.__e02Core?.chat.map((message,index)=>({index,text:message.mes,swipe:message.swipe_id})),dom:[...document.querySelectorAll('#chat > .mes')].map(message=>({id:message.getAttribute('mesid'),text:message.querySelector('.mes_text')?.textContent}))})));}
      const helper=window.TavernHelper,core=await import('/script.js'),host=await import('/plugin-runtime/desktop-host.js');
      window.__e02Core=core;
      const check=(condition,label)=>{if(!condition)throw new Error(label);};
      const wait=async(predicate,label)=>{const until=Date.now()+10000;while(!await predicate()){if(Date.now()>until)throw new Error('Timed out: '+label);await new Promise(resolve=>setTimeout(resolve,20));}};
      ${source}
    }catch(error){return {__publicDomainError:error.stack||String(error)};}})()`,gesture);
    if(value?.__publicDomainError)throw new Error(value.__publicDomainError);
    return value;
  };
  try {
    await evaluate(`await host.start();check(core.getCurrentChatId()===${JSON.stringify(conversationId)},'Original story selected');`);
    if(reproduceChatDelete){
      report.chatDelete=await evaluate(`
        const before=core.chat.length;await helper.createChatMessages([{role:'user',message:'E02 DELETE USER'},{role:'assistant',message:'E02 DELETE ASSISTANT'}],{refresh:'all'});
        await helper.deleteChatMessages([before+1],{refresh:'all'});await host.flush();
        const capture=()=>({length:core.chat.length,chat:core.chat.map((message,index)=>({index,text:message.mes})),dom:[...document.querySelectorAll('#chat > .mes')].map(message=>({id:Number(message.getAttribute('mesid')),text:message.querySelector('.mes_text')?.textContent}))});
        const afterDelete=capture();
        await helper.replaceTavernRegexes([],{type:'global'});await new Promise(resolve=>setTimeout(resolve,1250));await host.flush();
        return {afterDelete,afterOriginalRegexRefresh:capture(),staleRowsObserved:afterDelete.dom.some(row=>row.id>=afterDelete.length)};
      `);
      stage('original-create-delete-and-delayed-regex-refresh-observed',report.chatDelete);
      report.passed=!report.chatDelete.staleRowsObserved;
      return report;
    }
    const persona = await evaluate(`
      const blob=new Blob([Uint8Array.from(atob(${JSON.stringify(png)}),char=>char.charCodeAt(0))],{type:'image/png'});
      check(await helper.createPersona('E02 Reader',{avatar_id:'E02-Reader.png',avatar:blob,description:'Initial',title:'Public avatar'},{render:'none'}),'Original createPersona');
      check(!(await helper.createPersona('E02 Reader',{avatar_id:'Duplicate.png'},{render:'none'})),'Duplicate persona return');
      await helper.replacePersona('E02-Reader.png',{description:'Replaced',avatar:blob},{render:'none'});
      await helper.updatePersonaWith('E02-Reader.png',old=>({...old,title:'Updated'}),{render:'none'});
      check(!(await helper.createOrReplacePersona('E02 Reader',{description:'Final description'},{render:'none'})),'Existing persona replace return');
      const p=helper.getPersona('E02 Reader');check(p.description==='Final description'&&p.title==='Updated','Persona actual merged fields');
      check(helper.getPersonaIds().includes('E02-Reader.png')&&helper.getPersonaNames().includes('E02 Reader'),'Persona actual lists');
      const avatars=await fetch('/api/avatars/get',{method:'POST'}).then(response=>response.json());
      check(avatars.includes('E02-Reader.png'),'Actual multipart avatar persisted');
      const bytes=await fetch(helper.getPersonaAvatarPath('E02-Reader.png')).then(response=>response.arrayBuffer());
      check(btoa(String.fromCharCode(...new Uint8Array(bytes)))===${JSON.stringify(png)},'Actual avatar bytes served');
      await host.flush();return {persona:p,path:helper.getPersonaAvatarPath('E02-Reader.png'),byteLength:bytes.byteLength};
    `);
    stage('original-persona-create-replace-update-lists-and-multipart-avatar-bytes-through-real-HTTP',persona);

    const events = await evaluate(`
      check(core.event_types.GENERATION_AFTER_COMMANDS===helper.tavern_events.GENERATION_AFTER_COMMANDS,'Original uppercase after-commands value');
      check(core.event_types.CHARACTER_DELETED===helper.tavern_events.CHARACTER_DELETED,'Original characterDeleted value');
      check(core.event_types.GENERATE_AFTER_DATA===helper.tavern_events.GENERATE_AFTER_DATA,'Original generate_after_data value');
      const frame=document.createElement('iframe');frame.id='E02-events-real';frame.name=frame.id;document.getElementById('plugin-root').append(frame);
      const bind=helper._bind,scope=frame.contentWindow,order=[];
      const middle=async()=>{order.push('middle-start');await new Promise(resolve=>setTimeout(resolve,10));order.push('middle-end');};
      const first=()=>order.push('first'),last=()=>order.push('last'),once=()=>order.push('once');
      bind._eventOn.call(scope,'e02-order',middle);bind._eventMakeFirst.call(scope,'e02-order',first);bind._eventMakeLast.call(scope,'e02-order',last);bind._eventOnce.call(scope,'e02-order',once);
      await bind._eventEmit.call(scope,'e02-order');await bind._eventEmit.call(scope,'e02-order');
      check(JSON.stringify(order)===JSON.stringify(['first','middle-start','middle-end','last','once','first','middle-start','middle-end','last']),'Original bound event ordered await and once');
      bind._eventClearEvent.call(scope,'e02-order');await bind._eventEmit.call(scope,'e02-order');check(order.length===9,'Actual clear event');
      let stopped=0;const listener=()=>stopped++;const handle=bind._eventOn.call(scope,'e02-stop',listener);handle.stop();await bind._eventEmit.call(scope,'e02-stop');
      // Original helper's stop handle passes the wrapped callback back to a map
      // keyed by the original callback; record that behavior, then clean it up.
      const originalStopHandleLeavesListener=stopped===1;bind._eventRemoveListener.call(scope,'e02-stop',listener);await bind._eventEmit.call(scope,'e02-stop');check(stopped===1,'Explicit original remove listener');
      bind._eventClearAll.call(scope);frame.remove();
      const pending=helper.waitGlobalInitialized('E02Global');helper.initializeGlobal('E02Global',{real:17});await pending;await helper.waitGlobalInitialized('E02Global');
      check(window.E02Global.real===17,'Original global initialization and wait');
      return {order,originalStopHandleLeavesListener,global:window.E02Global};
    `);
    stage('original-event-iframe-bind-order-once-clear-and-global-initialization',events);

    const chat = await evaluate(`
      const before=core.chat.length;await helper.createChatMessages([{role:'user',message:'E02 USER'},{role:'assistant',message:'E02 ASSISTANT',data:{owner:'A'},extra:{kept:23}}],{refresh:'all'});
      await helper.setChatMessages([{message_id:before+1,swipe_id:1,swipes:['E02 FIRST','E02 SECOND'],swipes_data:[{ordinal:0},{ordinal:1}],swipes_info:[{kept:23},{kept:24}]}],{refresh:'all'});
      const swiped=helper.getChatMessages(before+1,{include_swipes:true})[0];check(swiped.swipe_id===1&&swiped.swipes_data[1].ordinal===1,'Original candidate data');
      await helper.setChatMessage({message:'E02 LEGACY',data:{legacy:true}},before+1,{refresh:'display_and_render_current'});
      const formatted=helper.formatAsDisplayedMessage('**E02 DISPLAY**',{message_id:before+1});check(formatted.includes('<strong>E02 DISPLAY</strong>'),'Original displayed Markdown formatting');
      await helper.refreshOneMessage(before+1);check(helper.retrieveDisplayedMessage(before+1).text().includes('E02 LEGACY'),'Original retrieveDisplayedMessage actual DOM');
      const message=helper.getChatMessages(-1)[0];message.message='MUTATED_CLONE';check(helper.getChatMessages(-1)[0].message==='E02 LEGACY','Original chat read clones');
      check(helper.getLastMessageId()===core.chat.length-1&&helper.getMessageId('TH-message--7--0')===7,'Original util message ids');
      check(helper.substitudeMacros('{{char}}')===core.name2,'Original misspelled macro alias');
      await helper.rotateChatMessages(before,before+1,core.chat.length,{refresh:'all'});check(helper.getChatMessages(before)[0].message==='E02 LEGACY','Original rotate persisted array order');
      await helper.deleteChatMessages([before+1],{refresh:'all'});await host.flush();
      return {before,remaining:helper.getChatMessages('0-{{lastMessageId}}'),dom:helper.retrieveDisplayedMessage(before).text()};
    `);
    stage('original-chat-create-read-swipes-legacy-set-display-rotate-delete-and-util-through-real-DOM',chat);
    const storedChat=(await getService().inject({url:'/api/conversations/'+conversationId})).json();
    assert.equal(storedChat.messages.at(-1).content,'E02 LEGACY');assert.equal(storedChat.messages.at(-1).extensionData.variables[1].legacy,true);
    stage('original-chat-mutators-persist-selected-swipe-and-variables-in-SQLite');

    await evaluate(`
      const source={user_input:true,ai_output:true,slash_command:true,world_info:true,reasoning:true};
      await helper.replaceTavernRegexes([{id:'e02-regex',script_name:'E02 display',enabled:true,find_regex:'/E02_REGEX/g',trim_strings:[],replace_string:'E02_REPLACED',source,destination:{display:true,prompt:false},run_on_edit:true,min_depth:null,max_depth:null}],{type:'global'});
      await helper.updateTavernRegexesWith(regexes=>regexes.map(regex=>({...regex,replace_string:'E02_REGEX_UPDATED'})),{type:'global'});
      check(helper.getTavernRegexes({type:'global'}).some(regex=>regex.id==='e02-regex'),'Original regex CRUD');
      for(const source of ['user_input','ai_output','slash_command','world_info','reasoning'])check(helper.formatAsTavernRegexedString('E02_REGEX',source,'display')==='E02_REGEX_UPDATED','Original '+source+' display placement');
      check(helper.formatAsTavernRegexedString('E02_REGEX','ai_output','prompt')==='E02_REGEX','Display rule excluded from prompt');
      await host.flush();
    `);
    stage('original-global-regex-replace-update-read-all-five-placements-and-prompt-display-separation');

    await evaluate(`
      helper.insertOrAssignVariables({publicValue:'E02_VAR'},{type:'chat'});
      window.e02MacroCalls=[];window.e02Macro=helper.registerMacroLike(/\\[\\[E02_NATIVE\\]\\]/g,context=>{window.e02MacroCalls.push(context.role);return 'E02_MACRO_RESULT';});
      window.e02PreflightEvents=[];for(const name of ['CHAT_COMPLETION_PROMPT_READY','GENERATE_AFTER_DATA','CHAT_COMPLETION_SETTINGS_READY'])core.eventSource.on(core.event_types[name],(...args)=>window.e02PreflightEvents.push({name,dryRun:name==='GENERATE_AFTER_DATA'?args[1]:args[0]?.dryRun}));
      await host.flush();
    `);
    for (const kind of ['openai-compatible','anthropic','gemini']) {
      const model=kind==='anthropic'?'claude-helper-fixture':kind==='gemini'?'gemini-helper-fixture':'helper-fixture-model';
      const provider={kind,baseUrl:providerBase,model,temperature:0,maxTokens:256,contextLimitTokens:16384};
      const configured=await getService().inject({method:'PUT',url:'/api/settings/provider',payload:provider});assert.equal(configured.statusCode,200,configured.body);
      const begin=providerRequests.length;
      const result=await evaluate(`
        window.e02PreflightEvents=[];const signal=new AbortController().signal;
        const request=await host.prepareNativeCompletion({messages:[{role:'user',content:'[[E02_NATIVE]] {{get_chat_variable::publicValue}}'}],max_tokens:256},false,signal,'normal',${JSON.stringify(provider)});
        check(request.messages[0].content==='E02_MACRO_RESULT E02_VAR','Original helper macro-like transformed actual native preflight: '+JSON.stringify(request.messages));
        const events=window.e02PreflightEvents.map(item=>item.name);check(JSON.stringify(events)===JSON.stringify(['CHAT_COMPLETION_PROMPT_READY','GENERATE_AFTER_DATA','CHAT_COMPLETION_SETTINGS_READY']),'Actual generation event order');
        const response=await fetch('/api/backends/chat-completions/generate',{method:'POST',headers:core.getRequestHeaders(),body:JSON.stringify({...request,stream:false})});check(response.ok,'Actual native request HTTP '+response.status);await response.text();
        return {events,content:request.messages[0].content,source:request.chat_completion_source};
      `);
      assert.equal(providerRequests.length,begin+1);assert(JSON.stringify(providerRequests.at(-1)).includes('E02_MACRO_RESULT E02_VAR'));
      stage('original-macro-like-and-variable-replacement-before-real-'+kind+'-request',result);
    }
    const openai={kind:'openai-compatible',baseUrl:providerBase,model:'helper-fixture-model',temperature:0,maxTokens:256,contextLimitTokens:16384};
    assert.equal((await getService().inject({method:'PUT',url:'/api/settings/provider',payload:openai})).statusCode,200);
    const helperBegin=providerRequests.length;
    const generated=await evaluate(`
      const before=core.chat.length;
      const injected=helper.injectPrompts([{id:'e02-injected',position:'in_chat',depth:0,role:'system',content:'E02_INJECTION',filter:async()=>true}],{once:true});
      const text=await helper.generate({user_input:'[[E02_NATIVE]] {{get_chat_variable::publicValue}}',should_stream:false});
      check(text==='原版助手回复','Original helper generate text');check(!core.extension_prompts?.['e02-injected'],'Original once injection removed on helper end');
      helper.injectPrompts([{id:'e02-remove',position:'in_chat',depth:0,role:'system',content:'REMOVE'}]);helper.uninjectPrompts(['e02-remove']);injected.uninject();
      check(core.chat.length===before,'Original helper generation does not append chat by itself');
      window.e02PreflightEvents=[];const preview=await host.prepareNativeCompletion({messages:[{role:'user',content:'[[E02_NATIVE]]'}],max_tokens:256},true,new AbortController().signal);
      check(preview.messages[0].content==='[[E02_NATIVE]]','Original helper skips dry-run macro replacement');
      check(window.e02PreflightEvents.map(item=>item.name).join(',')==='CHAT_COMPLETION_PROMPT_READY,GENERATE_AFTER_DATA','Preview has after-data stage and no settings-send stage');
      helper.unregisterMacroLike(/\\[\\[E02_NATIVE\\]\\]/g);
      const markdown=helper.builtin.renderMarkdown('**E02 BUILTIN**');check(markdown.includes('<strong>E02 BUILTIN</strong>'),'Original builtin Markdown');
      check(helper.builtin.parseRegexFromString('/E02/i').test('e02'),'Original builtin regex parse');check(await helper.builtin.getVideoTokenCost('fixture')===1000,'Original fixed video token placeholder');
      return {text,previewEvents:window.e02PreflightEvents,videoTokenPlaceholder:1000};
    `);
    assert.equal(providerRequests.length,helperBegin+1);assert(JSON.stringify(providerRequests.at(-1)).includes('E02_INJECTION'));assert(JSON.stringify(providerRequests.at(-1)).includes('E02_MACRO_RESULT E02_VAR'));
    stage('original-helper-generate-injection-once-cleanup-dry-run-and-builtin-subset',generated);

    for(const kind of ['openai-compatible','anthropic','gemini']){
      const model=kind==='anthropic'?'claude-helper-fixture':kind==='gemini'?'gemini-helper-fixture':'helper-fixture-model';
      const provider={kind,baseUrl:providerBase,model,temperature:0,maxTokens:256,contextLimitTokens:16384};
      const configured=await getService().inject({method:'PUT',url:'/api/settings/provider',payload:provider});assert.equal(configured.statusCode,200,configured.body);
      const begin=providerRequests.length;
      const pictures=await evaluate(`
        const settings=await import('/plugin-runtime/openai-settings.js');await settings.refreshOpenAISettings();settings.oai_settings.stream_openai=false;settings.oai_settings.inline_image_quality='low';settings.oai_settings.media_inlining=true;
        const url='data:image/png;base64,'+${JSON.stringify(png)},bytes=Uint8Array.from(atob(${JSON.stringify(png)}),char=>char.charCodeAt(0));
        const before=core.chat.length,results=[];
        for(const mode of ['string','file','array','only','raw']){
          const image=mode==='file'?new File([bytes],'e02-picture.png',{type:'image/png'}):mode==='array'?[url,url]:url;
          const config={user_input:mode==='only'?'':'E02_PICTURE_'+mode,image,should_stream:false};
          const value=mode==='raw'?await helper.generateRaw({...config,ordered_prompts:[{role:'system',content:'E02 raw picture system'},'user_input']}):await helper.generate(config);
          check(value==='原版助手回复','Original '+mode+' picture generation result '+JSON.stringify(value));results.push({mode,value});
        }
        check(core.chat.length===before,'Original image generation leaves story rows unchanged');return results;
      `);
      const requests=providerRequests.slice(begin);assert.equal(requests.length,5);
      for(const [index,request]of requests.entries()){
        const parts=kind==='gemini'?request.contents.flatMap(message=>message.parts):request.messages.flatMap(message=>Array.isArray(message.content)?message.content:[]);
        const media=parts.filter(part=>kind==='gemini'?part.inlineData?.mimeType==='image/png':kind==='anthropic'?part.type==='image':part.type==='image_url');
        assert.equal(media.length,index===2?2:1,kind+' '+pictures[index].mode+' actual picture count: '+JSON.stringify(request));
        for(const part of media)assert.equal(kind==='gemini'?part.inlineData.data:kind==='anthropic'?part.source.data:part.image_url.url.split(',')[1],png);
      }
      stage('original-helper-generate-string-File-array-image-only-and-generateRaw-pictures-reach-real-'+kind+'-wire',{results:pictures,pictureCounts:[1,1,2,1,1]});
    }
    assert.equal((await getService().inject({method:'PUT',url:'/api/settings/provider',payload:openai})).statusCode,200);

    const waves=[2,2.25,2.5].map(seconds=>providerBase+'/e02-audio-'+seconds+'.wav');
    const audio=await evaluate(`
      const waves=${JSON.stringify(waves)};window.e02Waves=waves;
      helper.setAudioSettings('bgm',{enabled:true,mode:'repeat_one',muted:true,volume:0});helper.setAudioSettings('ambient',{enabled:true,mode:'play_one_and_stop',muted:true,volume:0});
      helper.replaceAudioList('bgm',[{title:'E02 BGM',url:waves[0]}]);helper.appendAudioList('bgm',[{title:'E02 second',url:waves[1]}]);
      helper.replaceAudioList('ambient',[{title:'E02 ambient',url:waves[1]}]);
      const clone=helper.getAudioList('bgm');clone[0].title='BAD_CLONE';check(helper.getAudioList('bgm')[0].title==='E02 BGM','Original audio clone');
      helper.playAudio('bgm',{title:'E02 BGM',url:waves[0]});helper.playAudio('ambient',{title:'E02 ambient',url:waves[1]});
      await wait(()=>[...document.querySelectorAll('audio')].some(audio=>audio.currentSrc===waves[0]&&audio.readyState>=2&&audio.currentTime>0.08&&!audio.paused),'Actual BGM decoded and playing');
      await wait(()=>[...document.querySelectorAll('audio')].some(audio=>audio.currentSrc===waves[1]&&audio.readyState>=2&&audio.currentTime>0.08&&!audio.paused),'Actual ambient decoded and playing');
      const bgm=[...document.querySelectorAll('audio')].find(audio=>audio.currentSrc===waves[0]);const before=bgm.currentTime,decodedDuration=bgm.duration,decodedReadyState=bgm.readyState;
      helper.pauseAudio('bgm');helper.pauseAudio('ambient');await wait(()=>bgm.paused,'Actual pause');await new Promise(resolve=>setTimeout(resolve,180));check(Math.abs(bgm.currentTime-before)<0.15,'Actual paused clock no longer advances');
      const enabledBefore=helper.getAudioSettings('bgm').enabled;helper.audioEnable({type:'bgm',state:'false'});check(helper.getAudioSettings('bgm').enabled===enabledBefore,'Original deprecated audioEnable is no-op');
      helper.audioMode({type:'bgm',mode:'stop'});helper.audioPlay({type:'bgm',play:'false'});const deprecatedFalseStringStartsPlayback=helper.getCurrentAudio('bgm').playing;helper.pauseAudio('bgm');
      helper.audioImport({type:'ambient',play:'false'},waves[2]);helper.pauseAudio('ambient');helper.audioSelect({type:'bgm'},waves[1]);await wait(()=>helper.getCurrentAudio('bgm').src===waves[1],'Original audioSelect');helper.pauseAudio('bgm');
      helper.setAudioSettings('bgm',{mode:'repeat_one',volume:37});await new Promise(resolve=>setTimeout(resolve,150));helper.setAudioSettings('bgm',{muted:true});
      await host.flush();return {duration:decodedDuration,readyState:decodedReadyState,pausedClock:bgm.currentTime,decodedTimeBeforePause:before,bgm:helper.getAudioList('bgm').map(item=>item.title),ambient:helper.getAudioList('ambient').map(item=>item.title),settings:helper.getAudioSettings('bgm'),deprecatedFalseStringStartsPlayback};
    `,true);
    assert.equal(audio.duration,2);assert.equal(audio.deprecatedFalseStringStartsPlayback,true);
    stage('original-all-thirteen-audio-APIs-drive-real-BGM-and-ambient-decoding-clock-and-pause',audio);

    const second=await evaluate(`
      [...document.querySelectorAll('nav button')].find(button=>button.textContent.includes('角色库')).click();
      await wait(()=>document.querySelector('.character-row'),'Actual existing role sidebar');document.querySelector('.character-row').click();
      await wait(()=>[...document.querySelectorAll('button')].some(button=>button.textContent==='开始对话'),'Actual role library');
      [...document.querySelectorAll('button')].find(button=>button.textContent==='开始对话').click();
      await wait(()=>core.getCurrentChatId()&&core.getCurrentChatId()!==${JSON.stringify(conversationId)},'Actual other story');
      await wait(()=>helper.getAudioList('bgm').length===0&&helper.getAudioList('ambient').length===0,'Original audio lists scoped to other story');
      check(!helper.getCurrentAudio('bgm').playing&&!helper.getCurrentAudio('ambient').playing,'Navigation stops original audio');
      helper.replaceAudioList('bgm',[{title:'E02 Story B',url:window.e02Waves[2]}]);await host.flush();const id=core.getCurrentChatId();
      [...document.querySelectorAll('nav button')].find(button=>button.textContent.includes('故事')).click();
      await wait(()=>document.querySelector('button[data-conversation-id="${conversationId}"]'),'Actual original story row');document.querySelector('button[data-conversation-id="${conversationId}"]').click();
      await wait(()=>core.getCurrentChatId()===${JSON.stringify(conversationId)}&&helper.getAudioList('bgm')[0]?.title==='E02 BGM','Original playlist restored on actual navigation');
      check(!helper.getCurrentAudio('bgm').playing,'Story return remains paused');await host.flush();return id;
    `);
    stage('original-audio-real-story-navigation-keeps-playlists-separate-and-stops-playback',{secondStory:second});
    const settingsBefore=(await getService().inject({url:'/api/extensions/settings'})).json().extensionSettings;
    assert.equal(settingsBefore.tavern_helper.audio.bgm.volume,37);
    const oldA=(await getService().inject({url:'/api/conversations/'+conversationId})).json(),oldB=(await getService().inject({url:'/api/conversations/'+second})).json();
    assert.equal(oldA.chatMetadata.tavern_helper.bgm[0].title,'E02 BGM');assert.equal(oldB.chatMetadata.tavern_helper.bgm[0].title,'E02 Story B');
    const ports=await restart();
    const restored=await evaluate(`
      await wait(()=>helper.getAudioList('bgm')[0]?.title==='E02 BGM','Original playlist after full new-port restart');
      const p=helper.getPersona('E02-Reader.png');check(p.description==='Final description'&&p.title==='Updated','Original persona restored');
      check(helper.getAudioSettings('bgm').volume===37&&helper.getAudioSettings('bgm').muted,'Original global audio settings restored');
      check(!helper.getCurrentAudio('bgm').playing,'Restart does not autoplay');
      check(helper.getTavernVersion()==='1.19.0','Fixed Tavern version');check(helper.getFrontendVersion()===helper.getTavernHelperVersion(),'Original old version alias');
      check(helper.triggerSlash===helper.triggerSlashWithResult,'Original old slash alias');
      return {persona:p,settings:helper.getAudioSettings('bgm'),bgm:helper.getAudioList('bgm').map(item=>item.title),ambientCount:helper.getAudioList('ambient').length,version:helper.getTavernVersion()};
    `);
    stage('full-window-close-service-restart-new-port-restores-original-persona-audio-and-old-aliases',{ports,...restored});
    await evaluate(`check(await helper.deletePersona('E02-Reader.png'),'Original persona delete');await host.flush();check(!helper.getPersonaIds().includes('E02-Reader.png'),'Original persona removed from settings');const response=await fetch('/User%20Avatars/E02-Reader.png');check(response.status===404,'Original persona avatar deleted from SQLite');`);
    stage('original-persona-delete-clears-real-avatar-and-settings-after-restart');
    report.passed=true;
  } catch(error) {
    report.error=error.stack||String(error);
    try {report.diagnostic=await evaluate(`return {chatId:core.getCurrentChatId(),audioCount:document.querySelectorAll('audio').length,audio:[...document.querySelectorAll('audio')].map(audio=>({src:audio.currentSrc.slice(0,100),readyState:audio.readyState,error:audio.error?.message,time:audio.currentTime,paused:audio.paused})),statuses:host.getStatuses(),body:document.body.innerText.slice(0,1600)};`);}catch(secondary){report.diagnosticError=String(secondary);}
  }
  return report;
}
