// Actual React settings, safeStorage, HTTP task transport and restart checks.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, safeStorage } from 'electron';
import { buildApp, bindBrowserPort } from '../../local-service/dist/app.js';
import { installDesktopCloseGuard } from '../dist/desktop-close.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const profile = mkdtempSync(join(tmpdir(), 'mycompanion-provider-profiles-')), databasePath = join(profile, 'profile.sqlite');
const label = process.argv.find(value => value.startsWith('--label='))?.slice(8) ?? new Date().toISOString().replace(/[^a-z0-9]/gi, '-');
assert(/^[a-z0-9-]{1,90}$/i.test(label));
const reportPath = join(root, '.cache/reports/renderer-provider-profiles-' + label + '.json'); mkdirSync(dirname(reportPath), { recursive: true });
app.setPath('userData', profile); app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
const stages = [], windows = [], requests = [], consoleErrors = [];
const keys = { a: 'ELECTRON_A_PROFILE_SENTINEL', b: 'ELECTRON_B_PROFILE_SENTINEL', embedding: 'ELECTRON_EMBEDDING_PROFILE_SENTINEL' };
let service, window, origin, fixture, providerBase;
const provider = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); requests.push({ path: request.url, body, authorization: request.headers.authorization });
  if (request.url.endsWith('/embeddings')) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: body.input.map((_text, index) => ({ index, embedding: [1, 0.1, 0] })) })); return; }
  if (body.stream) { response.setHeader('Content-Type', 'text/event-stream'); response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Actual reply ' + body.model }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`); return; }
  const system = body.messages?.[0]?.content ?? '';
  const content = system.includes('记忆助手') ? '[{"type":"fact","content":"黄铜钥匙在林医生手里。","importance":3}]' : system.includes('摘要助手') ? 'Actual task summary.' : 'OK';
  response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
});
const deadline = setTimeout(() => { writeFileSync(reportPath, JSON.stringify({ passed: false, checkedAt: new Date().toISOString(), label, profile, stages, error: 'Provider profile verification deadline exceeded' }, null, 2), { flag: 'wx' }); app.exit(1); }, 100000);
function stage(value) { stages.push(value); console.log('Passed: ' + value); }
async function harness() {
  const core = await import('/script.js'), compat = await import('/plugin-runtime/compat-runtime.js'), host = await import('/plugin-runtime/desktop-host.js');
  await host.start();
  const wait = async (predicate, label) => { const end = Date.now() + 10000; while (!await predicate()) { if (Date.now() > end) throw new Error('Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 20)); } };
  const check = (value, label) => { if (!value) throw new Error(label); };
  const nav = label => (document.querySelector('button[aria-label="' + label + '"]') ?? [...document.querySelectorAll('nav button')].find(button => button.textContent.trim().startsWith(label))).click();
  const panel = () => document.querySelector('section[aria-label="保存的模型连接"]');
  const field = label => panel().querySelector('[aria-label="' + label + '"]');
  const button = label => [...panel().querySelectorAll('button')].find(button => button.textContent.trim() === label);
  const edit = async (element, value) => { check(element, 'Actual settings field'); const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value); element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); await new Promise(requestAnimationFrame); };
  const profiles = async () => fetch('/api/settings/providers').then(response => response.json());
  const add = async (name, url, model, key) => {
    button('新增连接').click(); await new Promise(requestAnimationFrame);
    for (const [label, value] of [['连接名称', name], ['服务地址', url], ['模型名称', model], ['API Key', key]]) await edit(field(label), value);
    button('保存连接').click(); await wait(() => panel().querySelector('[role=status]')?.textContent === '连接已保存。', 'Actual named connection save');
    check(field('API Key').value === '', 'Saved plaintext key cleared from actual field');
    const state = await profiles(); return state.profiles.find(profile => profile.name === name).id;
  };
  await wait(() => document.querySelector('.service-state--online') && window.__mycompanionFlushDrafts, 'Connected actual renderer');
  nav('设置'); await wait(() => panel() && field('编辑连接'), 'Real connection selector');
  panel().querySelector('details').open = true;
  window.providerProfilesHarness = { core, context: compat.getContext, host, wait, check, nav, panel, field, button, edit, profiles, add };
}
async function evaluate(body) {
  const result = await window.webContents.executeJavaScript(`(async()=>{try{const {core,context,host,wait,check,nav,panel,field,button,edit,profiles,add}=window.providerProfilesHarness;${body}}catch(error){return {__profileError:error.stack||String(error)}}})()`);
  if (result?.__profileError) throw new Error(result.__profileError); return result;
}
async function start() {
  service = buildApp({ databasePath, rendererRoot: join(root, 'apps/renderer/dist'), secretCodec: { seal: value => safeStorage.encryptString(value).toString('base64'), unseal: value => safeStorage.decryptString(Buffer.from(value, 'base64')) } });
  origin = await bindBrowserPort(port => service.listen({ host: '127.0.0.1', port }));
}
async function open() {
  window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } }); windows.push(window);
  window.webContents.on('console-message', event => { if (event.level === 'error') consoleErrors.push(event.message); });
  await window.loadURL(origin); await window.webContents.executeJavaScript(`(${harness.toString()})()`);
}
async function verify() { try {
  await app.whenReady(); assert(safeStorage.isEncryptionAvailable(), 'Actual Electron safeStorage available');
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve)); providerBase = `http://127.0.0.1:${provider.address().port}`;
  await start();
  const avatar = (await service.inject({ method: 'POST', url: '/api/characters/create', payload: { ch_name: 'Profile fixture role', first_mes: 'Hello' } })).body;
  const role = (await service.inject({ method: 'POST', url: '/api/characters/get', payload: { avatar_url: avatar } })).json();
  await open();
  fixture = await evaluate(`const ids={};for(const [name,path,model,key] of ${JSON.stringify([['A', 'a', 'A-model', keys.a], ['B', 'b', 'B-model', keys.b], ['Embedding', 'embedding', 'vector-model', keys.embedding]])})ids[path]=await add(name,${JSON.stringify(providerBase)}+'/'+path+'/v1',model,key);return ids;`);
  stage('actual-React-named-connections-use-Electron-safeStorage-and-clear-transient-fields');
  await evaluate(`await edit(field('编辑连接'),${JSON.stringify(fixture.a)});await edit(field('API Key'),'UNSAVED_OLD_PROFILE_KEY');await edit(field('编辑连接'),${JSON.stringify(fixture.b)});check(field('API Key').value==='','Editing a different saved connection clears old transient key');await edit(document.getElementById('provider-api-key'),'UNSAVED_MAIN_PROFILE_KEY');await edit(field('聊天使用'),${JSON.stringify(fixture.a)});await wait(()=>document.getElementById('provider-model').value==='A-model','Chat selection updates actual beginner form');check(document.getElementById('provider-api-key').value==='','Selecting chat connection clears main transient key');`);
  stage('switching-edit-and-chat-connections-cannot-carry-an-old-unsaved-key');
  await evaluate(`for(const [task,id] of ${JSON.stringify([['阶段摘要', fixture.b], ['记忆提取', fixture.b], ['语义检索 (Embedding)', fixture.embedding]])}){await edit(field(task),id);await wait(()=>!field(task).disabled,'Task assignment saved');}await edit(field('编辑连接'),${JSON.stringify(fixture.embedding)});button('测试 Embedding').click();await wait(()=>panel().querySelector('[role=status]')?.textContent==='Embedding 模型已返回有效向量。','Actual embedding test completes');check((await profiles()).tasks.chat===${JSON.stringify(fixture.a)},'Task assignment keeps chat selected independently');`);
  stage('actual-task-selectors-and-dedicated-Embedding-test-use-chosen-vector-model');
  await evaluate(`await core.getCharacters();await core.selectCharacterById(core.characters.findIndex(role=>role.id===${JSON.stringify(role.id)}));nav('故事');await wait(()=>document.getElementById('send_textarea')&&!document.getElementById('send_but').disabled,'Actual story ready');`);
  for (let i = 0; i < 7; i++) await evaluate(`await edit(document.getElementById('send_textarea'),'Profile round ${i}');document.getElementById('send_but').click();await wait(()=>context().chat.at(-1)?.mes==='Actual reply A-model'&&!context().isGenerating&&document.getElementById('send_textarea').value==='','Actual selected profile native reply');`);
  const storyId = await evaluate(`return context().conversationId;`);
  await evaluate(`await wait(async()=>{const saved=await fetch('/api/conversations/'+${JSON.stringify(storyId)}+'/summary').then(response=>response.json());return saved.summary?.content==='Actual task summary.';},'Independent actual summary model');`);
  const state = (await service.inject({ method: 'GET', url: '/api/settings/providers' })).json();
  assert.deepEqual(state.tasks, { chat: fixture.a, summary: fixture.b, extraction: fixture.b, embedding: fixture.embedding });
  for (const [path, key] of [['a', keys.a], ['b', keys.b], ['embedding', keys.embedding]]) {
    const sent = requests.filter(request => request.path.startsWith('/' + path + '/')); assert(sent.length > 0); assert(sent.every(request => request.authorization === 'Bearer ' + key));
  }
  assert(requests.some(request => request.body.model === 'B-model' && request.body.messages?.[0]?.content.includes('记忆助手')));
  assert(requests.some(request => request.body.model === 'B-model' && request.body.messages?.[0]?.content.includes('摘要助手')));
  assert(requests.some(request => request.body.model === 'vector-model' && request.path.endsWith('/embeddings')));
  const backup = (await service.inject({ method: 'GET', url: '/api/backup' })).body;
  for (const key of Object.values(keys)) assert(!backup.includes(key)); assert(!backup.includes('UNSAVED_'));
  stage('actual-native-React-chat-extraction-summary-and-vector-requests-observe-profile-targets-and-credentials');
  const beforeSwitch = requests.length;
  await evaluate(`const original=window.fetch;let changed=false;window.fetch=async(...args)=>{const response=await original(...args);if(!changed&&String(args[0]).endsWith('/api/conversations/'+context().conversationId+'/messages')&&response.headers.get('content-type')?.includes('text/event-stream')){changed=true;const result=await original('/api/settings/provider-tasks',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat:${JSON.stringify(fixture.b)}})}).then(response=>response.json());window.dispatchEvent(new CustomEvent('mycompanion:provider-saved',{detail:result.profiles.find(profile=>profile.id===result.tasks.chat).settings}));}return response;};try{await edit(document.getElementById('send_textarea'),'Change selected connection after native snapshot');document.getElementById('send_but').click();await wait(()=>changed&&context().chat.at(-1)?.mes==='Actual reply A-model'&&!context().isGenerating,'Real browser preflight keeps old invocation after durable selection changes');}finally{window.fetch=original;}await edit(document.getElementById('send_textarea'),'Next invocation uses new connection');document.getElementById('send_but').click();await wait(()=>context().chat.at(-1)?.mes==='Actual reply B-model'&&!context().isGenerating,'Next actual renderer generation uses new selected profile');`);
  const switchedChats = requests.slice(beforeSwitch).filter(request => request.body.stream);
  assert.deepEqual(switchedChats.map(request => [request.path,request.body.model,request.authorization]),[
    ['/a/v1/chat/completions','A-model','Bearer '+keys.a],['/b/v1/chat/completions','B-model','Bearer '+keys.b]
  ]);
  await evaluate(`nav('设置');await edit(field('聊天使用'),${JSON.stringify(fixture.a)});await wait(()=>!field('聊天使用').disabled&&document.getElementById('provider-model')?.value==='A-model','Restore selected chat for restart');`);
  stage('actual-browser-preflight-freezes-provider-snapshot-and-next-React-send-uses-new-profile');
  const guard = installDesktopCloseGuard(window, { beforeClose: async () => window.webContents.executeJavaScript('window.__mycompanionFlushDrafts()'), onError: error => { throw error; } }); assert.equal(await guard.requestClose(), true);
  const previous = origin; await service.close(); await start(); assert.notEqual(previous, origin); await open();
  assert.deepEqual((await service.inject({ method: 'GET', url: '/api/settings/providers' })).json().tasks, state.tasks);
  await evaluate(`await wait(()=>field('聊天使用').value===${JSON.stringify(fixture.a)}&&field('语义检索 (Embedding)').value===${JSON.stringify(fixture.embedding)},'Actual connection/task choices persist after new port restart');await wait(()=>document.getElementById('provider-model')?.value==='A-model','Restored beginner chat form matches selected profile');`);
  stage('actual-close-new-port-restart-preserves-profile-task-choices-without-plaintext-key-fields');
  await writeFile(reportPath, JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), label, profile, stages, consoleErrors, completeP01: false, transportRequestCount: requests.length }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ passed: true, stages: stages.length, reportPath }));
} catch (error) {
  let diagnostics; try { diagnostics = await window.webContents.executeJavaScript('document.body.innerText'); } catch {}
  await writeFile(reportPath, JSON.stringify({ passed: false, checkedAt: new Date().toISOString(), label, profile, stages, consoleErrors, error: error.stack || String(error), diagnostics }, null, 2), { flag: 'wx' }); console.error(error); process.exitCode = 1;
} finally { clearTimeout(deadline); for (const item of windows) if (!item.isDestroyed()) item.destroy(); if (service) await service.close(); await new Promise(resolve => provider.close(resolve)); app.exit(process.exitCode || 0); } }
void verify();
