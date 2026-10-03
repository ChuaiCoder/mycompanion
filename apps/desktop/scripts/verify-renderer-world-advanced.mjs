// Project-owned fixtures exercise the real React editors, browser host, SQLite
// transactions and native HTTP provider requests in a private temporary profile.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { app, BrowserWindow } from 'electron';
import { newWorldInfoEntryTemplate } from '@mycompanion/shared';
import { bindBrowserPort, buildApp } from '../../local-service/dist/app.js';
import { installDesktopCloseGuard } from '../dist/desktop-close.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const profile = mkdtempSync(join(tmpdir(), 'mycompanion-world-advanced-'));
const databasePath = join(profile, 'profile.sqlite');
const label = process.argv.find(value => value.startsWith('--label='))?.slice(8) ?? new Date().toISOString().replace(/[^a-z0-9]/gi, '-');
assert(/^[a-z0-9-]{1,90}$/i.test(label));
const reportPath = join(root, '.cache/reports/renderer-world-advanced-' + label + '.json'); mkdirSync(dirname(reportPath), { recursive: true });
app.setPath('userData', profile); app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
const stages = [], windows = [], providerRequests = [];
let service, window, origin;
const provider = createServer(async (request, response) => {
  try {
    let text = ''; for await (const part of request) text += part;
    const body = JSON.parse(text || '{}'); providerRequests.push({ url: request.url, body });
    if (request.url?.endsWith('/embeddings')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: (Array.isArray(body.input) ? body.input : [body.input]).map((_value, index) => ({ index, embedding: [1, 0] })) })); return;
    }
    const reply = body.stream ? 'World advanced reply ' + providerRequests.length : 'OK';
    if (body.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    } else { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] })); }
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
const deadline = setTimeout(() => { writeFileSync(reportPath, JSON.stringify({ passed: false, checkedAt: new Date().toISOString(), label, profile, stages, error: 'World advanced verification deadline exceeded' }, null, 2), { flag: 'wx' }); app.exit(1); }, 150_000);
const stage = (name, evidence) => { stages.push({ name, ...(evidence ? { evidence } : {}) }); console.log('Passed: ' + name); };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
function sql(action) { const db = new DatabaseSync(databasePath); try { return action(db); } finally { db.close(); } }
async function harness() {
  const wait = async (predicate, label) => { const until = Date.now() + 9000; while (!await predicate()) { if (Date.now() > until) throw new Error('Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 20)); } };
  await wait(() => document.querySelector('.service-state--online') && window.__mycompanionFlushDrafts && document.querySelector('#form_create'), 'Connected actual application');
  const script = await import('/script.js'), compat = await import('/plugin-runtime/compat-runtime.js'), core = { ...script, getContext: compat.getContext };
  const host = await import('/plugin-runtime/desktop-host.js'); await host.start();
  const wi = await import('/plugin-runtime/world-info.js');
  const check = (value, label) => { if (!value) throw new Error(label); };
  const button = (name, container = document) => [...container.querySelectorAll('button')].find(item => item.textContent.trim() === name);
  const nav = name => [...document.querySelectorAll('nav button')].find(item => item.textContent.trim().startsWith(name)).click();
  const edit = (element, value) => { check(element, 'Required real editor field'); const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value); element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); };
  const choose = async (encoded, name, input) => { const transfer = new DataTransfer(); transfer.items.add(new File([Uint8Array.from(atob(encoded), value => value.charCodeAt(0))], name, { type: 'application/json' })); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(requestAnimationFrame); };
  const field = (uid, key) => document.querySelector('[data-world-info-entry="' + uid + '"] [data-world-info-field="' + key + '"]');
  const set = async (uid, key, value) => { const element = field(uid, key); check(element, 'Real field ' + uid + '/' + key); if (element.type === 'checkbox') { if (element.checked !== value) element.click(); } else if (element.multiple) { for (const option of element.options) option.selected = value.includes(option.value); element.dispatchEvent(new Event('change', { bubbles: true })); } else edit(element, value); await new Promise(requestAnimationFrame); };
  const setting = async (id, value) => { const element = document.getElementById(id); if (element.type === 'checkbox') { if (element.checked !== value) element.click(); } else edit(element, value); await new Promise(requestAnimationFrame); };
  const select = async name => { wi.selectWorldInfoEditor(name); await wait(() => document.querySelector('.world-info-dock h3')?.textContent.startsWith(name), 'Book ' + name); };
  const save = async () => { const buttonElement = button('保存世界书'); check(!buttonElement.disabled, 'Actual unsaved draft'); buttonElement.click(); await wait(() => buttonElement.disabled && !document.querySelector('.world-info-dock h3').textContent.includes('未保存'), 'World saved through real button'); };
  window.worldAdvanced = { core, host, wi, wait, check, button, nav, edit, choose, field, set, setting, select, save };
}
async function evaluate(body) {
  const result = await window.webContents.executeJavaScript(`(async()=>{try{const {core,host,wi,wait,check,button,nav,edit,choose,field,set,setting,select,save}=window.worldAdvanced;${body}}catch(error){return {__worldAdvancedError:error.stack||String(error)}}})()`);
  if (result?.__worldAdvancedError) throw new Error(result.__worldAdvancedError); return result;
}
async function start() { service = buildApp({ databasePath, rendererRoot: join(root, 'apps/renderer/dist') }); origin = await bindBrowserPort(port => service.listen({ host: '127.0.0.1', port })); }
async function open() { window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } }); windows.push(window); await window.loadURL(origin); await window.webContents.executeJavaScript(`(${harness.toString()})()`); }
async function restart() { const previous = origin, guard = installDesktopCloseGuard(window, { beforeClose: async () => {}, onError: error => { throw error; } }); assert.equal(await guard.requestClose(), true); await service.close(); await start(); assert.notEqual(origin, previous); await open(); }
const book = async name => (await service.inject({ method: 'POST', url: '/api/worldinfo/get', payload: { name } })).json();
const role = async id => (await service.inject({ method: 'GET', url: '/api/characters/' + id })).json();
const card = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Advanced world role', description: 'ROLE {{outlet::fixture}}', personality: '', scenario: '', first_mes: 'Opening', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: 'Project fixture', character_version: '1', extensions: { unknown: { kept: true } }, character_book: { name: 'Embedded source', extensions: { unknown: [null, false] }, entries: [
  { id: 12, keys: ['observatory'], content: 'COPIED_ACTIVE', constant: true, enabled: true, insertion_order: 100, extensions: { future: { kept: true } } },
  { id: 13, keys: ['observatory'], content: 'COPIED_DISABLED', constant: true, enabled: true, insertion_order: 90, extensions: {} },
] } } };
const entry = (uid, content, changes = {}) => ({ ...structuredClone(newWorldInfoEntryTemplate), uid, comment: 'Entry ' + uid, content, disable: true, ...changes, future: { nested: [null, { preserved: uid }] } });
async function importBook(name, document) { await evaluate(`edit(document.querySelector('input[aria-label="新世界书名称"]'),${JSON.stringify(name)});await choose(${JSON.stringify(encode(document))},${JSON.stringify(name + '.json')},document.querySelector('input[aria-label="导入世界书 JSON"]'));await wait(()=>document.querySelector('.world-info-dock h3')?.textContent===${JSON.stringify(name)},'JSON world imported and opened');`); }
async function send(content) {
  const count = providerRequests.length;
  await evaluate(`nav('故事');const previous=core.getContext().chat.at(-1)?.id;edit(document.getElementById('send_textarea'),${JSON.stringify(content)});document.getElementById('send_but').click();await wait(()=>core.getContext().chat.at(-1)?.id!==previous&&core.getContext().chat.at(-1)?.mes.startsWith('World advanced reply ')&&!core.getContext().isGenerating&&document.getElementById('send_textarea').value==='','Actual generation completes');`);
  const candidates = providerRequests.slice(count).filter(request => request.body.stream === true); assert.equal(candidates.length, 1, 'One actual foreground provider request'); return candidates[0].body;
}
const text = request => JSON.stringify(request.messages);
async function verify() { try {
  await app.whenReady(); await start(); await open();
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const configured = await service.inject({ method: 'PUT', url: '/api/settings/provider', payload: { kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, model: 'world-fixture', clearApiKey: true, temperature: 0, maxTokens: 64, contextLimitTokens: 8192 } }); assert.equal(configured.statusCode, 200, configured.body);
  await evaluate(`await choose(${JSON.stringify(encode(card))},'embedded-world.json',document.querySelector('input[aria-label="选择角色卡文件"]'));await wait(()=>button('确认导入'),'Actual card preview');button('确认导入').click();await wait(()=>button('编辑角色'),'Actual imported role');button('编辑角色').click();await wait(()=>core.getCurrentChatId()&&document.querySelector('#form_create [name=avatar_url]').value,'Actual role editor and story');edit(document.querySelector('#form_create [name=description]'),'UNSAVED_ROLE_DRAFT');nav('角色库');await new Promise(requestAnimationFrame);document.getElementById('world_button').click();await wait(()=>document.querySelector('.lorebook-entry-list li button'),'Actual embedded switches');document.querySelector('.lorebook-entry-list li button').click();await wait(()=>document.querySelector('.lorebook-entry-list li button').textContent==='停用','Actual one embedded entry enabled');`);
  const fixture = await evaluate(`const context=core.getContext();return {storyId:context.conversationId,roleId:context.characterUuid,avatar:context.characters[context.characterId].avatar};`);
  stage('actual-json-card-import-and-one-effective-embedded-switch');
  await importBook('Holding draft', { entries: { 0: entry(0, 'SAVED_HOLDING') } });
  await evaluate(`await set(0,'content','UNSAVED_NAMED_DRAFT');document.querySelector('[data-edit-character-world-info]').click();await wait(()=>document.querySelector('dialog[open] .popup-input'),'Actual copy naming dialog');document.querySelector('dialog[open] .popup-button-cancel').click();await wait(()=>!document.querySelector('dialog[open]'),'Cancel closed');check(field(0,'content').value==='UNSAVED_NAMED_DRAFT','Cancel preserves current named draft');check(document.querySelector('#form_create [name=description]').value==='UNSAVED_ROLE_DRAFT','Cancel preserves real role draft');`);
  assert.equal((await role(fixture.roleId)).rawExtensions.world, undefined);
  assert.deepEqual((await service.inject({ method: 'GET', url: '/api/worldinfo/list' })).json().world_names, ['Holding draft']);
  stage('real-copy-dialog-cancel-writes-nothing-and-preserves-both-editor-drafts');
  const before = await role(fixture.roleId);
  sql(db => db.exec("CREATE TRIGGER fail_world_bind BEFORE UPDATE ON characters BEGIN SELECT RAISE(ABORT, 'fixture bind failure'); END;"));
  await evaluate(`document.querySelector('[data-edit-character-world-info]').click();await wait(()=>document.querySelector('dialog[open] .popup-input'),'Retry actual naming dialog');edit(document.querySelector('dialog[open] .popup-input'),'Role book');document.querySelector('dialog[open] .popup-button-ok').click();await wait(()=>document.querySelector('.world-info-dock [role=alert]')?.textContent.includes('原角色与条目未修改'),'Real SQL failure surfaced');check(field(0,'content').value==='UNSAVED_NAMED_DRAFT','SQL failure preserves current world draft');check(document.querySelector('#form_create [name=description]').value==='UNSAVED_ROLE_DRAFT','SQL failure preserves role draft');`);
  assert.deepEqual(await role(fixture.roleId), before); assert.equal((await service.inject({ method: 'POST', url: '/api/worldinfo/get', payload: { name: 'Role book' } })).statusCode, 404);
  sql(db => db.exec('DROP TRIGGER fail_world_bind'));
  stage('actual-sql-binding-failure-rolls-back-copy-and-all-runtime-switches');
  await evaluate(`document.querySelector('[data-edit-character-world-info]').click();await wait(()=>document.querySelector('dialog[open] .popup-input'),'Actual copy retry');edit(document.querySelector('dialog[open] .popup-input'),'Role book');document.querySelector('dialog[open] .popup-button-ok').click();await wait(()=>document.querySelector('.world-info-dock h3')?.textContent==='Role book','Successful copy bound and selected');check(document.querySelector('#form_create [name=description]').value==='UNSAVED_ROLE_DRAFT','Successful copy merges without losing role draft');await wait(()=>document.querySelector('[aria-label="角色世界书绑定"]'),'Original switches replaced with actual named binding');`);
  const copied = await book('Role book'); assert.equal(copied.entries[12].disable, false); assert.equal(copied.entries[13].disable, true); assert.deepEqual(copied.originalData, card.data.character_book);
  const after = await role(fixture.roleId);
  await evaluate(`document.querySelector('[data-edit-character-world-info]').click();await wait(()=>!document.querySelector('[data-edit-character-world-info]').disabled,'Open actual existing primary');check(!document.querySelector('dialog[open]'),'Existing primary opens directly');`);
  assert.equal((await role(fixture.roleId)).updatedAt, after.updatedAt);
  const copiedRequest = await send('observatory ARCHIVED_QUERY'); assert.equal(text(copiedRequest).match(/COPIED_ACTIVE/g)?.length, 1); assert(!text(copiedRequest).includes('COPIED_DISABLED'));
  stage('successful-copy-keeps-original-effective-switches-and-injects-only-named-source-once', { request: copiedRequest });
  await evaluate(`await select('Role book');await set(12,'enabled',false);await save();`);
  const advanced = { entries: {
    0: entry(0, 'ADV_PRIMARY', { key: ['moon'] }), 1: entry(1, 'GROUP_PRIORITY', { key: ['moon'] }),
    2: entry(2, 'GROUP_SCORING', { key: ['moon', 'coast', 'ship'] }), 3: entry(3, 'FILTER_BLOCK', { constant: true, characterFilter: { names: [], isExclude: false, future: { kept: true } } }),
    4: entry(4, 'NORMAL_ONLY', { constant: true }), 5: entry(5, 'QUIET_ONLY', { constant: true }),
    6: entry(6, 'OUTLET_SIGNAL', { constant: true }), 7: entry(7, 'MIN_DEPTH_SIGNAL', { key: ['ARCHIVED_QUERY'] }),
    8: entry(8, 'TIMED_SIGNAL', { key: ['timerkey'] }), 9: entry(9, 'DELAY_SIGNAL', { constant: true }),
  }, custom: { nested: [false, null, { retained: true }] } };
  await importBook('Advanced global', advanced);
  await evaluate(`for(let uid=0;uid<=6;uid++)await set(uid,'enabled',true);await set(0,'keysecondary','coast\\nship');await set(0,'selective',true);await set(0,'selectiveLogic','3');await set(0,'position','4');await set(0,'depth','0');await set(0,'role','1');await set(0,'scanDepth','1');await set(0,'caseSensitive','yes');await set(0,'matchWholeWords','yes');await set(0,'useProbability',true);await set(0,'probability','100');await set(0,'ignoreBudget',true);await set(0,'preventRecursion',true);await set(0,'triggers',['normal']);await set(1,'group','fixture-group');await set(1,'groupOverride',true);await set(1,'groupWeight','0');await set(2,'group','fixture-group');await set(2,'groupWeight','100');await set(2,'useGroupScoring','yes');await set(3,'characterFilter.names',${JSON.stringify(fixture.avatar.replace(/\.png$/i, ''))});await set(3,'characterFilter.isExclude',true);await set(4,'triggers',['normal']);await set(5,'triggers',['quiet']);await set(6,'position','7');await set(6,'outletName','fixture');await setting('world_info_depth','1');await setting('world_info_use_group_scoring',false);const worlds=document.getElementById('world_info');for(const option of worlds.options)option.selected=option.textContent==='Advanced global';worlds.dispatchEvent(new Event('change',{bubbles:true}));await new Promise(requestAnimationFrame);`);
  assert.deepEqual(await book('Advanced global'), advanced);
  await restart();
  await evaluate(`nav('故事');await wait(()=>document.querySelector('button[data-conversation-id="${fixture.storyId}"]'),'Actual saved story list');document.querySelector('button[data-conversation-id="${fixture.storyId}"]').click();await wait(()=>core.getCurrentChatId()===${JSON.stringify(fixture.storyId)},'Actual reopened story');await select('Advanced global');check(field(0,'keysecondary').value==='coast\\nship'&&field(6,'outletName').value==='fixture','Unsaved advanced draft restored after new port');check(document.querySelector('#form_create [name=description]').value==='UNSAVED_ROLE_DRAFT','Role draft restored after new port');await save();`);
  const saved = await book('Advanced global'); assert.deepEqual(saved.custom, advanced.custom); assert.deepEqual(saved.entries[0].future, advanced.entries[0].future); assert.deepEqual(saved.entries[3].characterFilter.future, { kept: true });
  stage('all-advanced-controls-and-unknown-data-survive-unsaved-close-new-port-and-real-save');
  // Fixed ST expands first-card fields before WI scanning. Consume fresh outlets
  // through the real post-scan extension prompt, without re-running card macros.
  await evaluate(`(await import('/plugin-runtime/compat-runtime.js')).setExtensionPrompt('u04-outlet-consumer','OUTLET_POST {{outlet::fixture}}',0,0,false,0);`);
  const normal = await send('moon coast ship');
  for (const signal of ['ADV_PRIMARY', 'GROUP_PRIORITY', 'NORMAL_ONLY', 'OUTLET_SIGNAL']) assert(text(normal).includes(signal), signal + ' reaches actual request');
  for (const signal of ['GROUP_SCORING', 'FILTER_BLOCK', 'QUIET_ONLY']) assert(!text(normal).includes(signal), signal + ' excluded from actual request');
  assert(normal.messages.some(message => message.role === 'user' && message.content.includes('ADV_PRIMARY')), 'Depth 0 user identity');
  assert(normal.messages.some(message => message.content === 'ROLE '), 'First-card description keeps pinned pre-scan outlet stage');
  assert(normal.messages.some(message => message.content.includes('OUTLET_POST OUTLET_SIGNAL')), 'Fresh outlet consumed by real post-scan extension prompt');
  stage('actual-normal-request-consumes-secondary-all-depth-role-priority-filter-trigger-and-outlet', { request: normal });
  const quietBefore = providerRequests.length;
  const quiet = await evaluate(`const before=core.getContext().chat.length;const result=await core.generateQuietPrompt({quietPrompt:'Quiet request'});check(result==='OK'||result.startsWith('World advanced reply '),'Actual quiet model response');check(core.getContext().chat.length===before,'Quiet does not append messages');return result;`);
  const quietBody = providerRequests.slice(quietBefore).find(request => text(request.body).includes('Quiet request'))?.body; assert(quietBody, quiet);
  assert(text(quietBody).includes('QUIET_ONLY')); assert(!text(quietBody).includes('NORMAL_ONLY')); assert(!text(quietBody).includes('ADV_PRIMARY'));
  stage('actual-quiet-request-obeys-generation-triggers-without-appending-story-messages', { request: quietBody });
  await evaluate(`await select('Advanced global');await set(1,'groupOverride',false);await setting('world_info_use_group_scoring',true);await save();`);
  const scored = await send('moon coast ship'); assert(text(scored).includes('GROUP_SCORING')); assert(!text(scored).includes('GROUP_PRIORITY'));
  stage('actual-group-score-and-weight-selection-changes-after-real-editor-save', { request: scored });
  await evaluate(`await select('Advanced global');for(let uid=0;uid<=6;uid++)await set(uid,'enabled',false);await set(7,'enabled',true);await setting('world_info_min_activations','1');await setting('world_info_min_activations_depth_max','1');await save();`);
  const capped = await send('No older keyword in this turn'); assert(!text(capped).includes('MIN_DEPTH_SIGNAL'));
  await evaluate(`await setting('world_info_min_activations_depth_max','0');`);
  const expanded = await send('Another unrelated turn'); assert(text(expanded).includes('MIN_DEPTH_SIGNAL'));
  stage('global-minimum-activation-depth-cap-controls-real-older-message-retrieval', { capped, expanded });
  const startLength = await evaluate(`await select('Advanced global');await set(7,'enabled',false);await set(8,'enabled',true);await set(8,'scanDepth','1');await set(8,'sticky','3');await set(8,'cooldown','2');await set(9,'enabled',true);await set(9,'delay',String(core.getContext().chat.length+3));await setting('world_info_min_activations','0');await save();return core.getContext().chat.length;`);
  const first = await send('timerkey'); assert(text(first).includes('TIMED_SIGNAL')); assert(!text(first).includes('DELAY_SIGNAL'));
  const sticky = await send('No timer keyword now'); assert(text(sticky).includes('TIMED_SIGNAL')); assert(text(sticky).includes('DELAY_SIGNAL'));
  const cooled = await send('timerkey'); assert(!text(cooled).includes('TIMED_SIGNAL'));
  const renewed = await send('timerkey'); assert(text(renewed).includes('TIMED_SIGNAL'));
  const durable = await role(fixture.roleId); assert.equal(durable.rawExtensions.world, 'Role book');
  const timedStory = (await service.inject({ method: 'GET', url: '/api/conversations/' + fixture.storyId })).json(); assert(timedStory.chatMetadata.timedWorldInfo?.sticky);
  stage('actual-consecutive-generations-consume-sticky-cooldown-and-delay-with-durable-timers', { startLength, first, sticky, cooled, renewed, metadata: timedStory.chatMetadata });
  const finalBook = await book('Advanced global'), settings = (await service.inject({ method: 'GET', url: '/api/worldinfo/settings' })).json();
  await restart();
  assert.deepEqual(await book('Advanced global'), finalBook); assert.deepEqual((await service.inject({ method: 'GET', url: '/api/worldinfo/settings' })).json(), settings);
  await evaluate(`nav('故事');await wait(()=>document.querySelector('button[data-conversation-id="${fixture.storyId}"]'),'Final restarted story list');document.querySelector('button[data-conversation-id="${fixture.storyId}"]').click();await wait(()=>core.getCurrentChatId()===${JSON.stringify(fixture.storyId)},'Actual reopened final story');await select('Advanced global');check(field(8,'sticky').value==='3'&&field(8,'cooldown').value==='2','Saved timer editor fields survive');await select('Holding draft');check(field(0,'content').value==='UNSAVED_NAMED_DRAFT','Other named draft survives all failed/successful copy and restarts');check(document.querySelector('#form_create [name=description]').value==='UNSAVED_ROLE_DRAFT','Role draft survives all requests and restarts');`);
  stage('final-real-close-new-port-restart-preserves-bindings-all-fields-settings-timers-and-independent-drafts');
  // Subsequent supported-field tranche: original Quick Reply automation runs
  // inside the native WI acceptance boundary, before post-scan prompts expand.
  await importBook('Automation global', { entries: { 0: entry(0, 'AUTOMATION_SIGNAL', { constant: true, disable: false }) } });
  await evaluate(`await set(0,'automationId','u04-automation');await save();const worlds=document.getElementById('world_info');for(const option of worlds.options)option.selected=option.textContent==='Automation global';worlds.dispatchEvent(new Event('change',{bubbles:true}));await new Promise(requestAnimationFrame);`);
  assert.equal((await book('Automation global')).entries[0].automationId, 'u04-automation');
  const qrSaved = await service.inject({ method: 'POST', url: '/api/quick-replies/save', payload: { version: 2, name: 'U04 Automation', qrList: [{ id: 1, label: 'Count', automationId: 'u04-automation', message: '/incvar u04QrCount | /incglobalvar u04QrCount' }] } }); assert.equal(qrSaved.statusCode, 200, qrSaved.body);
  await evaluate(`const settings=await import('/plugin-runtime/settings.js');settings.extension_settings.quickReplyV2={isEnabled:true,config:{setList:[{set:'U04 Automation'}]}};await settings.saveSettings();await (await import('/plugin-runtime/quick-reply.js')).loadQuickReplies();(await import('/plugin-runtime/compat-runtime.js')).setExtensionPrompt('u04-qr-consumer','QR_AFTER {{getvar::u04QrCount}}/{{getglobalvar::u04QrCount}}',0,0,false,0);`);
  const automated = await send('Automation foreground'); assert(text(automated).includes('QR_AFTER 1/1'));
  const automatedStory = (await service.inject({ method: 'GET', url: '/api/conversations/' + fixture.storyId })).json();
  assert.equal(automatedStory.chatMetadata.variables.u04QrCount, 1);
  assert.equal((await service.inject({ method: 'GET', url: '/api/extensions/settings' })).json().extensionSettings.variables.global.u04QrCount, 1);
  stage('actual-automation-id-editor-and-original-quick-reply-run-once-before-foreground-postscan-prompt', { request: automated });
  const automationQuietBefore = providerRequests.length;
  await evaluate(`const before=core.getContext().chat.length;await core.generateQuietPrompt({quietPrompt:'Quiet automation request'});check(core.getContext().chat.length===before,'Automation quiet does not append messages');`);
  const automationQuiet = providerRequests.slice(automationQuietBefore).find(request => text(request.body).includes('Quiet automation request'))?.body;
  assert(automationQuiet && text(automationQuiet).includes('QR_AFTER 2/2'));
  stage('actual-quiet-world-automation-runs-once-and-postscan-consumes-accepted-local-global-counts', { request: automationQuiet });
  await evaluate(`nav('故事');edit(document.getElementById('send_textarea'),'Preview automation');const preview=document.querySelector('.prompt-preview');if(!preview.open)preview.querySelector('summary').click();await wait(()=>preview.querySelector('.prompt-preview__body'),'Actual preview response');for(const summary of preview.querySelectorAll('.prompt-preview__message > summary'))summary.click();await wait(()=>preview.textContent.includes('QR_AFTER 2/2'),'Real preview displays unchanged counts');check(core.getContext().chatMetadata.variables.u04QrCount===2,'Preview does not execute Quick Reply');`);
  assert.equal((await service.inject({ method: 'GET', url: '/api/extensions/settings' })).json().extensionSettings.variables.global.u04QrCount, 2);
  await restart();
  await evaluate(`nav('故事');await wait(()=>document.querySelector('button[data-conversation-id="${fixture.storyId}"]'),'Automation story after actual restart');document.querySelector('button[data-conversation-id="${fixture.storyId}"]').click();await wait(()=>core.getCurrentChatId()===${JSON.stringify(fixture.storyId)},'Automation story opened');await select('Automation global');check(field(0,'automationId').value==='u04-automation','Actual automation field restored');check(core.getContext().chatMetadata.variables.u04QrCount===2,'Accepted local count restored');const settings=await import('/plugin-runtime/settings.js');check(settings.extension_settings.variables.global.u04QrCount===2,'Accepted global count restored');await select('Holding draft');check(field(0,'content').value==='UNSAVED_NAMED_DRAFT','Other book draft remains');`);
  stage('actual-preview-does-not-run-automation-and-full-close-new-port-restores-field-and-accepted-variables');
  const embedding = await service.inject({ method: 'POST', url: '/api/settings/providers', payload: { name: 'World vector embedding', settings: { kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, model: 'world-vector-embedding', clearApiKey: true, temperature: 0, maxTokens: 64, contextLimitTokens: 8192 } } }); assert.equal(embedding.statusCode, 201, embedding.body);
  const assigned = await service.inject({ method: 'PATCH', url: '/api/settings/provider-tasks', payload: { embedding: embedding.json().id } }); assert.equal(assigned.statusCode, 200, assigned.body);
  await importBook('Vector global', { entries: { 0: entry(0, 'VECTORIZED_SIGNAL', { key: ['never_keyword_fixture'], disable: false }), 1: entry(1, 'VECTOR_ALL_SIGNAL', { key: ['never_keyword_fixture'], disable: false }) } });
  await evaluate(`await set(0,'vectorized',true);await save();const worlds=document.getElementById('world_info');for(const option of worlds.options)option.selected=option.textContent==='Vector global';worlds.dispatchEvent(new Event('change',{bubbles:true}));await new Promise(requestAnimationFrame);const settings=await import('/plugin-runtime/settings.js');settings.extension_settings.vectors={...settings.extension_settings.vectors,futureVector:{retained:true}};await settings.saveSettings();const details=document.querySelector('.world-info-vectors');if(!details.open)details.querySelector('summary').click();window.vectorSetting=async(key,value)=>{const input=document.querySelector('[data-vector-setting="'+key+'"]');await wait(()=>!input.matches(':disabled'),'Actual ready vector field');if(input.type==='checkbox'){if(input.checked!==value)input.click();}else edit(input,String(value));await new Promise(requestAnimationFrame);await wait(()=>!input.matches(':disabled'),'Actual saved vector field');};await window.vectorSetting('query',1);await window.vectorSetting('max_entries',2);await window.vectorSetting('score_threshold',.95);await window.vectorSetting('enabled_for_all',false);await window.vectorSetting('enabled_world_info',true);`);
  const vectorSettings = (await service.inject({ method: 'GET', url: '/api/extensions/settings' })).json().extensionSettings.vectors;
  assert.deepEqual(vectorSettings.futureVector, { retained: true }); assert.equal(vectorSettings.enabled_world_info, true); assert.equal(vectorSettings.enabled_for_all, undefined); assert.equal(vectorSettings.query, 1); assert.equal(vectorSettings.max_entries, 2); assert.equal(vectorSettings.score_threshold, .95);
  const vectorBefore = providerRequests.length, vectorOnly = await send('A semantically similar background without the fixture keyword');
  assert(text(vectorOnly).includes('VECTORIZED_SIGNAL')); assert(!text(vectorOnly).includes('VECTOR_ALL_SIGNAL'));
  const actualEmbedding = providerRequests.slice(vectorBefore).filter(request => request.url?.endsWith('/embeddings')); assert(actualEmbedding.length); assert(actualEmbedding.every(request => request.body.model === 'world-vector-embedding'));
  stage('actual-vectorized-entry-and-five-vector-settings-save-unknowns-and-consume-assigned-external-embedding', { settings: vectorSettings, embeddings: actualEmbedding, request: vectorOnly });
  await evaluate(`await window.vectorSetting('enabled_for_all',true);`);
  const vectorAll = await send('Second semantic vector query without keywords'); assert(text(vectorAll).includes('VECTORIZED_SIGNAL')); assert(text(vectorAll).includes('VECTOR_ALL_SIGNAL'));
  stage('actual-enable-for-all-control-activates-non-vectorized-entry-through-original-global-vector-selection', { request: vectorAll });
  await evaluate(`await window.vectorSetting('enabled_world_info',false);`);
  const disabledBefore = providerRequests.length, vectorDisabled = await send('Third semantic query with vector matching disabled'); assert(!text(vectorDisabled).includes('VECTORIZED_SIGNAL')); assert(!text(vectorDisabled).includes('VECTOR_ALL_SIGNAL')); assert(!providerRequests.slice(disabledBefore).some(request => request.url?.endsWith('/embeddings')));
  stage('actual-disable-vector-control-keeps-keyword-chat-running-without-embedding-or-vector-injection', { request: vectorDisabled });
  await restart();
  await evaluate(`nav('故事');await wait(()=>document.querySelector('button[data-conversation-id="${fixture.storyId}"]'),'Vector story after actual restart');document.querySelector('button[data-conversation-id="${fixture.storyId}"]').click();await wait(()=>core.getCurrentChatId()===${JSON.stringify(fixture.storyId)},'Actual vector story opened');await select('Vector global');check(field(0,'vectorized').checked&&!field(1,'vectorized').checked,'Actual per-entry vector fields restored');await wait(()=>!document.querySelector('[data-vector-setting="enabled_world_info"]').matches(':disabled'),'Actual vector settings ready');for(const [key,value]of Object.entries({query:'1',max_entries:'2',score_threshold:'0.95'}))check(document.querySelector('[data-vector-setting="'+key+'"]').value===value,'Actual restored vector '+key);check(!document.querySelector('[data-vector-setting="enabled_world_info"]').checked&&document.querySelector('[data-vector-setting="enabled_for_all"]').checked,'Actual vector switches restored');await select('Holding draft');check(field(0,'content').value==='UNSAVED_NAMED_DRAFT','Independent named draft survives vector setup');`);
  const restoredVectors = (await service.inject({ method: 'GET', url: '/api/extensions/settings' })).json().extensionSettings.vectors; assert.deepEqual(restoredVectors.futureVector, { retained: true });
  assert.equal((await service.inject({ method: 'GET', url: '/api/settings/providers' })).json().tasks.embedding, embedding.json().id);
  stage('actual-close-new-port-restores-vector-fields-settings-unknowns-task-assignment-and-independent-draft');
  await writeFile(reportPath, JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), label, profile, stages, providerRequestCount: providerRequests.length, completeU04: false, completeC01: false }, null, 2), { flag: 'wx' }); console.log(JSON.stringify({ passed: true, stages: stages.length, reportPath }));
} catch (error) {
  let diagnostics; try { diagnostics = await window.webContents.executeJavaScript('document.body.innerText'); } catch {}
  await writeFile(reportPath, JSON.stringify({ passed: false, checkedAt: new Date().toISOString(), label, profile, stages, error: error.stack || String(error), diagnostics, providerRequests }, null, 2), { flag: 'wx' }); console.error(error); process.exitCode = 1;
} finally { clearTimeout(deadline); for (const item of windows) if (!item.isDestroyed()) item.destroy(); await service?.close(); await new Promise(resolve => provider.close(resolve)); app.exit(process.exitCode || 0); } }
void verify();
