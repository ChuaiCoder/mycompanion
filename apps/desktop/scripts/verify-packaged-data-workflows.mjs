// Actual candidate HTTP, React controls and Chromium native downloads only.
// Project-authored seed data is identified separately from observable UI checks.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) ?? 'null'
  : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : '{' + Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
const delay = ms => new Promise(done => setTimeout(done, ms));

async function browserHarness() {
  const wait = async (test, label) => { const end = Date.now() + 22000; while (!await test()) {
    if (Date.now() > end) throw new Error('Candidate data workflow: ' + label); await new Promise(done => setTimeout(done, 20));
  } };
  const check = (value, label) => { if (!value) throw new Error(label); };
  await wait(() => document.querySelector('.service-state--online') && document.getElementById('send_textarea'), 'ready');
  const core = await import('/plugin-runtime/compat-runtime.js'); await (await import('/plugin-runtime/desktop-host.js')).start();
  const button = name => [...document.querySelectorAll('button')].find(item => item.textContent.trim() === name || item.getAttribute('aria-label') === name);
  const nav = name => { const target = [...document.querySelectorAll('nav button')].find(item => item.textContent.trim().startsWith(name)); check(target, 'Data navigation'); target.click(); };
  const choose = (bytes, name, input) => { check(input, 'Backup file control'); const files = new DataTransfer(); files.items.add(new File([bytes], name, { type: 'application/json' })); input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true })); };
  window.packagedData = { wait, check, core, button, nav, choose };
}

export function createPackagedDataWorkflows(report) {
  const evidence = report.dataWorkflows = { passed: false, stages: [], downloads: [],
    seedOrigin: 'Actual candidate conversation/extension-state/backup HTTP with project-authored memory; seed operations are not UI passing stages',
    boundaries: ['No real-model memory quality or human newcomer claim', 'OS file chooser manually unverified; actual File input/read/preview/restore controls execute', 'No private card or helper data in this separate isolated profile'] };
  let storyId, sourceId, memoryId, initialBranch, restoredMemory;
  const stage = name => { report.stages.push(name); evidence.stages.push(name); console.log(name); };
  return { async verify({ phase, evaluate, origin, profile, sendCdp, reload }) {
    const api = async (method, path, payload) => { const response = await fetch(origin + path, { method,
      ...(payload !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {}) });
      assert(response.ok, 'Candidate data HTTP ' + path + ' status ' + response.status); return response.json(); };
    const view = body => evaluate(`(async()=>{const {wait,check,core,button,nav,choose}=window.packagedData;${body}})()`);
    const ready = async () => { await evaluate(`(${browserHarness.toString()})()`); };
    const open = async () => view(`nav('故事');await wait(()=>document.querySelector('button[data-conversation-id="${storyId}"]'),'data story');document.querySelector('button[data-conversation-id="${storyId}"]').click();await wait(()=>core.getContext().conversationId===${JSON.stringify(storyId)},'data story selected');`);
    await ready();
    if (phase === 'restart') {
      await open(); assert.equal((await api('GET', '/api/conversations/' + storyId)).activeBranchId, initialBranch);
      const memories = await api('GET', '/api/conversations/' + storyId + '/memories');
      assert.equal(memories.items.find(item => item.id === memoryId)?.content, restoredMemory);
      await view(`button('记忆').click();await wait(()=>document.querySelector('.memory-sources summary'),'data restored sources');document.querySelector('.memory-sources summary').click();await wait(()=>document.querySelector('.memory-sources pre')?.textContent==='PACKAGED_ORIGINAL_SOURCE','data original source after EXE restart');button('跳到原始消息').click();await wait(()=>document.activeElement?.getAttribute('data-message-id')===${JSON.stringify(sourceId)},'data restored source focus');`);
      evidence.passed = true; stage('restart-packaged-memory-backup-source-branch-and-focus-persist'); return;
    }
    const baseline = await api('GET', '/api/conversations/' + report.independentRuns.find(run => run.phase === 'initial').conversationId);
    const story = await api('POST', '/api/conversations', { characterId: baseline.characterId }); storyId = story.id; initialBranch = story.activeBranchId;
    sourceId = randomUUID(); memoryId = randomUUID(); restoredMemory = 'PACKAGED_SOURCE_MEMORY';
    const base = { metadata: story.chatMetadata ?? {}, messages: story.messages.map(message => ({
      ...message.extensionData, id: message.id, mes: message.content, is_user: message.role === 'user', is_system: false,
      name: message.role === 'user' ? 'User' : story.characterName, role: message.role, status: message.status, send_date: message.createdAt })) };
    await api('PUT', '/api/conversations/' + storyId + '/extension-state', { branchId: initialBranch, base,
      next: { metadata: base.metadata, messages: [...base.messages, { id: sourceId, mes: 'PACKAGED_ORIGINAL_SOURCE',
        name: 'User', is_user: true, is_system: false, role: 'user', status: 'complete', send_date: new Date().toISOString(), extra: { fixtureUnknown: { preserved: true } } }] } });
    const seed = await api('GET', '/api/backup');
    seed.memories.push({ id: memoryId, conversationId: storyId, characterId: story.characterId, type: 'fact', scope: 'story',
      content: restoredMemory, importance: 3, status: 'active', pinned: false, sourceMessageIds: [sourceId],
      supersededBy: null, previousContent: null, createdAt: new Date().toISOString(), lastUsedAt: null });
    seed.manifest.memoryCount = seed.memories.length; const { manifest, ...content } = seed; void manifest;
    seed.manifest.checksum = sha(canonical(content));
    await api('POST', '/api/backup/restore', { backup: seed, strategy: 'overwrite' });
    await api('PATCH', '/api/conversations/' + storyId + '/messages/' + sourceId, { content: 'PACKAGED_EDITED_SOURCE' });
    const orphaned = await api('GET', '/api/conversations/' + storyId + '/memories');
    assert.equal(orphaned.items.find(item => item.id === memoryId)?.status, 'orphaned');
    await reload(); await ready(); await open();
    await view(`button('记忆').click();await wait(()=>document.querySelector('.memory-sources summary'),'data source disclosure');document.querySelector('.memory-sources summary').click();await wait(()=>document.querySelector('.memory-sources pre')?.textContent==='PACKAGED_ORIGINAL_SOURCE','old branch original source');check(document.querySelector('.memory-sources').textContent.includes('来源不在当前分支'),'actual orphaned source notice');button('跳到原始消息').click();await wait(()=>document.activeElement?.getAttribute('data-message-id')===${JSON.stringify(sourceId)}&&document.querySelector('[data-message-id="${sourceId}"]').classList.contains('chat-message--source'),'actual old branch source focus');`);
    assert.equal((await api('GET', '/api/conversations/' + storyId)).activeBranchId, initialBranch);
    stage('initial-packaged-orphaned-memory-original-source-real-old-branch-and-focus');

    const downloadDirectory = join(profile, 'acceptance-downloads'); await mkdir(downloadDirectory, { recursive: true });
    await sendCdp('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDirectory });
    const download = async (script, suffix) => {
      const previous = new Set(await readdir(downloadDirectory)); await view(script); const end = Date.now() + 22000;
      while (Date.now() < end) { const current = await readdir(downloadDirectory);
        const name = current.find(file => !previous.has(file) && file.endsWith(suffix));
        if (current.some(file => !previous.has(file) && file.endsWith('.crdownload'))) { await delay(40); continue; }
        if (name) { const bytes = await readFile(join(downloadDirectory, name)); evidence.downloads.push({ name, bytes: bytes.length, sha256: sha(bytes), nativeFileWritten: true }); return bytes; }
        await delay(40);
      } throw new Error('Candidate native download timed out: ' + suffix);
    };
    const markdown = await download(`document.querySelector('.story-export').open=true;document.querySelector('.story-export a').click();`, '.md');
    assert(markdown.toString('utf8').includes('PACKAGED_ORIGINAL_SOURCE'));
    const exported = JSON.parse((await download(`document.querySelector('.story-export a:nth-of-type(2)').click();`, '.json')).toString('utf8'));
    assert(exported.messages.some(message => message.id === sourceId));
    assert(exported.messages.some(message => message.content === 'PACKAGED_EDITED_SOURCE'));
    assert(exported.messages.find(message => message.id === sourceId).extensionData.extra.fixtureUnknown.preserved);
    stage('initial-packaged-native-markdown-and-json-downloads-preserve-all-branches-and-unknown-fields');

    const backup = JSON.parse((await download(`button('模型设置').click();await wait(()=>button('导出完整备份'),'data backup UI');button('导出完整备份').click();`, '.json')).toString('utf8'));
    assert(backup.memories.some(item => item.id === memoryId && item.content === restoredMemory));
    await api('PUT', '/api/conversations/' + storyId + '/memories/' + memoryId, { content: 'PACKAGED_CHANGED_AFTER_BACKUP' });
    await view(`choose('{broken','invalid-backup.json',document.querySelector('input[aria-label="选择备份文件"]'));await wait(()=>document.querySelector('.backup-panel [role="alert"]'),'invalid backup actual alert');check(!button('确认恢复'),'invalid backup no restore action');`);
    assert.equal((await api('GET', '/api/conversations/' + storyId + '/memories')).items.find(item => item.id === memoryId).content, 'PACKAGED_CHANGED_AFTER_BACKUP');
    stage('initial-packaged-invalid-backup-file-keeps-current-SQLite-data');
    const reloadMarker = randomUUID();
    await view(`choose(${JSON.stringify(JSON.stringify(backup))},'packaged-roundtrip.json',document.querySelector('input[aria-label="选择备份文件"]'));await wait(()=>document.querySelector('.backup-panel table')&&!button('确认恢复').disabled,'default skip preview');const strategy=document.querySelector('select[aria-label="恢复冲突处理"]');check(strategy.value==='skip','default preserves current data');strategy.value='overwrite';strategy.dispatchEvent(new Event('change',{bubbles:true}));await wait(()=>document.querySelector('.backup-panel table')&&!button('确认恢复').disabled,'overwrite preview');check(document.querySelector('.backup-panel').textContent.includes('覆盖'),'actual overwrite information');window.packagedRestoreMarker=${JSON.stringify(reloadMarker)};button('确认恢复').click();`);
    const restoreDeadline = Date.now() + 30000;
    let newDocumentReady = false;
    while (Date.now() < restoreDeadline) {
      try {
        newDocumentReady = await evaluate(`window.packagedRestoreMarker!==${JSON.stringify(reloadMarker)}&&Boolean(document.querySelector('.service-state--online')&&document.getElementById('send_textarea'))`);
      } catch (error) {
        if (!/Cannot find (?:default execution context|context with specified id)|Execution context was destroyed/.test(error.message)) throw error;
      }
      if (newDocumentReady) break;
      await delay(40);
    }
    assert(newDocumentReady, 'Backup restore did not replace the actual React document');
    await ready(); await open();
    const restored = await api('GET', '/api/conversations/' + storyId + '/memories');
    assert.equal(restored.items.find(item => item.id === memoryId)?.content, restoredMemory);
    assert.equal((await api('GET', '/api/conversations/' + storyId)).activeBranchId, initialBranch);
    stage('initial-packaged-native-full-backup-file-preview-overwrite-restore-and-React-reload');
    await view(`button('模型设置').click();await wait(()=>document.querySelector('select[aria-label="界面语言"]'),'actual language control');const language=document.querySelector('select[aria-label="界面语言"]');language.value='en';language.dispatchEvent(new Event('change',{bubbles:true}));await wait(()=>document.querySelector('input[aria-label="Choose backup file"]')&&button('Export full backup'),'English backup controls');choose('{broken','invalid-english-backup.json',document.querySelector('input[aria-label="Choose backup file"]'));await wait(()=>document.querySelector('.backup-panel [role="alert"]')?.textContent==='Could not read this JSON file. Choose a backup exported by MyCompanion.','English invalid backup recovery');check(!button('Confirm restore'),'invalid English backup cannot restore');const englishLanguage=document.querySelector('select[aria-label="Interface language"]');englishLanguage.value='zh';englishLanguage.dispatchEvent(new Event('change',{bubbles:true}));await wait(()=>document.querySelector('input[aria-label="选择备份文件"]')&&button('导出完整备份'),'Chinese backup controls restored');const settings=await import('/plugin-runtime/settings.js');await settings.saveSettings();`);
    assert.equal((await api('GET', '/api/conversations/' + storyId + '/memories')).items.find(item => item.id === memoryId)?.content, restoredMemory);
    stage('initial-packaged-English-backup-file-errors-and-language-return-preserve-restored-data');
  } };
}
