import assert from 'node:assert/strict';

// Drive the unmodified Helper's own menu/dialog; do not replace its listener.
export async function verifyHelperPromptViewer(window, waitFor, service, providerRequests, result, expectedReply = '原版助手回复') {
  const evaluate = source => window.webContents.executeJavaScript(source);
  await evaluate(`TavernHelper.generate({user_input:'PromptViewer connection',should_stream:false})`);
  const id = await evaluate(`SillyTavern.getContext().conversationId`);
  const read = async () => (await service.inject({method:'GET',url:'/api/conversations/'+id})).json();
  const before = await read(), count = providerRequests.length;
  await evaluate(`(async()=>{
    window.__viewerUnhandled=[];
    window.addEventListener('unhandledrejection',event=>__viewerUnhandled.push(String(event.reason?.stack||event.reason)));
    window.__viewerCore=await import('/script.js');
    window.__viewerEvents=[];
    for(const name of ['GENERATION_STARTED','GENERATION_AFTER_COMMANDS','CHAT_COMPLETION_PROMPT_READY','CHAT_COMPLETION_SETTINGS_READY','GENERATION_STOPPED','GENERATION_ENDED'])
      __viewerCore.eventSource.on(__viewerCore.event_types[name],()=>__viewerEvents.push(name));
    const item=[...document.querySelectorAll('#extensionsMenu [role="listitem"]')].find(el=>el.textContent.includes('提示词查看器'));
    if(!item)throw new Error('Original Helper PromptViewer menu is missing');item.click();
  })()`);
  const loaded = () => evaluate(`(()=>{const dialog=[...document.querySelectorAll('[role="dialog"]')].find(el=>el.textContent.includes('提示词查看器'));return dialog && !dialog.querySelector('.TH-loading-spinner') && /[1-9]\\d*\\/[1-9]\\d* 条消息/.test(dialog.textContent) && !SillyTavern.getContext().nativeGenerating ? dialog.textContent : null;})()`);
  result.openText = await waitFor(loaded);
  assert.equal(providerRequests.length,count,'Opening PromptViewer contacted provider');
  assert.deepEqual(await read(),before,'Opening PromptViewer changed chat');
  result.openEvents = await evaluate('__viewerEvents.slice()');
  assert.deepEqual(result.openEvents.slice(0,5),['GENERATION_STARTED','GENERATION_AFTER_COMMANDS','CHAT_COMPLETION_PROMPT_READY','CHAT_COMPLETION_SETTINGS_READY','GENERATION_STOPPED']);
  await evaluate(`(()=>{__viewerEvents.length=0;const d=[...document.querySelectorAll('[role="dialog"]')].find(el=>el.textContent.includes('提示词查看器'));d.querySelector('[title="刷新"]').click();})()`);
  await waitFor(()=>evaluate(`__viewerEvents.includes('GENERATION_STOPPED')`));
  result.refreshText = await waitFor(loaded);
  assert.equal(providerRequests.length,count,'Refreshing PromptViewer contacted provider');
  assert.deepEqual(await read(),before,'Refreshing PromptViewer changed chat');
  await evaluate(`(()=>{const d=[...document.querySelectorAll('[role="dialog"]')].find(el=>el.textContent.includes('提示词查看器'));d.querySelector('[title="展开全部"]').click();})()`);
  result.expandedText = await waitFor(()=>evaluate(`(()=>{const d=[...document.querySelectorAll('[role="dialog"]')].find(el=>el.textContent.includes('提示词查看器'));return d?.textContent.includes(${JSON.stringify(before.characterName)}) ? d.textContent : null;})()`));
  const dry = await evaluate(`(async()=>{
    __viewerEvents.length=0;
    const input=document.getElementById('send_textarea');input.value='/echo keep-this-draft';
    const result=await __viewerCore.Generate('normal',{},true);
    return {result,input:input.value,events:__viewerEvents.slice()};
  })()`);
  assert.equal(dry.input,'/echo keep-this-draft');
  assert(dry.events.includes('CHAT_COMPLETION_PROMPT_READY'));assert(!dry.events.includes('CHAT_COMPLETION_SETTINGS_READY'));
  assert.equal(providerRequests.length,count);assert.deepEqual(await read(),before);
  result.dryRun=dry;
  await waitFor(()=>evaluate(`!SillyTavern.getContext().nativeGenerating`));
  const answer = await evaluate(`(async()=>{
    __viewerCore.eventSource.once(__viewerCore.event_types.CHAT_COMPLETION_PROMPT_READY,data=>data.chat.push({role:'system',content:'VIEWER_EVENT_MARKER {{random::x::y}}'}));
    __viewerCore.eventSource.once(__viewerCore.event_types.CHAT_COMPLETION_SETTINGS_READY,data=>{data.temperature=0.25;data.max_tokens=99;});
    document.getElementById('send_textarea').value='Native viewer generation';
    return __viewerCore.Generate('normal');
  })()`);
  assert.equal(answer,expectedReply);
  const sent=providerRequests.findLast(request=>request.messages?.some(message=>message.content==='VIEWER_EVENT_MARKER {{random::x::y}}'));
  assert.equal(sent.temperature,0.25);assert.equal(sent.max_tokens,99);
  assert(sent.messages.some(message=>message.content==='VIEWER_EVENT_MARKER {{random::x::y}}'),'Extension text was expanded twice or lost');
  result.nativeRequest=sent;
  await waitFor(()=>evaluate(`!SillyTavern.getContext().nativeGenerating`));
  const after = await read(), requestsAfter = providerRequests.length;
  const stopped = await evaluate(`(async()=>{
    __viewerCore.eventSource.once(__viewerCore.event_types.CHAT_COMPLETION_SETTINGS_READY,()=>__viewerCore.stopGeneration());
    return {value:await __viewerCore.Generate('regenerate')};
  })()`);
  assert.equal(stopped.value,undefined);assert.deepEqual(await read(),after);
  assert.equal(providerRequests.length,requestsAfter);
  await waitFor(()=>evaluate(`!SillyTavern.getContext().nativeGenerating`));
  await evaluate(`(()=>{
    window.__viewerHungEntered=false;window.__viewerHungDone=false;
    __viewerCore.eventSource.once(__viewerCore.event_types.CHAT_COMPLETION_SETTINGS_READY,()=>{__viewerHungEntered=true;return new Promise(()=>{});});
    window.__viewerHungRun=__viewerCore.Generate('regenerate').then(()=>{__viewerHungDone=true;},error=>{__viewerHungDone=String(error);});
  })()`);
  await waitFor(()=>evaluate('__viewerHungEntered'));
  await evaluate('__viewerCore.stopGeneration()');
  await waitFor(()=>evaluate('__viewerHungDone===true && !SillyTavern.getContext().nativeGenerating'),5000);
  assert.deepEqual(await read(),after);assert.equal(providerRequests.length,requestsAfter);
  // A subsequent dry run proves that the prior listener did not retain the UI lock.
  await evaluate(`__viewerCore.Generate('regenerate',{},true)`);
  assert.deepEqual(await read(),after);assert.equal(providerRequests.length,requestsAfter);
  result.hungListenerStopped=true;

  const quietBefore = await read(), quietCount = providerRequests.length;
  const quietPreview = await evaluate(`(async()=>{
    __viewerEvents.length=0;
    const value=await __viewerCore.Generate('quiet',{quiet_prompt:'HELPER_QUIET_PREVIEW'},true);
    return {value,events:__viewerEvents.slice(),draft:document.getElementById('send_textarea').value};
  })()`);
  assert.equal(quietPreview.value,undefined);
  assert(quietPreview.events.includes('CHAT_COMPLETION_PROMPT_READY'));
  assert(!quietPreview.events.includes('CHAT_COMPLETION_SETTINGS_READY'));
  assert.equal(providerRequests.length,quietCount);assert.deepEqual(await read(),quietBefore);
  result.quietPreview=quietPreview;
  const quietAnswer = await evaluate(`(async()=>{
    __viewerCore.eventSource.once(__viewerCore.event_types.CHAT_COMPLETION_PROMPT_READY,event=>event.chat.push({role:'system',content:'HELPER_QUIET_LITERAL {{random::x::y}}'}));
    __viewerCore.eventSource.once(__viewerCore.event_types.CHAT_COMPLETION_SETTINGS_READY,request=>{request.temperature=0.37;});
    return __viewerCore.generateQuietPrompt({quietPrompt:'HELPER_QUIET {{maxResponse}}',responseLength:137,jsonSchema:{name:'quiet_result',value:{type:'object'},returnInvalid:true}});
  })()`);
  assert.equal(quietAnswer,expectedReply);
  const quietRequest=providerRequests.findLast(request=>request.messages?.some(message=>message.content==='HELPER_QUIET_LITERAL {{random::x::y}}'));
  assert(quietRequest);assert.equal(quietRequest.max_tokens,137);assert.equal(quietRequest.temperature,0.37);assert.equal(quietRequest.stream,false);
  assert.equal(quietRequest.response_format.json_schema.name,'quiet_result');
  assert(quietRequest.messages.some(message=>message.role==='system' && message.content==='HELPER_QUIET 137'));
  assert.deepEqual(await read(),quietBefore);
  result.quietRequest=quietRequest;
  await evaluate(`(()=>{const d=[...document.querySelectorAll('[role="dialog"]')].find(el=>el.textContent.includes('提示词查看器'));d.querySelector('[title="展开全部"]').click();})()`);
  result.quietViewerText=await waitFor(()=>evaluate(`(()=>{const d=[...document.querySelectorAll('[role="dialog"]')].find(el=>el.textContent.includes('提示词查看器'));return d?.textContent.includes('HELPER_QUIET 137') ? d.textContent : null;})()`));
  result.unhandled = await evaluate('__viewerUnhandled');assert.deepEqual(result.unhandled,[]);
  await evaluate(`(()=>{const d=[...document.querySelectorAll('[role="dialog"]')].find(el=>el.textContent.includes('提示词查看器'));d.querySelector('[title="关闭"]').click();})()`);
  result.passed=true;
}
