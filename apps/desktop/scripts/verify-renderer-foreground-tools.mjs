// Actual Electron/React and original ToolManager ESM. Own loopback fixtures,
// private SQLite profile, no copied helper code or distribution artifact.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { app, BrowserWindow } from 'electron';
import { bindBrowserPort, buildApp } from '../../local-service/dist/app.js';
import { installDesktopCloseGuard } from '../dist/desktop-close.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const profile = mkdtempSync(join(tmpdir(), 'mycompanion-foreground-tools-')), databasePath = join(profile, 'profile.sqlite');
const label = process.argv.find(value => value.startsWith('--label='))?.slice(8) ?? new Date().toISOString().replace(/[^a-z0-9]/gi, '-');
assert(/^[a-z0-9-]{1,90}$/i.test(label));
const reportPath = join(root, '.cache/reports/renderer-foreground-tools-' + label + '.json'); mkdirSync(dirname(reportPath), { recursive: true });
app.setPath('userData', profile); app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
const stages = [], windows = [], requests = [];
let service, window, origin, scenario = 'continue', sequence = 0;
// Valid RGBA PNG: both chunk CRCs and the IDAT zlib checksum are correct.
const imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPgEpH7DwABpAE8k4sOtwAAAABJRU5ErkJggg==';
const pcm = Buffer.alloc(24000 / 2 * 2), wave = Buffer.alloc(44 + pcm.length);
wave.write('RIFF', 0); wave.writeUInt32LE(36 + pcm.length, 4); wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(24000, 24); wave.writeUInt32LE(48000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(pcm.length, 40); pcm.copy(wave, 44);
const audioData = wave.toString('base64');
const provider = createServer(async (request, response) => {
  try {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text || '{}');
    requests.push({ scenario, url: request.url, body });
    if (!body.stream) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: scenario === 'media' ? { role: 'assistant', content: [{ type: 'text', text: 'FINAL_media' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + imageData } }], audio: { format: 'wav', data: audioData } } : { role: 'assistant', content: '[]' }, finish_reason: 'stop' }] })); return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const write = data => response.write('data: ' + JSON.stringify(data) + '\n\n');
    const toolMode = ['success', 'failure', 'stop', 'navigation', 'limit', 'stealth'].includes(scenario);
    const followup = body.messages.at(-1)?.role === 'tool';
    if (toolMode && (!followup || scenario === 'limit')) {
      const first = ++sequence;
      const names = scenario === 'stealth' ? ['fixture_stealth'] : ['fixture_tool'];
      if (['stop', 'navigation', 'success'].includes(scenario)) names.push('fixture_tool');
      write({ choices: [{ delta: { content: 'TOOL_PREFACE' } }] });
      // Arguments actually cross two provider chunks before original callbacks.
      write({ choices: [{ delta: { tool_calls: names.map((name, index) => ({ index, id: `${scenario}_${first}_${index}`, type: 'function', function: { name, arguments: '{"value":' } })) } }] });
      write({ choices: [{ delta: { tool_calls: names.map((_name, index) => ({ index, function: { arguments: String(index + 1) + '}' } })) }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 31, completion_tokens: 3, total_tokens: 34 } });
    } else {
      write({ choices: [{ delta: { content: scenario === 'continue' ? ' continued text' : scenario === 'continue-stop' ? ' partial text' : 'FINAL_' + scenario } }] });
      if (scenario === 'continue-stop') return;
      write({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 41, completion_tokens: 7, total_tokens: 48 } });
    }
    response.end('data: [DONE]\n\n');
  } catch (error) { response.end(String(error)); }
});
const record = (name, evidence) => { stages.push({ name, ...(evidence ? { evidence } : {}) }); console.log('Passed: ' + name); };
const deadline = setTimeout(() => { writeFileSync(reportPath, JSON.stringify({ passed: false, checkedAt: new Date().toISOString(), label, profile, stages, error: 'Foreground/tools deadline exceeded' }, null, 2), { flag: 'wx' }); app.exit(1); }, 240_000);
const story = async id => (await service.inject({ method: 'GET', url: '/api/conversations/' + id })).json();
async function start() { service = buildApp({ databasePath, rendererRoot: join(root, 'apps/renderer/dist') }); origin = await bindBrowserPort(port => service.listen({ host: '127.0.0.1', port })); }
async function harness() {
  const wait = async (predicate, label) => { const until = Date.now() + 14_000; while (!await predicate()) { if (Date.now() > until) throw new Error('Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 16)); } };
  const check = (value, label) => { if (!value) throw new Error(label); };
  const button = (label, container = document) => [...container.querySelectorAll('button')].find(item => item.textContent.trim() === label);
  const nav = label => [...document.querySelectorAll('nav button')].find(item => item.textContent.trim().startsWith(label)).click();
  const edit = (element, value) => { check(element, 'Real input'); const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); };
  await wait(() => document.querySelector('.service-state--online') && window.__mycompanionFlushDrafts, 'Actual connected app');
  const core = await import('/script.js'), compat = await import('/plugin-runtime/compat-runtime.js'), host = await import('/plugin-runtime/desktop-host.js'); await host.start();
  const { ToolManager } = await import('/scripts/tool-calling.js');
  window.foregroundTools = { core: { ...core, ...compat }, ToolManager, host, wait, check, button, nav, edit };
}
async function ready() { await window.webContents.executeJavaScript(`(${harness.toString()})()`); }
async function evaluate(body) {
  const result = await window.webContents.executeJavaScript(`(async()=>{try{const {core,ToolManager,host,wait,check,button,nav,edit}=window.foregroundTools;${body}}catch(error){return {__foregroundToolsError:error.stack||String(error)}}})()`);
  if (result?.__foregroundToolsError) throw new Error(result.__foregroundToolsError); return result;
}
async function open() { window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } }); windows.push(window); await window.loadURL(origin); await ready(); }
async function restart() { const previous = origin, guard = installDesktopCloseGuard(window, { beforeClose: async () => {}, onError: error => { throw error; } }); assert.equal(await guard.requestClose(), true); await service.close(); await start(); assert.notEqual(origin, previous); await open(); }
async function send(text) { await evaluate(`window.toolCase=${JSON.stringify(scenario)};const previous=core.getContext().chat.at(-1)?.id;edit(document.getElementById('send_textarea'),${JSON.stringify(text)});document.getElementById('send_but').click();await wait(()=>core.getContext().chat.at(-1)?.id!==previous&&core.getContext().chat.at(-1)?.is_user===false&&!core.getContext().nativeGenerating&&core.getContext().chat.at(-1)?.status!=='streaming'&&document.getElementById('send_textarea').value==='','Real completed foreground');`); }
async function register() { await evaluate(`const settings=await import('/plugin-runtime/settings.js');const {oai_settings}=await import('/scripts/openai.js');oai_settings.function_calling=true;await settings.saveSettings();window.toolActions=[];ToolManager.registerFunctionTool({name:'fixture_tool',description:'Actual callback',parameters:{type:'object',properties:{value:{type:'number'}},required:['value']},shouldRegister:async()=>true,action:async({value})=>{window.toolActions.push({case:window.toolCase,value,story:core.getContext().conversationId});const row=document.createElement('div');row.dataset.actualTool=String(value);row.textContent='ACTUAL_TOOL_DOM '+value;document.getElementById('plugin-root').append(row);if(window.toolCase==='failure')throw new Error('Fixture callback failed');if(['stop','navigation'].includes(window.toolCase)&&value===1)await new Promise(resolve=>{window.releaseTool=resolve;});return {value,marker:'REAL_RESULT'};}});ToolManager.registerFunctionTool({name:'fixture_stealth',parameters:{type:'object'},stealth:true,action:()=>{window.toolActions.push({case:window.toolCase,stealth:true});return 'PRIVATE_STEALTH_RESULT';}});ToolManager.registerFunctionTool({name:'fixture_disabled',parameters:{type:'object'},shouldRegister:async()=>false,action:()=>{throw new Error('Disabled tool ran');}});check(ToolManager===core.getContext().ToolManager,'Actual ESM class and context registry identity');`); }

async function verify() { try {
  await app.whenReady(); await start(); await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const configured = await service.inject({ method: 'PUT', url: '/api/settings/provider', payload: { kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, model: 'foreground-tools-fixture', clearApiKey: true, temperature: 0, maxTokens: 64, contextLimitTokens: 16384 } }); assert.equal(configured.statusCode, 200, configured.body);
  await open();
  const card = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Foreground tools role', description: 'Role', first_mes: 'Opening', personality: '', scenario: '', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: { retained: { custom: true } } } };
  const imported = await evaluate(`const transfer=new DataTransfer();transfer.items.add(new File([atob(${JSON.stringify(Buffer.from(JSON.stringify(card)).toString('base64'))})],'foreground-tools.json',{type:'application/json'}));const input=document.querySelector('input[aria-label="选择角色卡文件"]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));await wait(()=>button('确认导入'),'Card preview');button('确认导入').click();await wait(()=>button('开始对话'),'Imported role');button('开始对话').click();await wait(()=>core.getContext().conversationId&&document.querySelector('#option_continue')&&!document.getElementById('send_textarea').disabled,'Actual foreground');return {storyId:core.getContext().conversationId,roleId:core.getContext().characterUuid,branchId:core.getContext().branchId,id:core.getContext().chat[0].id};`);
  await evaluate(`const message=core.getContext().chat[0];message.swipes=[message.mes,'Other candidate'];message.swipe_id=0;message.swipe_info=[{extra:{kept:1},unknown:{retained:true}},{extra:{kept:2}}];await core.saveChatConditional();edit(document.getElementById('send_textarea'),'RETAINED_DRAFT');document.getElementById('option_continue').click();await wait(()=>core.getContext().chat[0].status==='complete'&&core.getContext().chat[0].mes==='Opening continued text'&&!core.getContext().nativeGenerating,'Actual continuation');check(document.getElementById('send_textarea').value==='RETAINED_DRAFT','Continue preserves pending user draft');`);
  const continued = (await story(imported.storyId)).messages[0]; assert.equal(continued.id, imported.id); assert.equal(continued.content, 'Opening continued text'); assert.equal(continued.extensionData.swipes[0], continued.content); assert.deepEqual(continued.extensionData.swipe_info[0].unknown, { retained: true });
  const firstRequest = requests.find(item => item.body.stream).body; assert(firstRequest.messages.some(message => String(message.content).includes('Continue your last message')));
  const dryBefore = requests.length; await evaluate(`const before=core.getContext().chat[0].mes;const value=await core.Generate('continue',{},true);check(value===undefined&&core.getContext().chat[0].mes===before,'Actual Generate continue preview');check(document.getElementById('send_textarea').value==='RETAINED_DRAFT','Preview retains draft');`); assert.equal(requests.length, dryBefore);
  record('actual-continue-control-and-Generate-preview-preserve-same-message-prefix-swipes-unknowns-and-draft', { request: firstRequest, message: continued });
  scenario = 'impersonate'; const beforeImpersonate = await story(imported.storyId);
  await evaluate(`window.impersonateEvents=[];core.eventSource.on(core.event_types.IMPERSONATE_READY,text=>{check(document.getElementById('send_textarea').value===text,'Ready event sees actual composer');window.impersonateEvents.push(text);});document.getElementById('option_impersonate').click();await wait(()=>window.impersonateEvents.length===1&&!core.getContext().nativeGenerating,'Actual impersonate control');check(document.getElementById('send_textarea').value==='FINAL_impersonate','Actual composer populated');const result=await core.Generate('impersonate');check(result==='FINAL_impersonate'&&window.impersonateEvents.length===2,'Actual Generate returns draft and emits ready');`);
  assert.deepEqual((await story(imported.storyId)).messages, beforeImpersonate.messages);
  record('actual-impersonate-control-and-Generate-fill-composer-and-await-ready-without-saving-chat-rows');
  scenario = 'continue-stop'; await evaluate(`document.getElementById('option_continue').click();await wait(()=>core.getContext().chat[0].mes.endsWith(' partial text')&&core.getContext().nativeGenerating,'Actual partial continuation');document.getElementById('mes_stop').click();await wait(()=>!core.getContext().nativeGenerating&&core.getContext().chat[0].status==='stopped','Actual stop');`);
  assert.equal((await story(imported.storyId)).messages[0].content, 'Opening continued text partial text');
  record('actual-continuation-stop-retains-original-prefix-and-streamed-partial');
  // Prepare two actual stories before holding an extension action.
  await evaluate(`nav('角色库');await wait(()=>button('开始对话'),'Actual library');button('开始对话').click();await wait(()=>core.getContext().conversationId!==${JSON.stringify(imported.storyId)},'Actual second story');window.otherForegroundStory=core.getContext().conversationId;nav('故事');await wait(()=>document.querySelector('button[data-conversation-id="${imported.storyId}"]'),'Original actual story row');document.querySelector('button[data-conversation-id="${imported.storyId}"]').click();await wait(()=>core.getContext().conversationId===${JSON.stringify(imported.storyId)},'Original selected');`);
  const other = await evaluate(`return window.otherForegroundStory;`); await register();
  scenario = 'success'; const successStart = requests.length; await send('Tool success');
  const successful = (await story(imported.storyId)).messages.at(-1), successRequests = requests.slice(successStart).filter(item => item.body.stream);
  assert.equal(successRequests.length, 2); assert.equal(successful.content, 'FINAL_success'); assert.equal(successful.generationMetadata.toolRounds.length, 1); assert.equal(successful.generationMetadata.toolRounds[0].invocations.length, 2);
  assert(!successRequests[0].body.tools.some(tool => tool.function.name === 'fixture_disabled')); assert.equal(successRequests[1].body.messages.filter(message => message.role === 'tool').length, 2);
  assert.equal(await evaluate(`return window.toolActions.filter(item=>item.case==='success').length;`), 2); assert(await evaluate(`return document.querySelectorAll('[data-actual-tool]').length>=2;`));
  record('actual-original-ToolManager-ESM-async-filter-two-ordinals-DOM-callback-and-model-result-followup', { requests: successRequests, message: successful });
  await evaluate(`const row=document.querySelector('#chat > .last_mes');row.querySelector('.tool-rounds > summary').click();await wait(()=>row.querySelector('[data-tool-round="0"] > summary'),'Actual round after expandable history');row.querySelector('[data-tool-round="0"] > summary').click();await wait(()=>row.querySelectorAll('.tool-invocation').length===2,'Actual invocation history');row.querySelector('.tool-invocation > summary').click();check(row.querySelector('.tool-round').textContent.includes('TOOL_PREFACE'),'Round preface visible');check(row.querySelector('.tool-invocation').textContent.includes('REAL_RESULT'),'Actual result expandable');check(row.querySelector('.tool-round .message-token-usage').textContent.includes('31 token'),'Own round usage visible');check(row.querySelector('.tool-round .token-accounting-details'),'Own round accounting visible');check(row.querySelector(':scope > .message-token-usage').textContent.includes('41 token'),'Final round usage separate');`);
  record('actual-expandable-round-preface-invocation-arguments-results-and-per-round-usage-accounting');
  scenario = 'failure'; const failStart = requests.length; await send('Tool failure'); const failure = (await story(imported.storyId)).messages.at(-1), failedRequests = requests.slice(failStart).filter(item => item.body.stream); assert.equal(failedRequests.length, 2); assert(failedRequests[1].body.messages.at(-1).content.includes('Fixture callback failed')); assert(failure.generationMetadata.toolRounds[0].invocations[0].error);
  record('actual-throwing-extension-callback-produces-error-tool-result-and-real-followup', { requests: failedRequests });
  for (const test of ['stop', 'navigation']) {
    scenario = test; const requestStart = requests.length;
    await evaluate(`window.toolCase=${JSON.stringify(test)};window.releaseTool=null;edit(document.getElementById('send_textarea'),${JSON.stringify('Tool ' + test)});document.getElementById('send_but').click();await wait(()=>window.releaseTool,'Actual held JS action');`);
    if (test === 'stop') await evaluate(`document.getElementById('mes_stop').click();await wait(()=>!core.getContext().nativeGenerating,'Actual stop while callback pending');window.releaseTool();await new Promise(resolve=>setTimeout(resolve,60));check(window.toolActions.filter(item=>item.case==='stop').length===1,'Second action blocked');`);
    else await evaluate(`document.querySelector('button[data-conversation-id="${other}"]').click();await wait(()=>core.getContext().conversationId===${JSON.stringify(other)}&&!core.getContext().nativeGenerating,'Actual navigation ends old callback wait');edit(document.getElementById('send_textarea'),'NEW_STORY_DRAFT');window.releaseTool();await new Promise(resolve=>setTimeout(resolve,60));check(window.toolActions.filter(item=>item.case==='navigation').length===1,'Navigation blocks second action');check(core.getContext().chat.length===1&&document.getElementById('send_textarea').value==='NEW_STORY_DRAFT','New story and draft untouched');document.querySelector('button[data-conversation-id="${imported.storyId}"]').click();await wait(()=>core.getContext().conversationId===${JSON.stringify(imported.storyId)},'Return after navigation');`);
    assert.equal(requests.slice(requestStart).filter(item => item.body.stream).length, 1);
    record('actual-' + test + '-releases-pending-extension-JS-and-blocks-later-callback-and-model-round');
  }
  scenario = 'limit'; const limitStart = requests.length; await send('Tool limit'); const limited = (await story(imported.storyId)).messages.at(-1); assert.equal(limited.status, 'failed'); assert.equal(limited.generationMetadata.toolRounds.length, 5); assert.equal(await evaluate(`return window.toolActions.filter(item=>item.case==='limit').length;`), 5); assert.equal(requests.slice(limitStart).filter(item => item.body.stream).length, 6);
  record('actual-five-tool-round-limit-stops-sixth-dispatch-and-persists-five-round-metadata');
  scenario = 'stealth'; const stealthStart = requests.length; await send('Tool stealth'); assert.equal(requests.slice(stealthStart).filter(item => item.body.stream).length, 1); assert.equal(await evaluate(`return window.toolActions.filter(item=>item.case==='stealth').length;`), 1); assert(!(await story(imported.storyId)).messages.at(-1).generationMetadata.toolRounds);
  record('actual-stealth-action-runs-without-result-transcript-or-followup');
  scenario = 'media'; await evaluate(`core.eventSource.once(core.event_types.CHAT_COMPLETION_SETTINGS_READY,request=>{request.stream=false;});`); await send('Native model media');
  const mediaMessage = (await story(imported.storyId)).messages.at(-1); assert.equal(mediaMessage.generationMetadata.responseState.media.length, 2);
  window.showInactive();
  await evaluate(`const row=document.querySelector('#chat > .last_mes');await wait(()=>row.querySelector('.model-media img')&&row.querySelector('.model-media audio'),'Native media controls mounted');row.scrollIntoView({block:'center'});const image=row.querySelector('.model-media img');await Promise.race([image.decode(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Native image decode deadline')),14000))]);check(image.naturalWidth===1,'Actual native image decoded');const audio=row.querySelector('.model-media audio');audio.load();await wait(()=>audio.readyState>=1,'Native model audio decode');audio.muted=true;await audio.play();await wait(()=>audio.currentTime>0,'Actual HTMLaudio playback time');audio.pause();check(audio.paused,'Real audio paused');check(row.querySelectorAll('.model-media a[download]').length===2,'Actual media downloads');`);
  record('actual-native-model-image-and-WAV-media-display-decode-muted-playback-and-downloads');
  const beforeRestart = await story(imported.storyId); await evaluate(`edit(document.getElementById('send_textarea'),'FINAL_PENDING_DRAFT');`); await restart();
  await evaluate(`nav('故事');await wait(()=>document.querySelector('button[data-conversation-id="${imported.storyId}"]'),'Actual new-port story');document.querySelector('button[data-conversation-id="${imported.storyId}"]').click();await wait(()=>core.getContext().conversationId===${JSON.stringify(imported.storyId)}&&document.getElementById('send_textarea').value==='FINAL_PENDING_DRAFT','Actual restored story and asynchronously hydrated composer draft');check(core.getContext().chat[0].mes==='Opening continued text partial text','Continuation restored');`);
  assert.deepEqual((await story(imported.storyId)).messages, beforeRestart.messages);
  window.showInactive();
  await evaluate(`const row=document.querySelector('#chat > .last_mes');await wait(()=>row.querySelector('.model-media img')&&row.querySelector('.model-media audio'),'Restarted native media controls');row.scrollIntoView({block:'center'});await Promise.race([row.querySelector('.model-media img').decode(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Restarted image decode deadline')),14000))]);row.querySelector('.model-media audio').load();await wait(()=>row.querySelector('.model-media img')?.naturalWidth===1&&row.querySelector('.model-media audio')?.readyState>=1,'Restarted native image and audio decode');`);
  await register(); scenario = 'after-restart'; const restartStart = requests.length; await send('After restart'); const restartRequest = requests.slice(restartStart).find(item => item.body.stream).body;
  assert.equal(restartRequest.messages.filter(message => message.role === 'tool' && message.content.includes('REAL_RESULT')).length, 2);
  record('actual-full-close-new-port-restores-chat-tool-rounds-and-next-request-replays-tool-transcript-once', { request: restartRequest });
  scenario = 'slash-input'; const slashStart = requests.length;
  const inputPipe = await evaluate(`const {executeSlashCommandsWithOptions}=await import('/scripts/slash-commands.js');window.actualSlash=executeSlashCommandsWithOptions;const result=await actualSlash('/setinput E01 compose | /pass {{pipe}}',{handleParserErrors:false,handleExecutionErrors:false});check(result.pipe==='E01 compose','Original setinput pipe');check(document.getElementById('send_textarea').value==='E01 compose','Original callback writes actual DOM composer');await new Promise(requestAnimationFrame);const previous=core.getContext().chat.at(-1)?.id;check(!document.getElementById('send_but').disabled,'React send state observes original bubbling input');document.getElementById('send_but').click();await wait(()=>core.getContext().chat.at(-1)?.id!==previous&&!core.getContext().nativeGenerating&&core.getContext().chat.at(-1)?.status==='complete'&&document.getElementById('send_textarea').value==='','Actual original setinput value sent through React');return result.pipe;`);
  const slashRequest = requests.slice(slashStart).find(item => item.body.stream)?.body;
  assert.equal(inputPipe, 'E01 compose'); assert(slashRequest); assert.equal(slashRequest.messages.filter(message => message.role === 'user').at(-1).content, 'E01 compose');
  assert.equal((await story(imported.storyId)).messages.filter(message => message.role === 'user').at(-1).content, 'E01 compose');
  record('actual-original-setinput-pipe-bubbling-input-React-send-and-provider-user-message', { request: slashRequest });
  const queryBefore = requests.length, queryMessages = (await story(imported.storyId)).messages;
  const messageQuery = await evaluate(`const options={handleParserErrors:false,handleExecutionErrors:false},range='0-'+(core.getContext().chat.length-1);const messages=await actualSlash('/messages names=off hidden=on role=user '+range,options),alias=await actualSlash('/message names=off hidden=on role=user '+range,options),invalid=await actualSlash('/messages 999999',options);check(messages.pipe.includes('E01 compose'),'Original messages reads actual accepted user');check(alias.pipe===messages.pipe,'Original alias shares messages callback');check(invalid.pipe==='','Original invalid range returns empty');check(document.getElementById('send_textarea').value==='','Queries do not modify actual composer');return{messages:messages.pipe,alias:alias.pipe,invalid:invalid.pipe};`);
  assert.equal(requests.length, queryBefore); assert.deepEqual((await story(imported.storyId)).messages, queryMessages);
  record('actual-original-messages-role-range-alias-and-invalid-query-use-live-chat-without-model-or-storage-write', { result: messageQuery });
  writeFileSync(reportPath, JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), label, profile, stages, sourceElectronOnly: true, completeP01: false, boundaries: ['No final EXE evidence', 'Tool UI fixture uses OpenAI-compatible wire; Claude/Gemini actual HTTP are separate evidence', 'Continue targets last assistant; user-message continuation and grouped overrides remain open', 'Started third-party side effects cannot be undone'] }, null, 2), { flag: 'wx' }); console.log('Report: ' + reportPath);
} catch (error) {
  let diagnostics; try { diagnostics = await window.webContents.executeJavaScript('({body:document.body.innerText,chat:window.foregroundTools?.core.getContext().chat,composer:document.getElementById("send_textarea")?.value,media:[...document.querySelectorAll(".model-media img,.model-media audio")].map(item=>({tag:item.tagName,naturalWidth:item.naturalWidth,readyState:item.readyState,error:item.error?.code})),actions:window.toolActions})'); } catch {}
  writeFileSync(reportPath, JSON.stringify({ passed: false, checkedAt: new Date().toISOString(), label, profile, stages, error: error.stack || String(error), diagnostics, requests }, null, 2), { flag: 'wx' }); console.error(error); process.exitCode = 1;
} finally { clearTimeout(deadline); for (const item of windows) if (!item.isDestroyed()) item.destroy(); await service?.close().catch(() => {}); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); app.exit(process.exitCode || 0); } }
void verify();
