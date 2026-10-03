// Real React controls, Chromium keyboard events, accessibility tree, SQLite and
// provider HTTP. This is a scoped diagnostic acceptance, not a WCAG audit.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { app, BrowserWindow } from 'electron';
import { buildApp, bindBrowserPort } from '../../local-service/dist/app.js';
import { RuntimeRepository } from '../../local-service/dist/runtime-repository.js';
import { installDesktopCloseGuard } from '../dist/desktop-close.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const profile = mkdtempSync(join(tmpdir(), 'mycompanion-diagnostics-')), databasePath = join(profile, 'test.sqlite');
const label = process.argv.find(value => value.startsWith('--label='))?.slice(8) ?? new Date().toISOString().replace(/[^a-z0-9]/gi, '-');
assert(/^[a-z0-9-]{1,90}$/i.test(label));
const reportPath = join(root, '.cache/reports/renderer-diagnostics-' + label + '.json'); mkdirSync(dirname(reportPath), { recursive: true });
app.setPath('userData', profile); app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
const stages = [], windows = [], providerRequests = [], observations = [], consoleErrors = [];
let service, window, origin, fixture, failRead = true, failWrite = true;
const sourceHashes = Object.fromEntries(['apps/renderer/src/views/MemoryPanel.tsx', 'apps/renderer/src/views/MemoryRetrievalDiagnostics.tsx', 'apps/renderer/src/views/TokenAccountingDetails.tsx', 'apps/renderer/src/views/WorldInfoVectorSettings.tsx', 'apps/renderer/src/diagnostic-translations.ts', 'apps/renderer/src/diagnostic-accessibility.css', 'apps/renderer/dist/index.html'].map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]));
const provider = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); providerRequests.push({ path: request.url, body });
  response.setHeader('Content-Type', body.stream ? 'text/event-stream' : 'application/json');
  if (body.stream) response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Diagnostic actual reply' }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 12, total_tokens: 12, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 4 } } })}\n\ndata: [DONE]\n\n`);
  else response.end(JSON.stringify({ choices: [{ message: { content: body.messages?.[0]?.content.includes('记忆助手') ? '[]' : 'OK' }, finish_reason: 'stop' }] }));
});
const deadline = setTimeout(() => { console.error('Diagnostic acceptance timed out'); app.exit(1); }, 100000);
function stage(value, evidence) { stages.push({ name: value, ...(evidence ? { evidence } : {}) }); console.log('Passed: ' + value); }
function repository(action) { const db = new DatabaseSync(databasePath); try { return action(new RuntimeRepository(db)); } finally { db.close(); } }
async function harness() {
  const core = await import('/script.js'), host = await import('/plugin-runtime/desktop-host.js'), compat = await import('/plugin-runtime/compat-runtime.js'); await host.start();
  const context = compat.getContext;
  const wait = async (predicate, label) => { const end = Date.now() + 10000; while (!await predicate()) { if (Date.now() > end) throw new Error('Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 20)); } };
  const check = (value, label) => { if (!value) throw new Error(label); };
  const nav = text => (document.querySelector('button[aria-label="' + text + '"]') ?? [...document.querySelectorAll('nav button')].find(button => button.textContent.trim().startsWith(text))).click();
  const button = (text, container = document) => [...container.querySelectorAll('button')].find(button => button.textContent.trim() === text);
  const edit = async (element, value) => { check(element, 'Actual field exists'); const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value); element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); await new Promise(requestAnimationFrame); };
  const pane = () => document.querySelector('.memory-panel');
  const focus = element => { check(element, 'Actual keyboard target exists'); element.scrollIntoView({ block: 'center' }); element.focus(); check(document.activeElement === element, 'Actual keyboard target focused'); };
  const focused = () => ({ tag: document.activeElement?.tagName, text: document.activeElement?.textContent?.trim().slice(0, 100), name: document.activeElement?.getAttribute('aria-label'), outline: getComputedStyle(document.activeElement).outline, outlineStyle: getComputedStyle(document.activeElement).outlineStyle, outlineWidth: Number.parseFloat(getComputedStyle(document.activeElement).outlineWidth), outlineColor: getComputedStyle(document.activeElement).outlineColor, focusVisible: document.activeElement.matches(':focus-visible') });
  await wait(() => document.querySelector('.service-state--online') && window.__mycompanionFlushDrafts, 'Actual React and service');
  window.diagnosticsHarness = { core, context, wait, check, nav, button, edit, pane, focus, focused };
}
async function evaluate(body) {
  const result = await window.webContents.executeJavaScript(`(async()=>{try{const {core,context,wait,check,nav,button,edit,pane,focus,focused}=window.diagnosticsHarness;${body}}catch(error){return {__diagnosticsError:error.stack||String(error)}}})()`);
  if (result?.__diagnosticsError) throw new Error(result.__diagnosticsError); return result;
}
async function key(keyCode, modifiers = []) {
  if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach('1.3');
  const virtual = { Enter: 13, Space: 32, Tab: 9 }[keyCode]; assert(virtual);
  const event = { key: keyCode === 'Space' ? ' ' : keyCode, code: keyCode, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual, modifiers: modifiers.includes('shift') ? 8 : 0 };
  // Chromium dispatch supplies genuine keyboard default actions in a hidden
  // source window; Electron sendInputEvent requires an OS-focused window.
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...event, ...(keyCode === 'Enter' ? { text: '\r' } : keyCode === 'Space' ? { text: ' ' } : {}) });
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
  await new Promise(resolve => setTimeout(resolve, 30));
}
async function start() {
  service = buildApp({ databasePath, rendererRoot: join(root, 'apps/renderer/dist') });
  service.addHook('preHandler', async (request, reply) => {
    if (request.method === 'GET' && /\/memories(?:\?|$)/.test(request.url) && failRead) { failRead = false; return reply.code(503).send({ error: { code: 'FIXTURE_READ', message: 'Fixture read failure' } }); }
    if (request.method === 'PUT' && /\/memories\//.test(request.url) && failWrite) { failWrite = false; return reply.code(503).send({ error: { code: 'FIXTURE_WRITE', message: 'Fixture write failure' } }); }
  });
  origin = await bindBrowserPort(port => service.listen({ host: '127.0.0.1', port }));
}
async function open() {
  window = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } }); windows.push(window);
  window.webContents.on('console-message', event => { if (event.level === 'error') consoleErrors.push(event.message); });
  await window.loadURL(origin); await window.webContents.executeJavaScript(`(${harness.toString()})()`);
}
async function axTree() {
  if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach('1.3');
  await window.webContents.debugger.sendCommand('Accessibility.enable');
  const { nodes } = await window.webContents.debugger.sendCommand('Accessibility.getFullAXTree');
  return nodes.filter(node => !node.ignored).map(node => ({ role: node.role?.value, name: node.name?.value, properties: node.properties }));
}
async function mouseNavigation(destination) {
  const point = await evaluate(`const target=document.querySelector('button[aria-label="${destination}"]')??[...document.querySelectorAll('nav button')].find(item=>item.textContent.trim().startsWith('${destination}'));target.scrollIntoView({block:'center',behavior:'instant'});await new Promise(requestAnimationFrame);const rect=target.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2;check(target.contains(document.elementFromPoint(x,y)),'Actual ${destination} is not obscured at mouse position');return {x,y};`);
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  await new Promise(resolve => setTimeout(resolve, 30));
}
async function chooser(action) {
  // Observe the real React handler reaching its existing file input. Cancel
  // only the test's OS dialog default, rather than opening a user-facing dialog.
  await evaluate(`window.importActivationCount=0;window.importObserver=event=>{window.importActivationCount++;event.preventDefault();};document.querySelector('input[aria-label="选择角色卡文件"]').addEventListener('click',window.importObserver);`);
  try { await action(); await evaluate(`check(window.importActivationCount===1,'Actual import action reaches existing file input; count='+window.importActivationCount+'; focus='+document.activeElement.outerHTML.slice(0,250));`); }
  finally { await evaluate(`document.querySelector('input[aria-label="选择角色卡文件"]').removeEventListener('click',window.importObserver);delete window.importObserver;`); }
}
async function verify() { try {
  await app.whenReady(); await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve)); await start();
  const avatar = (await service.inject({ method: 'POST', url: '/api/characters/create', payload: { ch_name: 'Diagnostics character', first_mes: 'Original source 星塔在北方。' } })).body;
  const role = (await service.inject({ method: 'POST', url: '/api/characters/get', payload: { avatar_url: avatar } })).json();
  const settings = await service.inject({ method: 'PUT', url: '/api/settings/provider', payload: { kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, model: 'diagnostics-unknown-model', clearApiKey: true, temperature: 0, maxTokens: 500, contextLimitTokens: 8192 } }); assert.equal(settings.statusCode, 200, settings.body);
  await open();
  fixture = await evaluate(`await core.getCharacters();await core.selectCharacterById(core.characters.findIndex(role=>role.id===${JSON.stringify(role.id)}));const editor=document.querySelector('.character-editor-dock');if(editor&&!editor.hidden)editor.querySelector('header button').click();nav('故事');await wait(()=>core.getCurrentChatId()&&document.getElementById('send_textarea')&&!document.getElementById('send_but').disabled,'Actual selected story');return {characterId:core.characters[core.this_chid].id,storyId:core.getCurrentChatId()};`);
  fixture.memoryId = randomUUID();
  repository(runtime => {
    const story = runtime.getConversation(fixture.storyId); const sourceId = story.messages[0].id;
    runtime.setAutoSummaryEnabled(fixture.storyId, false);
    runtime.addMemory({ id: fixture.memoryId, conversationId: fixture.storyId, characterId: fixture.characterId, type: 'fact', scope: 'story', content: '星塔在北方', importance: 3, status: 'active', pinned: true, sourceMessageIds: [sourceId], supersededBy: null, previousContent: '用户原文保持不变', createdAt: new Date().toISOString(), lastUsedAt: null });
  });
  await evaluate(`await edit(document.getElementById('send_textarea'),'Where is 星塔?');document.getElementById('send_but').click();await wait(()=>context().chat.at(-1)?.mes==='Diagnostic actual reply'&&!context().isGenerating,'Actual provider reply');await wait(()=>document.querySelector('#chat .message-token-usage'),'Actual reported usage');focus(document.querySelector('#chat .message-token-usage summary'));`);
  await key('Enter');
  const usage = await evaluate(`const details=document.querySelector('#chat .message-token-usage');check(details.open,'Enter opens provider usage');check(details.textContent.includes('0 token')&&details.textContent.includes('12 token'),'Actual zero and total usage visible');check(details.textContent.includes('推理输出包含在提供商输出中，不再加到总用量。'),'Reasoning not added twice');check(!details.textContent.includes('500 token'),'Output reserve not shown as local input');return {text:details.innerText,focus:focused()};`);
  await key('Enter'); await evaluate(`check(!document.querySelector('#chat .message-token-usage').open,'Enter closes native usage disclosure');`);
  stage('native-provider-usage-zero-total-reasoning-and-Enter-disclosure', usage);

  await evaluate(`nav('记忆');await wait(()=>pane()?.querySelector('[role=alert]'),'Readable actual memory load error');check(pane().querySelector('[role=alert]').textContent==='无法读取记忆，请重试。','Load error explains a recovery');focus(button('重试读取记忆',pane()));`);
  await key('Enter');
  await evaluate(`await wait(()=>pane().querySelector('[data-memory-edit]'),'Keyboard retry loads real persisted memory');check(pane().textContent.includes('星塔在北方'),'User content retained');focus(pane().querySelector('[data-memory-edit]'));`);
  stage('read-failure-has-text-alert-and-actual-keyboard-retry');
  await key('Enter');
  await evaluate(`check(document.activeElement===pane().querySelector('[aria-label="编辑记忆"]'),'Editor receives focus');await edit(document.activeElement,'尚未保存的用户草稿');focus(button('保存',pane()));`);
  await key('Enter');
  await evaluate(`await wait(()=>pane().querySelector('[role=alert]')?.textContent==='无法更新记忆，请重试。','Actual rejected save explains failure');check(pane().querySelector('[aria-label="编辑记忆"]').value==='尚未保存的用户草稿','Failed save retains draft');focus(button('取消',pane()));`);
  await key('Enter');
  await evaluate(`check(document.activeElement===pane().querySelector('[data-memory-edit]'),'Cancel restores actual Edit focus');focus(pane().querySelector('.memory-sources summary'));`);
  await key('Enter');
  await evaluate(`await wait(()=>pane().querySelector('.memory-sources pre'),'Keyboard disclosure loads actual source');check(pane().querySelector('.memory-sources').open,'Sources expanded');check(pane().querySelector('.memory-sources pre').textContent==='Original source 星塔在北方。','Original source text retained');`);
  await key('Space'); await evaluate(`check(!pane().querySelector('.memory-sources').open,'Space closes actual source disclosure');focus(pane().querySelector('[aria-label="检索测试文本"]'));`);
  await key('Tab');
  const retrievalFocus = await evaluate(`check(document.activeElement===button('运行检索',pane()),'Tab reaches retrieval action');return focused();`);
  assert.equal(retrievalFocus.focusVisible, true); assert(retrievalFocus.outlineStyle === 'solid' && retrievalFocus.outlineWidth > 0 && retrievalFocus.outlineColor === 'rgb(20, 93, 168)');
  stage('edit-failure-retains-draft-cancel-restores-focus-native-sources-Enter-Space-and-Tab-ring', retrievalFocus);
  await evaluate(`await edit(pane().querySelector('[aria-label="检索测试文本"]'),'我的检索草稿 星塔');focus(button('运行检索',pane()));`); await key('Enter');
  await evaluate(`await wait(()=>pane().querySelector('.memory-panel__test-result'),'Actual service retrieval result');check([...pane().querySelectorAll('[role=status]')].some(item=>item.textContent==='检索完成：注入 1 条记忆。'),'Concise completion live region');focus(pane().querySelector('.memory-retrieval-diagnostics summary'));`); await key('Enter');
  const zhAx = await axTree();
  assert(zhAx.some(node => node.role === 'textbox' && node.name === '检索测试文本'));
  assert(zhAx.some(node => node.name === '高级检索诊断' && node.properties?.some(property => property.name === 'expanded' && property.value?.value === true)));
  stage('actual-retrieval-data-status-and-accessibility-names-and-expanded-state', zhAx.filter(node => ['textbox', 'status', 'alert', 'DisclosureTriangle'].includes(node.role)));

  await evaluate(`nav('设置');const language=document.querySelector('select[aria-label="界面语言"]');await edit(language,'en');await wait(()=>document.documentElement.lang==='en'&&document.querySelector('select[aria-label="Interface language"]'),'Actual English preference');nav('Memory');await wait(()=>pane()?.querySelector('h2')?.textContent==='Memory','English memory renderer');check(pane().querySelector('[aria-label="Retrieval test text"]').value==='我的检索草稿 星塔','Language change preserves typed draft');check(pane().querySelector('[role=alert]')?.textContent==='Could not update this memory. Please retry.','Existing application error switches to English');check(pane().textContent.includes('Included using the separate pinned-memory budget.')&&pane().textContent.includes('Matched keywords: 星塔'),'Actual service diagnostics in English preserve user term');check(pane().textContent.includes('星塔在北方'),'User memory not translated');check(document.getElementById('option_continue').textContent==='Continue reply'&&document.getElementById('option_impersonate').textContent==='Draft my message','Foreground actions localized');document.querySelector('#chat .message-token-usage').open=true;document.querySelector('#chat .token-accounting-details').open=true;check(document.querySelector('#chat .message-token-usage').textContent.includes('Provider-reported usage'),'Usage translated');check(document.querySelector('#chat .token-accounting-details').textContent.includes("This model's tokenizer is unknown; text uses a compatibility estimate."),'Actual unknown-tokenizer reason translated');`);
  const enAx = await axTree(); assert(enAx.some(node => node.role === 'textbox' && node.name === 'Retrieval test text'));
  stage('real-language-toggle-translates-errors-token-retrieval-and-foreground-actions-keeps-user-prose-and-draft');

  await evaluate(`nav('Characters');await wait(()=>document.getElementById('world_button'),'Actual worldbook editor launcher');document.getElementById('world_button').click();await wait(()=>!document.querySelector('.world-info-dock').hidden&&document.querySelector('.world-info-vectors'),'Actual visible worldbook vector settings');focus(document.querySelector('.world-info-vectors summary'));`);
  await key('Enter'); await key('Tab');
  const vectorFocus = await evaluate(`const input=document.querySelector('[data-vector-setting="enabled_world_info"]');await wait(()=>!input.matches(':disabled'),'Ready vector setting');check(document.querySelector('.world-info-vectors').open,'English vector disclosure keyboard opens');check(document.activeElement===input,'Tab reaches actual vector checkbox');check(input.closest('label').textContent.includes('Enable worldbook vector matching'),'Actual checkbox English label');return focused();`);
  assert(vectorFocus.focusVisible && vectorFocus.outlineStyle === 'solid' && vectorFocus.outlineWidth > 0);
  await key('Space'); await evaluate(`await wait(async()=>{const state=await fetch('/api/extensions/settings').then(response=>response.json());return state.extensionSettings.vectors?.enabled_world_info===true;},'Actual keyboard vector setting durable save');document.querySelector('.world-info-dock header button').click();nav('Memory');`);
  stage('English-vector-labels-native-Enter-Tab-Space-control-and-durable-setting', vectorFocus);

  await evaluate(`focus([...document.querySelectorAll('nav button')].find(item=>item.textContent.trim().startsWith('Memory')));`);
  for (const factor of [1.6, 2]) {
    window.webContents.setZoomFactor(factor); await new Promise(resolve => setTimeout(resolve, 50));
    const observation = await evaluate(`const navs=[...document.querySelectorAll('nav button')],settings=document.querySelector('button[aria-label="Settings"]');check(navs.every(item=>item.getClientRects().length)&&settings.getClientRects().length,'Every destination and Settings stays visible at zoom');check(document.activeElement.textContent.trim().startsWith('Memory'),'Zoom preserves existing navigation focus');return {zoom:${factor},viewport:{width:innerWidth,height:innerHeight},horizontalOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,visibleNavigation:navs.filter(item=>item.getClientRects().length).map(item=>item.textContent.trim()),settingsVisible:Boolean(settings.getClientRects().length),memoryVisible:Boolean(pane()?.getClientRects().length),focus:focused(),overflowingElements:[...document.querySelectorAll('body *')].filter(item=>item.getClientRects().length&&item.getBoundingClientRect().right>innerWidth+1).slice(0,10).map(item=>({tag:item.tagName,class:item.className,id:item.id,right:item.getBoundingClientRect().right,width:item.getBoundingClientRect().width}))};`);
    observations.push(observation); assert.equal(observation.horizontalOverflow, false, 'No horizontal document overflow at ' + factor * 100 + '%');
    await key('Enter'); await evaluate(`check(!document.querySelector('.workspace-view').hidden,'Focused Memory destination still operates by keyboard');`);
  }
  window.webContents.setZoomFactor(1);
  window.setContentSize(320, 900); await new Promise(resolve => setTimeout(resolve, 50));
  const narrow = await evaluate(`return {width:innerWidth,height:innerHeight,horizontalOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,visibleNavigation:[...document.querySelectorAll('nav button')].filter(item=>item.getClientRects().length).map(item=>item.textContent.trim()),settingsVisible:Boolean(document.querySelector('button[aria-label="Settings"]').getClientRects().length),overflowingElements:[...document.querySelectorAll('body *')].filter(item=>item.getClientRects().length&&item.getBoundingClientRect().right>innerWidth+1).slice(0,10).map(item=>({tag:item.tagName,class:item.className,id:item.id,right:item.getBoundingClientRect().right,width:item.getBoundingClientRect().width}))};`);
  observations.push(narrow); assert.equal(narrow.width, 320); assert.equal(narrow.horizontalOverflow, false, 'No horizontal document overflow at 320 CSS pixels'); assert.equal(narrow.visibleNavigation.length, 5); assert(narrow.settingsVisible);
  for (const destination of ['Characters', 'Stories', 'Extensions', 'Memory', 'Settings']) {
    await evaluate(`const target=document.querySelector('button[aria-label="${destination}"]')??[...document.querySelectorAll('nav button')].find(item=>item.textContent.trim().startsWith('${destination}'));focus(target);`); await key('Enter');
    const page = await evaluate(`const target=document.activeElement;check(target.tagName==='BUTTON'&&(target.getAttribute('aria-current')==='page'||target.getAttribute('aria-pressed')==='true'),'Actual narrow ${destination} keyboard navigation and focus retained');return {destination:'${destination}',horizontalOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,overflowingElements:[...document.querySelectorAll('body *')].filter(item=>item.getClientRects().length&&getComputedStyle(item).visibility!=='hidden'&&item.getBoundingClientRect().right>innerWidth+1).slice(0,10).map(item=>({tag:item.tagName,class:item.className,id:item.id,right:item.getBoundingClientRect().right,width:item.getBoundingClientRect().width}))};`);
    observations.push(page); assert.equal(page.horizontalOverflow, false, destination + ' page has no horizontal overflow at 320 CSS pixels'); assert.equal(page.overflowingElements.length, 0, destination + ' actual content does not overflow a nested scrolling panel');
    await evaluate(`nav('${destination === 'Memory' ? 'Settings' : 'Memory'}');`);
    await mouseNavigation(destination);
    await evaluate(`const target=document.querySelector('button[aria-label="${destination}"]')??[...document.querySelectorAll('nav button')].find(item=>item.textContent.trim().startsWith('${destination}'));check(target.getAttribute('aria-current')==='page'||target.getAttribute('aria-pressed')==='true','Actual narrow ${destination} mouse navigation');`);
  }
  await evaluate(`focus(document.querySelector('nav .nav-row--new'));`); await chooser(() => key('Enter'));
  await chooser(() => mouseNavigation('Import character'));
  stage('all-six-narrow-navigation-actions-use-Chromium-keyboard-and-mouse-including-actual-import-file-input-activation');
  stage('160-and-200-percent-and-320-CSS-pixels-retain-all-navigation-and-keyboard-focus-without-horizontal-overflow', observations);
  window.setContentSize(1440, 1000); await evaluate(`nav('Memory');`);
  const guard = installDesktopCloseGuard(window, { beforeClose: async () => window.webContents.executeJavaScript('window.__mycompanionFlushDrafts()'), onError: error => { throw error; } }); assert.equal(await guard.requestClose(), true);
  const previous = origin; await service.close(); await start(); assert.notEqual(origin, previous); await open();
  await evaluate(`await wait(()=>document.documentElement.lang==='en','Shared profile restores English on new port');nav('Stories');await wait(()=>document.querySelector('button[data-conversation-id="${fixture.storyId}"]'),'Persisted story');document.querySelector('button[data-conversation-id="${fixture.storyId}"]').click();await wait(()=>document.querySelector('#chat .message-token-usage'),'Persisted actual message usage');nav('Memory');await wait(()=>pane()?.querySelector('[data-memory-edit]'),'Restored memory');check(pane().querySelector('h2').textContent==='Memory','Restored English memory');check(pane().textContent.includes('星塔在北方')&&!pane().textContent.includes('尚未保存的用户草稿'),'Rejected edit never overwrites SQLite');document.querySelector('#chat .message-token-usage').open=true;check(document.querySelector('#chat .message-token-usage').textContent.includes('12 token'),'Reported usage survives restart');const settings=await fetch('/api/extensions/settings').then(response=>response.json());check(settings.extensionSettings.vectors.enabled_world_info===true,'Keyboard vector switch survives restart');`);
  stage('actual-close-new-service-port-restores-language-reported-usage-memory-and-keyboard-vector-setting');
  await writeFile(reportPath, JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), label, profile, stages, observations, sourceHashes, consoleErrors, providerRequestCount: providerRequests.length, keyboardTransport: 'Chromium Input.dispatchKeyEvent', completeU05: false, wcagConformanceClaim: false, assistiveTechnologyHumanTested: false }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ passed: true, stages: stages.length, reportPath }));
} catch (error) {
  let diagnostics; try { diagnostics = await window.webContents.executeJavaScript('document.body.innerText'); } catch {}
  await writeFile(reportPath, JSON.stringify({ passed: false, checkedAt: new Date().toISOString(), label, profile, stages, observations, sourceHashes, consoleErrors, error: error.stack || String(error), diagnostics, completeU05: false }, null, 2), { flag: 'wx' }); console.error(error); process.exitCode = 1;
} finally { clearTimeout(deadline); for (const item of windows) if (!item.isDestroyed()) item.destroy(); await service?.close(); await new Promise(resolve => provider.close(resolve)); app.exit(process.exitCode || 0); } }
void verify();
