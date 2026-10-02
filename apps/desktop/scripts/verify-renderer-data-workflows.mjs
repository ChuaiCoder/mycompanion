// Project-authored desktop checks against temporary profiles and the real React
// interface, runtime modules, SQLite service and native download events.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { app, BrowserWindow } from 'electron';
import { bindBrowserPort, buildApp } from '../../local-service/dist/app.js';
import { RuntimeRepository } from '../../local-service/dist/runtime-repository.js';
import { installDesktopCloseGuard } from '../dist/desktop-close.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const profile = mkdtempSync(join(tmpdir(), 'mycompanion-data-workflows-'));
const runLabel = process.argv.find(value => value.startsWith('--label='))?.slice(8) ?? new Date().toISOString().replace(/[^a-z0-9]/gi, '-');
if (!/^[a-z0-9-]{1,90}$/i.test(runLabel)) throw new Error('Verification label must contain only letters, numbers and hyphens');
const databasePath = join(profile, 'test.sqlite'), reportPath = join(root, '.cache/reports/renderer-data-workflows-' + runLabel + '.json');
mkdirSync(dirname(reportPath), { recursive: true });
app.setPath('userData', profile); app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const stages = [], downloads = [], windows = [];
let service, window, origin;
let failedBatchCommit = false;
const providerRequests = [];
const providerServer = createServer(async (request, response) => {
  let content = ''; for await (const part of request) content += part;
  const body = content ? JSON.parse(content) : {}; providerRequests.push({ url: request.url, body });
  if (body.model === 'model-missing') { response.writeHead(404, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'model not found' } })); return; }
  if (body.stream) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Beginner actual first reply' } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  } else { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] })); }
});
const deadline = setTimeout(() => { console.error('Desktop data workflows timed out'); app.exit(1); }, 90_000);

async function harness() {
  const core = await import('/script.js');
  const wi = await import('/plugin-runtime/world-info.js');
  const host = await import('/plugin-runtime/desktop-host.js');
  const wait = async (predicate, label) => { const end = Date.now() + 8000; while (!await predicate()) { if (Date.now() > end) throw new Error('Wait timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 15)); } };
  const check = (value, label) => { if (!value) throw new Error(label); };
  const buttons = (container = document) => [...container.querySelectorAll('button')];
  const button = (text, container) => buttons(container).find(item => item.textContent.trim() === text);
  const nav = text => [...document.querySelectorAll('nav button')].find(item => item.textContent.trim().startsWith(text)).click();
  const field = name => document.querySelector('#form_create').elements.namedItem(name);
  const edit = (element, value) => { Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set.call(element, value); element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); };
  const content = () => document.querySelector('.world-info-dock fieldset label:last-of-type textarea');
  const selectWorld = async name => { wi.selectWorldInfoEditor(name); await wait(() => document.querySelector('.world-info-dock h3')?.textContent.startsWith(name), name); };
  const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await wait(() => typeof window.__mycompanionFlushDrafts === 'function' && document.querySelector('#form_create') && document.querySelector('.service-state--online'), 'mounted app and connected service');
  await host.start();
  window.dataFixture = { core, wi, wait, check, button, nav, field, edit, content, selectWorld, post };
}
async function execute(body) { return window.webContents.executeJavaScript(`(async () => { const { core, wi, wait, check, button, nav, field, edit, content, selectWorld, post } = window.dataFixture; ${body} })()`); }
async function ready() {
  const end = Date.now() + 12_000;
  while (Date.now() < end) { try { await window.webContents.executeJavaScript(`(${harness.toString()})()`); return; } catch (error) { if (Date.now() + 50 >= end) throw error; await new Promise(resolve => setTimeout(resolve, 30)); } }
}
async function startService() {
  service = buildApp({ databasePath, rendererRoot: join(root, 'apps/renderer/dist') });
  service.addHook('preHandler', async (request, reply) => {
    if (request.url.startsWith('/api/characters/import/commit') && request.body?.card?.data?.name === 'Batch retry fixture' && !failedBatchCommit) {
      failedBatchCommit = true; return reply.code(503).send({ error: { code: 'FIXTURE_FAILURE', message: 'Temporary batch save failure' } });
    }
  });
  origin = await bindBrowserPort(port => service.listen({ host: '127.0.0.1', port }));
}
async function openWindow() {
  window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } }); windows.push(window);
  if (windows.length === 1) window.webContents.session.on('will-download', (_event, item) => {
    const path = join(profile, downloads.length + '-' + item.getFilename());
    item.setSavePath(path); const result = { fileName: item.getFilename(), path }; downloads.push(result);
    item.once('done', (_done, state) => { result.state = state; });
  });
  await window.loadURL(origin); await ready();
}
async function reload() { window.reload(); await new Promise(resolve => setTimeout(resolve, 50)); await ready(); }
async function download(body) {
  const count = downloads.length; await execute(body);
  const end = Date.now() + 8000;
  while (downloads.length === count || !downloads[count].state) { if (Date.now() > end) throw new Error('Native download timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal(downloads[count].state, 'completed'); return downloads[count];
}
function repository(action) { const db = new DatabaseSync(databasePath); try { return action(new RuntimeRepository(db)); } finally { db.close(); } }

async function verify() {
  try {
    await app.whenReady(); await startService();
    repository(runtime => {
      const manifest = { display_name: 'Draft reload fixture', js: 'index.js', loading_order: 0 };
      const files = new Map([['manifest.json', Buffer.from(JSON.stringify(manifest))], ['index.js', Buffer.from('document.body.dataset.draftReloadFixture="loaded";')]]);
      runtime.installCodePlugin({ manifest, files, plugin: { id: 'draft-reload-fixture', kind: 'sillytavern-js', displayName: manifest.display_name, version: '1', author: 'MyCompanion', license: 'AGPL-3.0-only', js: 'index.js', css: null, warnings: [], fileCount: files.size, totalBytes: [...files.values()].reduce((sum, file) => sum + file.length, 0) } });
      runtime.setCodePluginEnabled('draft-reload-fixture', false);
    });
    await openWindow();
    const fixture = await execute(`
      const data = new FormData(); data.set('ch_name', 'Data workflow character'); data.set('first_mes', 'Original greeting');
      const response = await fetch('/api/characters/create', { method: 'POST', body: data }); check(response.ok, 'Create role'); const avatar = await response.text();
      await core.getCharacters(); nav('角色库');
      await wait(() => [...document.querySelectorAll('.character-row')].some(item => item.textContent.includes('Data workflow character')), 'role list');
      [...document.querySelectorAll('.character-row')].find(item => item.textContent.includes('Data workflow character')).click();
      await wait(() => button('编辑角色'), 'role detail'); button('编辑角色').click();
      await wait(() => !field('avatar_url').closest('aside').hidden && field('avatar_url').value === avatar && core.getCurrentChatId(), 'visible role editor and story');
      $('#form_create [name=description]').val('Unsubmitted role draft').trigger('input');
      const files = new DataTransfer(), png = await fetch('/characters/' + encodeURIComponent(avatar)).then(result => result.blob());
      files.items.add(new File([png], 'unsubmitted-draft.png', { type: 'image/png' })); field('avatar').files = files.files; $(field('avatar')).trigger('change');
      for (const name of ['data-book-a', 'data-book-b']) { await wi.createNewWorldInfo(name); await wi.saveWorldInfo(name, { entries: { 0: { ...structuredClone(wi.newWorldInfoEntryTemplate), uid: 0, content: 'Saved ' + name } } }, true); }
      nav('角色库'); await wait(() => document.querySelector('#world_button'), 'world editor button');
      document.querySelector('#world_button').click(); await selectWorld('data-book-a'); edit(content(), 'Unsubmitted world A');
      await selectWorld('data-book-b'); edit(content(), 'Unsubmitted world B'); await selectWorld('data-book-a');
      check(content().value === 'Unsubmitted world A', 'Switch must restore A');
      check((await post('/api/worldinfo/get', { name: 'data-book-a' }).then(result => result.json())).entries[0].content === 'Saved data-book-a', 'Draft must not save original world');
      return { avatar, characterId: core.characters[core.this_chid].id, storyId: core.getCurrentChatId() };
    `);
    stages.push('actual-world-editor-switch-preserves-two-unsubmitted-drafts');
    await execute(`nav('插件'); await wait(() => document.querySelector('.code-plugin-list li'), 'plugin row'); button('启用', document.querySelector('.code-plugin-list li')).click();`);
    await new Promise(resolve => setTimeout(resolve, 150)); await ready();
    await execute(`
      await wait(() => document.body.dataset.draftReloadFixture === 'loaded' && field('avatar_url').value === ${JSON.stringify(fixture.avatar)}, 'plugin reload and role restoration');
      check(field('description').value === 'Unsubmitted role draft' && field('avatar').files[0]?.name === 'unsubmitted-draft.png', 'Plugin reload keeps role text and PNG');
      await selectWorld('data-book-a'); check(content().value === 'Unsubmitted world A', 'Plugin reload keeps world A');
      await selectWorld('data-book-b'); check(content().value === 'Unsubmitted world B', 'Plugin reload keeps world B');
      check((await post('/api/characters/get', { avatar_url: ${JSON.stringify(fixture.avatar)} }).then(result => result.json())).description === '', 'Role remains unsubmitted');
    `);
    stages.push('real-plugin-enable-reload-restores-role-png-and-world-drafts-without-submitting');

    const source = repository(runtime => {
      const message = runtime.addMessage(fixture.storyId, 'user', 'Original source from previous branch');
      runtime.addMemory({ id: randomUUID(), conversationId: fixture.storyId, characterId: fixture.characterId, type: 'fact', scope: 'story', content: 'Source navigation memory', importance: 3, status: 'active', pinned: false, sourceMessageIds: [message.id], supersededBy: null, previousContent: null, createdAt: new Date().toISOString(), lastUsedAt: null });
      const edited = runtime.editMessage(fixture.storyId, message.id, 'New branch edited source'); assert(edited);
      return message;
    });
    await reload();
    await execute(`
      nav('故事'); await wait(() => document.querySelector('#chat .mes'), 'chat');
      button('记忆').click(); await wait(() => document.querySelector('.memory-sources summary'), 'memory'); document.querySelector('.memory-sources summary').click();
      await wait(() => document.querySelector('.memory-sources pre')?.textContent.includes('Original source from previous branch'), 'real source text');
      check(document.querySelector('.memory-sources').textContent.includes('来源不在当前分支'), 'Source branch notice'); button('跳到原始消息').click();
      await wait(() => document.querySelector('[data-message-id="${source.id}"]')?.classList.contains('chat-message--source'), 'source navigation highlight');
      check(document.activeElement?.getAttribute('data-message-id') === ${JSON.stringify(source.id)}, 'Actual source row receives focus');
      const stored = await fetch('/api/conversations/${fixture.storyId}').then(result => result.json()); check(stored.activeBranchId === ${JSON.stringify(source.branchId)}, 'Navigation activates real branch');
    `);
    stages.push('orphaned-memory-shows-original-text-and-navigates-real-old-branch-with-focus');
    const markdown = await download(`document.querySelector('.story-export a').click();`);
    const story = await download(`document.querySelector('.story-export a:nth-of-type(2)').click();`);
    assert.match(readFileSync(markdown.path, 'utf8'), /Original source from previous branch/);
    const storyJson = JSON.parse(readFileSync(story.path, 'utf8'));
    assert(storyJson.messages.some(message => message.id === source.id));
    assert(storyJson.messages.some(message => message.content === 'New branch edited source'));
    stages.push('native-markdown-and-json-downloads-contain-real-story-and-all-branches');
    const backupFile = await download(`button('模型设置').click(); await wait(() => button('导出完整备份'), 'backup panel'); button('导出完整备份').click();`);
    const backup = JSON.parse(readFileSync(backupFile.path, 'utf8')); assert(backup.characters.length); assert(backup.conversations.length);
    assert(backup.extensionSettings.__mycompanion_editor_drafts.characters[fixture.avatar].upload);
    await execute(`
      const data = new FormData(document.querySelector('#form_create')); data.set('description', 'Saved after backup'); data.delete('avatar');
      const result = await fetch('/api/characters/edit', { method: 'POST', body: data }); check(result.ok, 'Change saved card before restore');
      const file = new File([${JSON.stringify(JSON.stringify(backup))}], 'roundtrip-backup.json', { type: 'application/json' }); const files = new DataTransfer(); files.items.add(file);
      const input = document.querySelector('input[aria-label="选择备份文件"]'); input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(() => document.querySelector('.backup-panel table') && button('确认恢复')?.disabled === false, 'skip preview');
      check(document.querySelector('select[aria-label="恢复冲突处理"]').value === 'skip', 'Preview defaults to keeping current data');
      edit(document.querySelector('select[aria-label="恢复冲突处理"]'), 'overwrite');
      await wait(() => document.querySelector('.backup-panel table') && !button('确认恢复').disabled, 'overwrite preview'); button('确认恢复').click();
    `);
    await new Promise(resolve => setTimeout(resolve, 180)); await ready();
    await execute(`
      const stored = await post('/api/characters/get', { avatar_url: ${JSON.stringify(fixture.avatar)} }).then(result => result.json()); check(stored.description === '', 'Actual restore overwrites saved card');
      await wait(() => field('avatar_url').value === ${JSON.stringify(fixture.avatar)}, 'role after restore'); check(field('description').value === 'Unsubmitted role draft', 'Restore reload hydrates backup draft');
    `);
    stages.push('native-full-backup-download-and-ui-preview-overwrite-restore-roundtrip');

    const closeErrors = []; let beforeClose = 0;
    let guard = installDesktopCloseGuard(window, { timeoutMs: 150, beforeClose: async () => { beforeClose++; }, onError: error => closeErrors.push(String(error)) });
    await execute(`window.savedFlush = window.__mycompanionFlushDrafts; window.__mycompanionFlushDrafts = async () => { throw new Error('fixture-flush-failure'); };`);
    assert.equal(await guard.requestClose(), false); assert(!window.isDestroyed()); assert.equal(beforeClose, 0);
    await execute(`window.__mycompanionFlushDrafts = () => new Promise(() => {});`);
    assert.equal(await guard.requestClose(), false); assert(!window.isDestroyed()); assert.match(closeErrors[1], /超时/);
    await execute(`window.__mycompanionFlushDrafts = window.savedFlush;`);
    // Editing and closing in consecutive calls leaves no debounce waiting period.
    await execute(`
      await selectWorld('data-book-a'); edit(content(), 'World draft immediately before close');
      $('#form_create [name=scenario]').val('Role draft immediately before close').trigger('input');
      window.closeFlushCalls = 0; const original = window.__mycompanionFlushDrafts; window.__mycompanionFlushDrafts = async () => { window.closeFlushCalls++; await original(); await new Promise(resolve => setTimeout(resolve, 30)); };
    `);
    // Extend only this real I/O attempt, after checking a deliberately short timeout.
    const closing = guard.requestClose(); const repeated = guard.requestClose(); assert.equal(closing, repeated);
    assert.equal(await closing, true); assert.equal(beforeClose, 1); assert.equal(closeErrors.length, 2);
    const closeDeadline = Date.now() + 1500; while (!window.isDestroyed() && Date.now() < closeDeadline) await new Promise(resolve => setTimeout(resolve, 10)); assert(window.isDestroyed());
    const previousOrigin = origin; await service.close(); await startService(); assert.notEqual(origin, previousOrigin); await openWindow();
    await execute(`
      await core.getCharacters(); await core.selectCharacterById(core.characters.findIndex(item => item.avatar === ${JSON.stringify(fixture.avatar)}));
      await wait(() => field('avatar_url').value === ${JSON.stringify(fixture.avatar)}, 'selected after service restart');
      check(field('scenario').value === 'Role draft immediately before close' && field('avatar').files[0]?.name === 'unsubmitted-draft.png', 'Immediate close persists role fields and PNG');
      await selectWorld('data-book-a'); check(content().value === 'World draft immediately before close', 'Immediate close persists world draft');
      check((await post('/api/worldinfo/get', { name: 'data-book-a' }).then(result => result.json())).entries[0].content === 'Saved data-book-a', 'Restart does not commit world draft');
    `);
    stages.push('real-close-guard-failure-timeout-and-batch-retry-preserve-window-and-restart-drafts');

    await execute(`
      const depth = name => field('depth_prompt_' + name);
      $(depth('prompt')).val('DEPTH_UI_SIGNAL').trigger('input'); $(depth('depth')).val('2').trigger('input'); $(depth('role')).val('user').trigger('change');
      await (await import('/plugin-runtime/character-editor.js')).saveCharacter();
      const saved = await post('/api/characters/get', { avatar_url: ${JSON.stringify(fixture.avatar)} }).then(result => result.json());
      check(saved.data.extensions.depth_prompt.prompt === 'DEPTH_UI_SIGNAL' && saved.data.extensions.depth_prompt.depth === 2 && saved.data.extensions.depth_prompt.role === 'user', 'Advanced role controls persist into actual card');
      await wi.createNewWorldInfo('data-advanced-book'); await wi.saveWorldInfo('data-advanced-book', { entries: { 0: { ...structuredClone(wi.newWorldInfoEntryTemplate), uid: 0, content: 'ADVANCED_WI_MESSAGE', custom: 'keep' } } }, true);
      await selectWorld('data-advanced-book');
      await wait(() => document.querySelector('.world-info-dock fieldset .world-info-advanced'), 'advanced entry controls');
      const panel = document.querySelector('.world-info-dock fieldset'), advanced = panel.querySelector('.world-info-advanced'); advanced.open = true;
      const control = label => [...advanced.querySelectorAll('label')].find(item => item.textContent.startsWith(label)).querySelector('input,select,textarea');
      edit([...panel.querySelectorAll(':scope > label')].find(item => item.textContent.startsWith('关键词')).querySelector('textarea'), 'trigger');
      edit(control('辅助关键词（'), 'second'); edit(control('辅助关键词条件'), '3'); edit(control('插入位置'), '4'); edit(control('距最新消息的深度'), '0'); edit(control('插入消息身份'), '1');
      button('保存世界书').click(); await wait(() => button('保存世界书').disabled && !document.querySelector('.world-info-dock h3').textContent.includes('未保存'), 'advanced world save');
      wi.updateWorldInfoSettings({}, ['data-advanced-book']); await window.__mycompanionFlushDrafts();
      const preview = draft => post('/api/conversations/' + core.getCurrentChatId() + '/prompt-preview', { draft }).then(result => result.json());
      const yes = await preview('trigger second'); check(JSON.stringify(yes).includes('ADVANCED_WI_MESSAGE'), 'Advanced secondary condition reaches real model messages');
      check(yes.messages.some(message => message.role === 'user' && message.content.includes('DEPTH_UI_SIGNAL')), 'Role depth prompt enters actual model message with selected identity');
      check(yes.messages.some(message => message.role === 'user' && message.content.includes('ADVANCED_WI_MESSAGE')), 'World depth insertion uses selected identity');
      check(!JSON.stringify(await preview('trigger')).includes('ADVANCED_WI_MESSAGE'), 'Missing secondary key excludes entry');
      const stored = await post('/api/worldinfo/get', { name: 'data-advanced-book' }).then(result => result.json());
      check(stored.entries[0].position === 4 && stored.entries[0].role === 1 && stored.entries[0].depth === 0 && stored.entries[0].custom === 'keep', 'Advanced world saved depth role and unknown fields');
    `);
    await reload();
    await execute(`
      await wait(() => field('avatar_url').value === ${JSON.stringify(fixture.avatar)}, 'advanced card after reload');
      check(field('depth_prompt_prompt').value === 'DEPTH_UI_SIGNAL' && field('depth_prompt_depth').value === '2' && field('depth_prompt_role').value === 'user', 'Advanced card restored from actual database');
      await selectWorld('data-advanced-book'); const advanced = document.querySelector('.world-info-advanced');
      check([...advanced.querySelectorAll('select')].some(input => input.value === '4'), 'Advanced world position restored');
    `);
    stages.push('real-advanced-character-and-world-controls-persist-reload-and-change-prompt-matching');

    await new Promise((yes, no) => { providerServer.once('error', no); providerServer.listen(0, '127.0.0.1', yes); });
    const providerOrigin = 'http://127.0.0.1:' + providerServer.address().port;
    await execute(`
      nav('角色库'); await wait(() => button('第 2 步：连接模型'), 'beginner connection step'); button('第 2 步：连接模型').click();
      await wait(() => document.querySelector('#provider-model'), 'model settings');
      const advanced = document.querySelector('.provider-advanced'); check(!advanced.open, 'Newcomer advanced settings start folded');
      edit(document.querySelector('[aria-labelledby=provider-title] select'), 'ollama'); edit(document.querySelector('#provider-base-url'), ${JSON.stringify(providerOrigin + '/v1')}); edit(document.querySelector('#provider-model'), 'model-missing');
      button('测试成功后保存').click(); await wait(() => button('修改模型'), 'actionable model failure'); button('修改模型').click();
      check(document.activeElement.id === 'provider-model', 'Correction focuses actual model field');
      const old = await fetch('/api/settings/provider').then(result => result.json()); check(old.model !== 'model-missing', 'Failed draft must not change saved configuration');
      edit(document.querySelector('#provider-model'), 'workflow-model'); button('测试成功后保存').click(); await wait(() => button('第 3 步：开始对话'), 'model replied and settings saved');
      check((await fetch('/api/settings/provider').then(result => result.json())).model === 'workflow-model', 'Only successful draft saves');
      button('第 3 步：开始对话').click(); await wait(() => document.querySelector('#send_textarea') && !document.querySelector('#send_textarea').disabled, 'story composer');
      edit(document.querySelector('#send_textarea'), 'Hello from the beginner workflow'); document.querySelector('#send_but').click();
      await wait(() => [...document.querySelectorAll('#chat .mes_text')].some(item => item.textContent.includes('Beginner actual first reply')), 'actual first model reply');
      await wait(() => !document.querySelector('#send_textarea').disabled, 'completed first reply');
    `);
    assert(providerRequests.some(item => item.body.model === 'model-missing' && item.body.stream === false));
    assert(providerRequests.some(item => item.body.model === 'workflow-model' && item.body.stream === true));
    stages.push('real-beginner-connection-test-failure-correction-success-save-and-first-model-reply');
    await execute(`
      const list = () => fetch('/api/characters').then(result => result.json());
      const original = await fetch('/api/characters/${fixture.characterId}/export?format=json').then(result => result.json());
      original.originalUnknown = { keep: true }; original.data.extensions.oldOnly = { keep: true };
      const data = new FormData(document.querySelector('#form_create')); data.set('json_data', JSON.stringify(original)); data.delete('avatar');
      check((await fetch('/api/characters/edit', { method: 'POST', body: data })).ok, 'Set original unknown fields'); await core.getOneCharacter(${JSON.stringify(fixture.avatar)});
      const incoming = structuredClone(original); delete incoming.originalUnknown; delete incoming.data.extensions.oldOnly;
      incoming.data.description = 'Incoming card replacement'; incoming.incomingUnknown = { keep: true }; incoming.data.extensions.newOnly = { keep: true };
      const cardFile = (name, card) => new File([JSON.stringify(card)], name, { type: 'application/json' });
      const choose = async files => { nav('角色库'); const input = document.querySelector('input[aria-label="选择角色卡文件"]'); const transfer = new DataTransfer(); files.forEach(file => transfer.items.add(file)); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(resolve => requestAnimationFrame(resolve)); };
      const count = (await list()).total;
      await choose([cardFile('same-name.json', incoming)]); await wait(() => document.querySelector('.import-duplicates'), 'duplicate preview');
      button('打开既有角色', document.querySelector('.import-duplicates')).click(); await wait(() => !document.querySelector('#preview-title'), 'opened existing'); check((await list()).total === count, 'Opening duplicate is read-only');
      await choose([cardFile('copy.json', incoming)]); await wait(() => button('导入独立副本'), 'copy preview'); button('导入独立副本').click(); await wait(() => !document.querySelector('#preview-title'), 'copy committed');
      check((await list()).total === count + 1, 'Copy creates independent ID');
      await choose([cardFile('replace.json', incoming)]); await wait(() => document.querySelector('.import-duplicates [data-character-id="${fixture.characterId}"]'), 'replacement target');
      button('用当前卡片替换', document.querySelector('.import-duplicates [data-character-id="${fixture.characterId}"]')).click(); await wait(() => !document.querySelector('#preview-title'), 'replace committed');
      const replaced = await fetch('/api/characters/${fixture.characterId}/export?format=json').then(result => result.json());
      check(replaced.data.description === 'Incoming card replacement' && replaced.originalUnknown.keep && replaced.incomingUnknown.keep && replaced.data.extensions.oldOnly.keep && replaced.data.extensions.newOnly.keep, 'Replace preserves original and incoming unknown data');
      check((await list()).total === count + 1, 'Replace retains ID');
      const story = await fetch('/api/conversations/${fixture.storyId}').then(result => result.json()); check(story.characterId === ${JSON.stringify(fixture.characterId)} && story.messages.some(item => item.content === 'Original source from previous branch'), 'Replace retains stories and source messages');
      await choose([cardFile('conflict.json', incoming)]); await wait(() => document.querySelector('.import-duplicates [data-character-id="${fixture.characterId}"]'), 'stale replacement preview');
      const concurrent = new FormData(document.querySelector('#form_create')); concurrent.set('description', 'External card change'); concurrent.delete('avatar'); check((await fetch('/api/characters/edit', { method: 'POST', body: concurrent })).ok, 'External change');
      button('用当前卡片替换', document.querySelector('.import-duplicates [data-character-id="${fixture.characterId}"]')).click();
      await wait(() => document.querySelector('.notice--error'), 'version conflict visible');
      await wait(() => !button('重新检查角色匹配').disabled, 'conflict request done');
      check(document.querySelector('#preview-title'), 'Conflict keeps exact file preview');
      check((await fetch('/api/characters/${fixture.characterId}/export?format=json').then(result => result.json())).data.description === 'External card change', 'Conflict does not overwrite newer data');
      button('重新检查角色匹配').click(); await new Promise(resolve => requestAnimationFrame(resolve)); await wait(() => document.querySelector('.import-duplicates [data-character-id="${fixture.characterId}"]') && button('重新检查角色匹配') && !button('重新检查角色匹配').disabled, 'fresh replacement preview');
      button('用当前卡片替换', document.querySelector('.import-duplicates [data-character-id="${fixture.characterId}"]')).click(); await wait(() => !document.querySelector('#preview-title'), 'retry replaces fresh revision');
      const retry = structuredClone(incoming); retry.data.name = 'Batch retry fixture'; const good = structuredClone(incoming); good.data.name = 'Batch good fixture';
      await choose([cardFile('invalid.json', {}), cardFile('retry.json', retry), cardFile('good.json', good)]);
      await wait(() => document.querySelector('#preview-title')?.textContent === 'Batch retry fixture', 'continue after bad file'); button('确认导入').click();
      await wait(() => document.querySelector('#preview-title')?.textContent === 'Batch good fixture', 'continue after per-file save failure'); button('确认导入').click();
      await wait(() => !document.querySelector('#preview-title'), 'batch good saved');
      check(document.querySelector('.import-batch').textContent.includes('invalid.json') && document.querySelector('.import-batch').textContent.includes('Temporary batch save failure'), 'Each failed file keeps its own error');
      const row = () => [...document.querySelectorAll('.import-batch li')].find(item => item.textContent.includes('retry.json'));
      button('重试此文件', row()).click(); await wait(() => document.querySelector('#preview-title')?.textContent === 'Batch retry fixture', 'retry one failed file'); button('确认导入').click(); await wait(() => !document.querySelector('#preview-title'), 'failed file recovered');
      const after = await list(); check(after.items.filter(item => item.name === 'Batch good fixture').length === 1 && after.items.filter(item => item.name === 'Batch retry fixture').length === 1, 'Successful files are not uploaded again');
      window.importWorkflowEvidence = { totalBefore: count, totalAfter: after.total };
    `);
    stages.push('real-duplicate-open-copy-replace-version-conflict-and-batch-per-file-recovery');
    const reconciliation = repository(runtime => runtime.withTransaction(() => {
      const base = { conversationId: fixture.storyId, characterId: fixture.characterId, type: 'fact', scope: 'story', importance: 4,
        sourceMessageIds: [source.id], supersededBy: null, previousContent: null, createdAt: new Date().toISOString(), lastUsedAt: null };
      const old = runtime.addMemory({ ...base, id: randomUUID(), content: 'Stable location is north', status: 'active', pinned: true, manuallyEdited: true,
        claim: { subject: 'home', predicate: 'location', value: 'north', temporality: 'stable' } });
      const next = { ...base, id: randomUUID(), content: 'Stable location is south', status: 'active', pinned: false,
        claim: { subject: 'home', predicate: 'location', value: 'south', temporality: 'stable' } };
      runtime.recordSupersession(next); const pending = runtime.addMemory(next);
      assert.equal(pending.status, 'pending'); assert(pending.reconciliation?.reason);
      return { old: old.id, pending: pending.id, reason: pending.reconciliation.reason };
    }));
    await execute(`
      nav('故事'); await wait(() => button('记忆'), 'memory button'); if (button('记忆').getAttribute('aria-expanded') !== 'true') button('记忆').click();
      await wait(() => button('采用并替代关联记忆'), 'pending actual classified claim');
      check(document.querySelector('.memory-panel').textContent.includes(${JSON.stringify(reconciliation.reason)}), 'Shows actual executed reconciliation rule reason');
      check(document.querySelector('.memory-reconciliation').textContent.includes('已固定') && document.querySelector('.memory-reconciliation').textContent.includes('人工更正'), 'Shows protected related original content');
      button('采用并替代关联记忆').click(); await wait(() => button('恢复这条记忆') && !button('恢复这条记忆').disabled, 'manual adopt refreshes full replacement status');
      const read = () => fetch('/api/conversations/${fixture.storyId}/memories').then(result => result.json());
      const adopted = await read(); check(adopted.items.find(item => item.id === ${JSON.stringify(reconciliation.old)}).status === 'superseded', 'Adoption keeps original as superseded');
      button('恢复这条记忆').click(); await wait(() => button('采用并替代关联记忆') && !button('采用并替代关联记忆').disabled, 'rollback leaves new claim pending');
      const restored = await read(); check(restored.items.find(item => item.id === ${JSON.stringify(reconciliation.old)}).status === 'active' && restored.items.find(item => item.id === ${JSON.stringify(reconciliation.pending)}).status === 'pending', 'Actual supersession rollback restores original and preserves candidate');
      const canonical = await import('/plugin-runtime/prompt-manager-core.js'), facade = await import('/scripts/PromptManager.js'), openai = await import('/scripts/openai.js');
      check(canonical.Prompt === facade.Prompt && canonical.PromptCollection === facade.PromptCollection && openai.promptManager instanceof canonical.PromptManager, 'Prompt manager facades share actual core constructors');
      check(await openai.promptManager.getPromptCollection('normal'), 'Canonical prompt collection works');
    `);
    stages.push('actual-memory-conflict-reason-protected-content-explicit-adoption-and-rollback');
    stages.push('canonical-prompt-manager-core-browser-facades-share-constructors-and-collection');
    await execute(`
      document.querySelector('button[aria-label="设置"]').click(); await wait(() => document.querySelector('select[aria-label="界面语言"]'), 'language selector');
      edit(document.querySelector('select[aria-label="界面语言"]'), 'en'); await wait(() => document.querySelector('#provider-title')?.textContent === 'Let your character reply', 'real English settings text');
      check(document.documentElement.lang === 'en' && [...document.querySelectorAll('nav button')].some(item => item.textContent.startsWith('Stories')), 'Real navigation and document language changed');
      await window.__mycompanionFlushDrafts();
      await wait(async () => (await fetch('/api/extensions/settings').then(result => result.json())).extensionSettings.__mycompanion_preferences?.language === 'en', 'persistent profile preference');
    `);
    guard = installDesktopCloseGuard(window, { beforeClose: async () => {}, onError: error => { throw error; } });
    assert.equal(await guard.requestClose(), true); const oldOrigin = origin; await service.close(); await startService(); assert.notEqual(origin, oldOrigin); await openWindow();
    await execute(`
      await wait(() => document.documentElement.lang === 'en', 'saved language restored on fresh service port');
      check([...document.querySelectorAll('nav button')].some(item => item.textContent.startsWith('Characters')), 'Fresh document restores real English navigation');
      document.querySelector('button[aria-label="Settings"]').click(); await wait(() => document.querySelector('#provider-title')?.textContent === 'Let your character reply', 'English settings after restart');
      edit(document.querySelector('select[aria-label="Interface language"]'), 'zh'); await wait(() => document.documentElement.lang === 'zh-CN', 'switch back'); await window.__mycompanionFlushDrafts();
    `);
    stages.push('real-chinese-english-navigation-settings-and-language-preference-survive-new-service-port');
    const report = { checkedAt: new Date().toISOString(), runLabel, passed: true, stages, downloads: downloads.map(item => ({ fileName: item.fileName, state: item.state })), closeFailures: closeErrors, temporaryProfile: profile, completeHelperCompatibility: false };
    await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' }); console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    let diagnostics; try { diagnostics = await window.webContents.executeJavaScript(`({ text: document.body.innerText, role: document.querySelector('#form_create [name=avatar_url]')?.value, buttons: [...document.querySelectorAll('button')].map(item => item.textContent) })`); } catch {}
    await writeFile(reportPath, JSON.stringify({ checkedAt: new Date().toISOString(), runLabel, passed: false, stages, error: error.stack || String(error), diagnostics }, null, 2), { flag: 'wx' }); console.error(error); process.exitCode = 1;
  } finally { clearTimeout(deadline); for (const item of windows) if (!item.isDestroyed()) item.destroy(); await service?.close(); providerServer.closeAllConnections(); await new Promise(resolve => providerServer.close(resolve)); app.exit(process.exitCode || 0); }
}
void verify();
