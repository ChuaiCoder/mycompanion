import assert from 'node:assert/strict';
import { createServer } from 'node:http';

export async function verifyPluginRawGeneration(window, service) {
  const requests = [], stages = [];
  let closed = 0;
  const model = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const input = body.messages.map(message => message.content).join('\n');
    if (body.stream) {
      if (input.includes('HOLD_QUIET')) {
        response.on('close', () => { closed++; });
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'); return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '<think>hidden</think>Quiet fixture. trailing' } }] }) + '\n\ndata: [DONE]\n\n');
      return;
    }
    if (input.includes('HOLD_RAW') || input.includes('HOLD_QUIET')) {
      response.on('close', () => { closed++; });
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{"choices":'); return;
    }
    if (input.includes('FAIL_RAW')) { response.writeHead(503, { 'Content-Type': 'application/json' }); response.end('{"error":{"message":"Raw fixture failure"}}'); return; }
    response.setHeader('Content-Type', 'application/json');
    const content = input.includes('QUIET_MARKER') ? '<think>hidden</think>Quiet fixture. trailing' : input.includes('EMPTY_RAW') ? '' : input.includes('PADDED_RAW') ? '  not json  ' : input.includes('JSON_RAW') ? ' { "answer": 42 } ' : input.includes('INVALID_RAW') ? 'not json' : 'Raw fixture: Generated text  \nUser: unwanted';
    response.end(JSON.stringify({ choices: [{ message: { content, reasoning_content: 'Preserved reasoning' } }], usage: { total_tokens: 9 } }));
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const evaluate = code => window.webContents.executeJavaScript(code);
  const wait = async predicate => { const end = Date.now() + 10000; while (!await predicate()) { if (Date.now() > end) throw new Error('Raw generation wait timed out'); await new Promise(resolve => setTimeout(resolve, 25)); } };
  try {
    const settings = await service.inject({ method: 'PUT', url: '/api/settings/provider', payload: { kind: 'ollama', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: 'raw-fixture', maxTokens: 4096, temperature: 1.1 } });
    assert.equal(settings.statusCode, 200);
    const baseline = await evaluate(`(async () => {
      window.rawCore = await import('/script.js'); window.rawRuntime = await import('/plugin-runtime/compat-runtime.js');
      const response = await fetch('/api/characters/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ch_name: 'Raw fixture', first_mes: 'Opening' }) });
      const avatar = await response.text(); await rawCore.getCharacters(); await rawCore.selectCharacterById(rawCore.characters.findIndex(character => character.avatar === avatar));
      return { story: rawCore.getCurrentChatId(), chat: JSON.stringify(rawCore.chat), sameFunction: rawRuntime.getContext().generateRaw === rawCore.generateRaw };
    })()`);
    assert(baseline.sameFunction);
    const storyBefore = (await service.inject({ method: 'GET', url: '/api/conversations/' + baseline.story })).json();
    const value = await evaluate(`(async () => {
      const hook = event => { event.chat = [...event.chat, { role: 'system', content: 'EVENT_MODIFIED' }]; };
      rawCore.eventSource.on(rawCore.event_types.CHAT_COMPLETION_PROMPT_READY, hook);
      try { return await rawCore.generateRaw({ prompt: 'Hello {{char}}', systemPrompt: 'System {{user}}', prefill: 'Prefix', responseLength: 6000 }); }
      finally { rawCore.eventSource.removeListener(rawCore.event_types.CHAT_COMPLETION_PROMPT_READY, hook); }
    })()`);
    assert.equal(value, 'Generated text');
    assert.deepEqual(requests[0].messages, [{ role: 'system', content: 'System User' }, { role: 'user', content: 'Hello Raw fixture' }, { role: 'assistant', content: 'Prefix' }, { role: 'system', content: 'EVENT_MODIFIED' }]);
    assert.equal(requests[0].max_tokens, 6000); assert.equal(requests[0].temperature, 1.1); assert.equal(requests[0].stream, false);
    stages.push('real-raw-request-macros-system-prefill-mutable-event-and-request-token-limit');

    const legacy = await evaluate(`rawCore.generateRaw('Legacy raw', null, false, false, '', 2300, false)`);
    assert.equal(legacy, 'Raw fixture: Generated text\nUser: unwanted'); assert.equal(requests.at(-1).max_tokens, 2300);
    const data = await evaluate(`rawCore.generateRawData({ prompt: [{role: 'user', content: 'Data input'}] })`);
    assert.equal(data.choices[0].message.reasoning_content, 'Preserved reasoning'); assert.equal(data.usage.total_tokens, 9);
    assert.equal(requests.at(-1).max_tokens, 4096);
    stages.push('legacy-call-raw-data-and-default-limit-retain-independent-semantics');

    const structured = await evaluate(`(async () => {
      const jsonSchema = { name: 'result', value: { type: 'object', properties: { answer: {type: 'number'} } }, strict: true };
      return [await rawCore.generateRaw({ prompt: 'JSON_RAW', jsonSchema }), await rawCore.generateRawData({ prompt: 'INVALID_RAW', jsonSchema }), await rawCore.generateRaw({ prompt: 'INVALID_RAW', jsonSchema: {...jsonSchema, returnInvalid: true} })];
    })()`);
    assert.deepEqual(structured, ['{"answer":42}', '{}', 'not json']);
    assert.equal(requests.at(-1).response_format.json_schema.strict, true);
    stages.push('structured-json-output-and-invalid-json-policy-reach-provider');

    const before = requests.length;
    const rejected = await evaluate(`(async () => {
      const results = [];
      for (const hook of [() => { throw new Error('Preflight failure'); }, () => rawCore.eventSource.emit(rawCore.event_types.GENERATION_STOPPED)]) {
        rawCore.eventSource.on(rawCore.event_types.CHAT_COMPLETION_PROMPT_READY, hook);
        try { await rawCore.generateRaw({prompt: 'DO_NOT_SEND'}); results.push('unexpected'); } catch (error) { results.push(error.message); }
        finally { rawCore.eventSource.removeListener(rawCore.event_types.CHAT_COMPLETION_PROMPT_READY, hook); }
      }
      try { await rawCore.generateRaw({prompt: 'DO_NOT_SEND', api:'novel'}); results.push('unexpected'); } catch(error) { results.push(error.message); }
      return results;
    })()`);
    assert.match(rejected[0], /Preflight failure/); assert.match(rejected[1], /Cancelled/); assert.match(rejected[2], /novel/); assert.equal(requests.length, before);
    stages.push('event-exceptions-event-stop-and-unsupported-backend-reject-before-provider');

    await evaluate(`(() => { window.rawPending = Promise.all([1,2].map(index => rawCore.generateRaw({prompt:'HOLD_RAW ' + index}).then(() => 'unexpected', error => error.message))); })()`);
    await wait(() => requests.length === before + 2);
    await evaluate(`rawCore.stopGeneration()`);
    const stopped = await evaluate(`rawPending`);
    assert(stopped.every(message => /Cancelled/.test(message)), JSON.stringify(stopped)); await wait(() => closed === 2);
    stages.push('stop-event-cancels-concurrent-provider-response-bodies-and-closes-connections');

    const errors = await evaluate(`(async () => { const results=[]; for (const prompt of ['FAIL_RAW', 'EMPTY_RAW']) { try { await rawCore.generateRaw({prompt}); results.push('unexpected'); } catch(error) { results.push(error.message); } } return results; })()`);
    assert.match(errors[0], /Raw fixture failure/); assert.match(errors[1], /No message generated/);
    assert.equal(await evaluate(`rawCore.generateRaw({prompt:'Recovery'})`), 'Generated text');
    stages.push('provider-errors-empty-output-and-post-cancellation-recovery');

    assert.equal(await evaluate(`JSON.stringify(rawCore.chat)`), baseline.chat);
    assert.deepEqual((await service.inject({ method:'GET', url:'/api/conversations/' + baseline.story })).json(), storyBefore);
    assert.equal((await service.inject({ method:'GET', url:'/api/settings/provider' })).json().maxTokens, 4096);
    stages.push('background-generation-never-mutates-chat-or-persistent-provider-limits');

    const quiet = await evaluate(`rawCore.generateQuietPrompt({quietPrompt:'QUIET_MARKER {{char}}', responseLength:200, trimToSentence:true})`);
    assert.equal(quiet, 'Quiet fixture.');
    const quietRequest = requests.at(-1);
    assert.equal(quietRequest.max_tokens, 200); assert.equal(quietRequest.stream, false);
    assert.equal(quietRequest.messages.at(-1).content, 'QUIET_MARKER Raw fixture');
    assert.equal(quietRequest.messages.at(-1).role, 'system');
    assert.match(JSON.stringify(quietRequest.messages), /Raw fixture/);
    assert.equal(await evaluate(`JSON.stringify(rawCore.chat)`), baseline.chat);
    assert.deepEqual((await service.inject({ method:'GET', url:'/api/conversations/' + baseline.story })).json(), storyBefore);
    stages.push('original-quiet-signature-uses-real-story-context-and-keeps-chat-unchanged');

    const quietMacros = await evaluate(`(async () => {
      const api = await import('/scripts/macros.js');
      let calls = 0, ended;
      api.MacrosParser.registerMacro('quietProbe', () => { calls++; return 'PROBE'; });
      const recordEnd = value => { ended = value; };
      rawCore.eventSource.on(rawCore.event_types.GENERATION_ENDED, recordEnd);
      rawCore.setExtensionPrompt('quiet-budget', 'QUIET_EXT {{maxPrompt}}/{{maxContext}}/{{maxResponse}}/{{quietProbe}}', 2, 0, false, 0);
      rawCore.setExtensionPrompt('2_floating_prompt', 'EXCLUDED_NOTE {{quietProbe}}', 1, 0, false, 0);
      const events = [];
      const promptHook = event => { events.push('prompt'); event.chat.push({role:'system',content:'QUIET_EVENT_LITERAL {{random::x::y}}'}); };
      const settingsHook = request => { events.push('settings'); request.temperature = 0.31; };
      rawCore.eventSource.on(rawCore.event_types.CHAT_COMPLETION_PROMPT_READY, promptHook);
      rawCore.eventSource.on(rawCore.event_types.CHAT_COMPLETION_SETTINGS_READY, settingsHook);
      try {
        const text = await rawCore.generateQuietPrompt({quietPrompt:'QUIET_MARKER {{maxPrompt}}/{{maxContext}}/{{maxResponse}}/{{quietProbe}}',responseLength:207,skipWIAN:true,quietToLoud:true,quietName:'Accepted name',trimToSentence:true});
        return {text,calls,ended,events,length:rawCore.chat.length};
      } finally {
        delete rawCore.extension_prompts['quiet-budget']; delete rawCore.extension_prompts['2_floating_prompt'];
        api.MacrosParser.unregisterMacro('quietProbe');
        rawCore.eventSource.removeListener(rawCore.event_types.GENERATION_ENDED, recordEnd);
        rawCore.eventSource.removeListener(rawCore.event_types.CHAT_COMPLETION_PROMPT_READY, promptHook);
        rawCore.eventSource.removeListener(rawCore.event_types.CHAT_COMPLETION_SETTINGS_READY, settingsHook);
      }
    })()`);
    assert.equal(quietMacros.text, 'Quiet fixture.'); assert.equal(quietMacros.calls, 2);
    assert.equal(quietMacros.ended, quietMacros.length); assert.deepEqual(quietMacros.events, ['prompt','settings']);
    const macroRequest = requests.at(-1);
    const savedSettings = (await service.inject({method:'GET',url:'/api/settings/provider'})).json();
    const budgetMacros = `${savedSettings.contextLimitTokens - 207}/${savedSettings.contextLimitTokens}/207/PROBE`;
    assert(macroRequest.messages.some(message => message.role === 'system' && message.content === 'QUIET_MARKER ' + budgetMacros));
    assert(macroRequest.messages.some(message => message.content === 'QUIET_EXT ' + budgetMacros));
    assert(macroRequest.messages.some(message => message.content === 'QUIET_EVENT_LITERAL {{random::x::y}}'));
    assert(!JSON.stringify(macroRequest.messages).includes('EXCLUDED_NOTE'));
    assert.equal(macroRequest.temperature, 0.31);
    assert.equal(savedSettings.maxTokens, 4096);
    stages.push('quiet-request-macros-expand-once-with-temporary-budget-excluded-note-schema-and-mutable-events');

    const quietJson = await evaluate(`(async()=>{
      const jsonSchema={name:'quiet_result',value:{type:'object'}};
      return [await rawCore.generateQuietPrompt({quietPrompt:'JSON_RAW',jsonSchema}),
        await rawCore.generateQuietPrompt({quietPrompt:'INVALID_RAW',jsonSchema}),
        await rawCore.generateQuietPrompt({quietPrompt:'INVALID_RAW',jsonSchema:{...jsonSchema,returnInvalid:true}}),
        await rawCore.generateQuietPrompt({quietPrompt:'EMPTY_RAW',jsonSchema}),
        await rawCore.generateQuietPrompt({quietPrompt:'PADDED_RAW',jsonSchema:{...jsonSchema,returnInvalid:true}})];
    })()`);
    assert.deepEqual(quietJson,['{"answer":42}','{}','not json','{}','  not json  ']);
    assert.equal(requests.at(-1).response_format.json_schema.name,'quiet_result');
    stages.push('quiet-structured-output-matches-raw-json-normalization-and-return-invalid-policy');

    const previewCount = requests.length;
    const preview = await evaluate(`(async () => {
      const events=[];
      const prompt=event=>events.push('prompt:'+event.dryRun), settings=()=>events.push('settings');
      rawCore.eventSource.on(rawCore.event_types.CHAT_COMPLETION_PROMPT_READY,prompt);
      rawCore.eventSource.on(rawCore.event_types.CHAT_COMPLETION_SETTINGS_READY,settings);
      try { return {value:await rawCore.Generate('quiet',{quiet_prompt:'QUIET_MARKER preview'},true),events}; }
      finally {rawCore.eventSource.removeListener(rawCore.event_types.CHAT_COMPLETION_PROMPT_READY,prompt);rawCore.eventSource.removeListener(rawCore.event_types.CHAT_COMPLETION_SETTINGS_READY,settings);}
    })()`);
    assert.equal(preview.value, undefined); assert.deepEqual(preview.events,['prompt:true']);
    assert.equal(requests.length,previewCount);
    assert.deepEqual((await service.inject({method:'GET',url:'/api/conversations/'+baseline.story})).json(),storyBefore);
    stages.push('quiet-preview-emits-prompt-only-and-keeps-model-chat-and-draft-untouched');

    await evaluate(`(() => {
      window.quietHookEntered=false; window.quietHookDone=false;
      rawCore.eventSource.once(rawCore.event_types.CHAT_COMPLETION_SETTINGS_READY,()=>{quietHookEntered=true;return new Promise(()=>{});});
      rawCore.eventSource.once(rawCore.event_types.GENERATION_ENDED,()=>new Promise(()=>{}));
      window.quietHookRun=rawCore.generateQuietPrompt({quietPrompt:'QUIET_MARKER cancel'}).then(()=>{quietHookDone='unexpected';},error=>{quietHookDone=error.name;});
    })()`);
    await wait(()=>evaluate('quietHookEntered')); await evaluate('rawCore.stopGeneration()');
    await wait(()=>evaluate(`quietHookDone==='AbortError'`));
    assert.equal(requests.length,previewCount);
    assert.equal(await evaluate(`rawCore.generateQuietPrompt({quietPrompt:'QUIET_MARKER recovery',trimToSentence:true})`),'Quiet fixture.');
    stages.push('quiet-stop-releases-hanging-preflight-and-end-listeners-then-recovers');

    const unsupportedBefore = requests.length;
    const unsupportedQuiet = await evaluate(`rawCore.generateQuietPrompt({quietPrompt:'unsupported', quietImage:'data:image/png;base64,AA=='}).then(()=>'unexpected', error=>error.message)`);
    assert.match(unsupportedQuiet, /尚不支持图片/); assert.equal(requests.length, unsupportedBefore);
    stages.push('unsupported-quiet-options-fail-before-provider-request');
    const closedBeforeQuiet = closed;
    await evaluate(`(() => { window.quietPending = rawCore.generateQuietPrompt({quietPrompt:'HOLD_QUIET'}).then(()=>'unexpected', error=>error.name + ': ' + error.message); })()`);
    await wait(() => requests.length === unsupportedBefore + 1);
    await evaluate(`rawCore.stopGeneration()`);
    const quietStopped = await evaluate(`quietPending`);
    assert.match(quietStopped, /Abort|cancel|取消/i);
    await wait(() => closed > closedBeforeQuiet);
    stages.push('stop-event-aborts-quiet-fetch-and-closes-provider-stream');
    return { stages, passed: true };
  } finally {
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
    await evaluate(`delete window.rawCore; delete window.rawRuntime; delete window.rawPending; delete window.quietPending; delete window.quietHookRun; delete window.quietHookEntered; delete window.quietHookDone;`).catch(() => {});
  }
}
