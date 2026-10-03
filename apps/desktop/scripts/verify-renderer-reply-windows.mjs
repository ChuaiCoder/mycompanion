// Project-owned data and actual React controls exercise reply persistence,
// extension listeners, independent branches, and the recent-message DOM window.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, cpus, totalmem, release, platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { app, BrowserWindow } from 'electron';
import { bindBrowserPort, buildApp } from '../../local-service/dist/app.js';
import { installDesktopCloseGuard } from '../dist/desktop-close.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const profile = mkdtempSync(join(tmpdir(), 'mycompanion-reply-windows-')), databasePath = join(profile, 'profile.sqlite');
const label = process.argv.find(value => value.startsWith('--label='))?.slice(8) ?? new Date().toISOString().replace(/[^a-z0-9]/gi, '-');
assert(/^[a-z0-9-]{1,90}$/i.test(label));
const reportPath = join(root, '.cache/reports/renderer-reply-windows-' + label + '.json'); mkdirSync(dirname(reportPath), { recursive: true });
app.setPath('userData', profile); app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
const stages = [], windows = [], providerRequests = [];
let service, window, origin, performance;
const hardware = { platform: platform(), osRelease: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), electron: process.versions.electron, chromium: process.versions.chrome, hardwareAcceleration: false };
const provider = createServer(async (request, response) => {
  try {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text || '{}'); providerRequests.push(body);
    if (body.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Native reply ' + providerRequests.length } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    } else { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '[]' }, finish_reason: 'stop' }] })); }
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
const record = (name, evidence) => { stages.push({ name, ...(evidence ? { evidence } : {}) }); console.log('Passed: ' + name); };
const deadline = setTimeout(() => { writeFileSync(reportPath, JSON.stringify({ passed: false, checkedAt: new Date().toISOString(), label, profile, stages, hardware, error: 'Reply/window deadline exceeded' }, null, 2), { flag: 'wx' }); app.exit(1); }, 300_000);
const sql = action => { const db = new DatabaseSync(databasePath); try { return action(db); } finally { db.close(); } };
const story = async id => (await service.inject({ method: 'GET', url: '/api/conversations/' + id })).json();
async function start() { service = buildApp({ databasePath, rendererRoot: join(root, 'apps/renderer/dist') }); origin = await bindBrowserPort(port => service.listen({ host: '127.0.0.1', port })); }
async function harness() {
  const wait = async (predicate, label) => { const until = Date.now() + 12_000; while (!await predicate()) { if (Date.now() > until) throw new Error('Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 16)); } };
  const check = (value, label) => { if (!value) throw new Error(label); };
  const button = (label, container = document) => [...container.querySelectorAll('button')].find(item => item.textContent.trim() === label);
  const nav = label => [...document.querySelectorAll('nav button')].find(item => item.textContent.trim().startsWith(label)).click();
  const edit = (element, value) => { check(element, 'Real input'); const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value); element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); };
  await wait(() => document.querySelector('.service-state--online') && window.__mycompanionFlushDrafts, 'Actual connected app');
  const compat = await import('/plugin-runtime/compat-runtime.js'), rendering = await import('/plugin-runtime/message-rendering.js'), chat = await import('/plugin-runtime/chat.js');
  const host = await import('/plugin-runtime/desktop-host.js'); await host.start();
  window.replyWindows = { core: { ...compat, ...rendering, ...chat }, wait, check, button, nav, edit };
}
async function ready() { await window.webContents.executeJavaScript(`(${harness.toString()})()`); }
async function evaluate(body) {
  const result = await window.webContents.executeJavaScript(`(async()=>{try{const {core,wait,check,button,nav,edit}=window.replyWindows;${body}}catch(error){return {__replyWindowsError:error.stack||String(error)}}})()`);
  if (result?.__replyWindowsError) throw new Error(result.__replyWindowsError); return result;
}
async function open() { window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } }); windows.push(window); await window.loadURL(origin); await ready(); }
async function restart() { const previous = origin, guard = installDesktopCloseGuard(window, { beforeClose: async () => {}, onError: error => { throw error; } }); assert.equal(await guard.requestClose(), true); await service.close(); await start(); assert.notEqual(origin, previous); await open(); }
async function reload() { const loaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve)); window.webContents.reload(); await loaded; await ready(); }

async function verify() { try {
  await app.whenReady(); await start(); await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const configured = await service.inject({ method: 'PUT', url: '/api/settings/provider', payload: { kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, model: 'reply-fixture', clearApiKey: true, temperature: 0, maxTokens: 64, contextLimitTokens: 8192 } }); assert.equal(configured.statusCode, 200, configured.body);
  await open();
  const card = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Reply window role', description: 'Role', first_mes: 'Opening', personality: '', scenario: '', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: { retained: { custom: true } } } };
  const imported = await evaluate(`const transfer=new DataTransfer();transfer.items.add(new File([atob(${JSON.stringify(Buffer.from(JSON.stringify(card)).toString('base64'))})],'reply-window.json',{type:'application/json'}));const input=document.querySelector('input[aria-label="选择角色卡文件"]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));await wait(()=>button('确认导入'),'Card preview');button('确认导入').click();await wait(()=>button('开始对话'),'Imported role');button('开始对话').click();await wait(()=>core.getContext().conversationId&&document.querySelector('#send_textarea')&&!document.querySelector('#send_textarea').disabled,'Real story');return {storyId:core.getContext().conversationId,roleId:core.getContext().characterUuid,branchId:core.getContext().branchId};`);
  const firstReply = await evaluate(`edit(document.getElementById('send_textarea'),'Question');document.getElementById('send_but').click();await wait(()=>core.getContext().chat.length===3&&core.getContext().chat[2].status==='complete'&&!document.querySelector('.generating-indicator'),'Actual reply');return {id:core.getContext().chat[2].id,content:core.getContext().chat[2].mes};`);
  record('actual-json-import-and-native-provider-reply', { storyId: imported.storyId, branchId: imported.branchId, reply: firstReply });
  const memoryId = randomUUID();
  sql(db => db.prepare('INSERT INTO memories(id,conversation_id,character_id,type,content,scope,importance,status,pinned,source_message_ids_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(memoryId, imported.storyId, imported.roleId, 'fact', 'Original reply source', 'story', 3, 'active', 0, JSON.stringify([firstReply.id]), new Date().toISOString()));
  const second = await evaluate(`button('重新生成').click();await wait(()=>core.getContext().branchId!==${JSON.stringify(imported.branchId)}&&core.getContext().chat[2]?.id!==${JSON.stringify(firstReply.id)}&&core.getContext().chat[2]?.status==='complete'&&!document.querySelector('.generating-indicator'),'Regenerated actual branch');const branchId=core.getContext().branchId;button('回复分支').click();await wait(()=>document.querySelector('select[aria-label="切换回复分支"]')?.options.length===2,'Two independent reply branches');edit(document.querySelector('select[aria-label="切换回复分支"]'),${JSON.stringify(imported.branchId)});await wait(()=>core.getContext().branchId===${JSON.stringify(imported.branchId)}&&core.getContext().chat[2].mes===${JSON.stringify(firstReply.content)},'Selected original actual branch');return {branchId};`);
  assert.equal((await story(imported.storyId)).activeBranchId, imported.branchId);
  const memories = (await service.inject({ method: 'GET', url: `/api/conversations/${imported.storyId}/memories` })).json().items;
  assert.equal(memories.find(item => item.id === memoryId).status, 'active');
  const tree = (await service.inject({ method: 'GET', url: `/api/conversations/${imported.storyId}/export?format=json` })).json(); assert(tree.messages.some(item => item.branchId === second.branchId && item.content !== firstReply.content && item.role === 'assistant'));
  record('actual-regenerate-and-native-branch-selector-preserve-prefixes-original-reply-and-memory-reachability', { secondBranchId: second.branchId });
  await evaluate(`const message=core.getContext().chat[2];message.swipes=[message.mes,'Imported alternate'];message.swipe_id=0;message.extra={variables:{left:4}};message.swipe_info=[{send_date:message.send_date,extra:{variables:{left:4}},custom:{keep:true}},{send_date:'2026-10-03T00:00:00.000Z',extra:{variables:{right:9}},custom:{right:true}}];message.originalOutputs={keep:true};await core.saveChatConditional();await wait(()=>document.querySelector('.swipe_right'),'Real candidate controls');window.swipeListener=async index=>{await new Promise(resolve=>{window.resumeSwipe=resolve});core.getContext().chat[index].extra.listener='awaited';};core.eventSource.on(core.event_types.MESSAGE_SWIPED,window.swipeListener);document.querySelector('.swipe_right').click();await wait(()=>window.resumeSwipe,'Awaited real listener');check(core.getContext().chat[2].mes==='Imported alternate','Optimistic actual candidate');check(document.querySelectorAll('#chat .mes_text')[2].textContent==='Imported alternate','Same visible DOM updated');`);
  assert.equal((await story(imported.storyId)).messages[2].content, firstReply.content);
  await evaluate(`window.resumeSwipe();await wait(()=>!document.querySelector('.swipe_left').disabled,'Awaited listener persisted');core.eventSource.off(core.event_types.MESSAGE_SWIPED,window.swipeListener);`);
  const savedAlternate = (await story(imported.storyId)).messages[2]; assert.equal(savedAlternate.content, 'Imported alternate'); assert.equal(savedAlternate.extensionData.extra.listener, 'awaited'); assert.deepEqual(savedAlternate.extensionData.swipe_info[0].custom, { keep: true }); assert.deepEqual(savedAlternate.extensionData.originalOutputs, { keep: true });
  record('actual-candidate-controls-await-listener-before-save-and-keep-per-candidate-extra-unknown-fields');
  sql(db => db.exec(`CREATE TRIGGER fail_reply_save BEFORE INSERT ON messages WHEN NEW.id='${firstReply.id}' AND NEW.branch_id='${imported.branchId}' BEGIN SELECT RAISE(ABORT,'fixture reply save failed'); END;`));
  await evaluate(`document.querySelector('.swipe_left').click();await wait(()=>document.querySelector('.panel-error')?.textContent.includes('候选回复操作失败'),'Actual failed SQL write surfaced');check(core.getContext().chat[2].mes==='Imported alternate','Host reconciled durable candidate');check(document.querySelectorAll('#chat .mes_text')[2].textContent==='Imported alternate','Visible candidate reconciled');check(document.querySelector('.swipes-counter').textContent.trim()==='2 / 2','Durable swipe id restored');`);
  assert.deepEqual((await story(imported.storyId)).messages[2], savedAlternate);
  sql(db => db.exec('DROP TRIGGER fail_reply_save'));
  await evaluate(`document.querySelector('.swipe_left').click();await wait(()=>core.getContext().chat[2].swipe_id===0&&!document.querySelector('.swipe_right').disabled,'Successful actual retry');check(core.getContext().chat[2].mes===${JSON.stringify(firstReply.content)},'Original candidate restored');`);
  record('actual-sql-write-failure-reconciles-host-and-dom-to-durable-state-and-retry-succeeds');
  await evaluate(`nav('角色库');await wait(()=>button('开始对话'),'Actual library after navigation');button('开始对话').click();await wait(()=>core.getContext().conversationId!==${JSON.stringify(imported.storyId)},'New actual story');window.otherReplyStory=core.getContext().conversationId;nav('故事');document.querySelector('button[data-conversation-id="${imported.storyId}"]').click();await wait(()=>core.getContext().conversationId===${JSON.stringify(imported.storyId)}&&document.querySelector('.swipe_right'),'Return original story');window.navigationListener=async index=>{core.getContext().chat[index].extra.navigationListener='old-target';document.querySelector('button[data-conversation-id="'+window.otherReplyStory+'"]').click();await wait(()=>core.getContext().conversationId===window.otherReplyStory,'Listener real navigation');};core.eventSource.on(core.event_types.MESSAGE_SWIPED,window.navigationListener);document.querySelector('.swipe_right').click();await wait(()=>core.getContext().conversationId===window.otherReplyStory,'Actual target changed during awaited listener');await core.flushChatSaves();core.eventSource.off(core.event_types.MESSAGE_SWIPED,window.navigationListener);check(core.getContext().chat.length===1&&core.getContext().chat[0].mes==='Opening','New story unaffected');`);
  const navigated = (await story(imported.storyId)).messages[2]; assert.equal(navigated.content, 'Imported alternate'); assert.equal(navigated.extensionData.extra.navigationListener, 'old-target');
  record('actual-awaited-navigation-listener-saves-captured-old-target-without-writing-new-story');

  const created = await service.inject({ method: 'POST', url: '/api/conversations', payload: { characterId: imported.roleId } }); assert.equal(created.statusCode, 201, created.body); const long = created.json(), ids = Array.from({ length: 10_000 }, () => randomUUID()), timestamp = new Date().toISOString();
  sql(db => {
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM messages WHERE conversation_id=?').run(long.id);
      db.prepare('UPDATE conversations SET title=?,updated_at=? WHERE id=?').run('10000 message performance fixture', timestamp, long.id);
      const insert = db.prepare('INSERT INTO messages(id,conversation_id,branch_id,parent_message_id,role,content,status,created_at) VALUES(?,?,?,?,?,?,?,?)');
      for (let index = 0; index < ids.length; index++) insert.run(ids[index], long.id, long.activeBranchId, index ? ids[index - 1] : null, index % 2 ? 'assistant' : 'user', 'Fixture line ' + index, 'complete', timestamp);
      db.prepare('INSERT INTO memories(id,conversation_id,character_id,type,content,scope,importance,status,pinned,source_message_ids_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), long.id, imported.roleId, 'fact', 'Earlier source outside recent window', 'story', 3, 'active', 0, JSON.stringify([ids[9880]]), timestamp);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  });
  await reload();
  await evaluate(`nav('故事');await wait(()=>document.querySelector('button[data-conversation-id="${long.id}"]'),'Real long story entry');document.querySelector('button[data-conversation-id="${long.id}"]').click();await wait(()=>core.getContext().conversationId===${JSON.stringify(long.id)}&&core.getContext().chat.length===10000&&document.querySelectorAll('#chat > .mes').length===100,'Full host chat and bounded real DOM');check(document.querySelector('#chat > .mes').getAttribute('mesid')==='9900','First absolute index');check(document.querySelector('#chat > .last_mes').getAttribute('mesid')==='9999','Last absolute index');`);
  const samples = [], warmup = [];
  for (let attempt = 0; attempt < 35; attempt++) {
    const started = globalThis.performance.now(); await reload();
    await evaluate(`await wait(()=>core.getContext().conversationId===${JSON.stringify(long.id)}&&core.getContext().chat.length===10000&&document.querySelectorAll('#chat > .mes').length===100&&!document.getElementById('send_textarea').disabled,'Cached full-story first interaction');`);
    const elapsed = globalThis.performance.now() - started; (attempt < 5 ? warmup : samples).push(elapsed);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  performance = { workload: 'actual cached app reload/resume with complete 10000-message host state and 100 visible message portals', hardware,
    warmupMs: warmup, samplesMs: samples, sampleCount: samples.length, p50Ms: sorted[14], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], maximumMs: sorted.at(-1), targetP95Ms: 2000 };
  assert(performance.p95Ms < 2000, 'Cached actual first interaction p95 ' + performance.p95Ms + ' ms exceeds 2000 ms');
  record('actual-10000-message-host-recent-100-dom-and-35-cached-reloads-performance', performance);
  await evaluate(`window.loadedPages=0;window.moreListener=()=>{window.loadedPages++};core.eventSource.on(core.event_types.MORE_MESSAGES_LOADED,window.moreListener);document.getElementById('show_more_messages').click();await wait(()=>document.querySelectorAll('#chat > .mes').length===200&&window.loadedPages===1,'Actual load-more and extension event');check(document.querySelector('#chat > .mes').getAttribute('mesid')==='9800','Older absolute indices');await core.printMessages();check(document.querySelectorAll('#chat > .mes').length===100,'Plugin print resets window');check(core.getContext().chat.length===10000,'Plugin API retains all messages');const last=document.querySelector('#chat > .last_mes');core.getContext().chat[9999].mes='PLUGIN_WINDOW_SWIPE';core.addOneMessage(core.getContext().chat[9999],{type:'swipe',forceId:9999,scroll:false});check(document.querySelector('#chat > .last_mes')===last,'Plugin swipe keeps actual same DOM node');check(last.querySelector('.mes_text').textContent==='PLUGIN_WINDOW_SWIPE','Plugin actual swipe contents');core.addOneMessage(core.getContext().chat[9880],{type:'swipe',forceId:9880,scroll:false});check(document.querySelector('#chat > .mes[mesid="9880"]'),'Explicit older plugin render supported');await core.saveChatConditional();core.eventSource.off(core.event_types.MORE_MESSAGES_LOADED,window.moreListener);await core.printMessages();check(document.querySelectorAll('#chat > .mes').length===100,'Full saved chat keeps default render window');`);
  assert.equal((await story(long.id)).messages.length, 10_000); assert.equal((await story(long.id)).messages.at(-1).content, 'PLUGIN_WINDOW_SWIPE');
  record('actual-load-more-event-print-absolute-index-plugin-add-swipe-and-full-persistence');
  await evaluate(`button('记忆').click();await wait(()=>document.querySelector('.memory-sources > summary'),'Actual memory source');document.querySelector('.memory-sources > summary').click();await wait(()=>button('跳到原始消息'),'Source read through actual UI');button('跳到原始消息').click();await wait(()=>document.querySelector('#chat > .mes[mesid="9880"]')?.classList.contains('chat-message--source'),'Source outside default window revealed');check(document.activeElement?.dataset.messageId===${JSON.stringify(ids[9880])},'Actual source focus');check(document.querySelectorAll('#chat > .mes').length===200,'Only needed earlier page expanded');`);
  record('actual-memory-source-navigation-expands-earlier-page-and-focuses-absolute-message');
  await restart();
  await evaluate(`nav('故事');await wait(()=>document.querySelector('button[data-conversation-id="${long.id}"]'),'Saved actual long story entry after new port');document.querySelector('button[data-conversation-id="${long.id}"]').click();await wait(()=>core.getContext().conversationId===${JSON.stringify(long.id)}&&core.getContext().chat.length===10000&&document.querySelectorAll('#chat > .mes').length===100,'Long story after full close/new port');check(core.getContext().chat[9999].mes==='PLUGIN_WINDOW_SWIPE','Saved plugin reply restored');document.querySelector('button[data-conversation-id="${imported.storyId}"]').click();await wait(()=>core.getContext().conversationId===${JSON.stringify(imported.storyId)}&&document.querySelector('.swipes-counter'),'Original swipes restored');check(core.getContext().chat[2].swipe_id===1&&core.getContext().chat[2].mes==='Imported alternate','Captured old target restored');check(core.getContext().chat[2].extra.navigationListener==='old-target','Listener unknown data restored');button('回复分支').click();await wait(()=>document.querySelector('select[aria-label="切换回复分支"]')?.options.length===2,'Separate native branches restored');`);
  record('actual-full-close-new-service-port-restores-swipes-branches-and-full-10000-message-state');
  writeFileSync(reportPath, JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), label, profile, stages, hardware, performance,
    sourceElectronOnly: true, completeG06: false, completeC01: false, boundaries: ['No final EXE evidence', 'No claim of all upstream animation/greeting/new-generation swipe parity', 'User-requested source reveal may expand multiple prior pages', 'Performance covers this hardware and own deterministic text dataset; fault/security gates remain separate'] }, null, 2), { flag: 'wx' });
  console.log('Report: ' + reportPath);
} catch (error) {
  let diagnostics; try { diagnostics = await window.webContents.executeJavaScript('({body:document.body.innerText,chat:window.replyWindows?.core.getContext().chat,buttons:[...document.querySelectorAll(".swipe-controls button")].map(item=>({text:item.textContent,disabled:item.disabled}))})'); } catch {}
  writeFileSync(reportPath, JSON.stringify({ passed: false, checkedAt: new Date().toISOString(), label, profile, stages, hardware, performance, error: error.stack || String(error), diagnostics }, null, 2), { flag: 'wx' }); console.error(error); process.exitCode = 1;
} finally {
  clearTimeout(deadline); for (const item of windows) if (!item.isDestroyed()) item.destroy(); await service?.close().catch(() => {}); await new Promise(resolve => provider.close(resolve)); app.exit(process.exitCode || 0);
} }
void verify();
