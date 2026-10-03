// Actual desktop CHARX import, artwork, raw asset export, backup and restart.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipFile } from 'yazl';
import { parseCharacterCardPngDocument } from '@mycompanion/character-card';
import { app, BrowserWindow, nativeImage } from 'electron';
import { bindBrowserPort, buildApp } from '../../local-service/dist/app.js';
import { parseCharacterArchive } from '../../local-service/dist/character-archive.js';
import { inlineCharacterAssetPath } from '../../local-service/dist/character-inline-assets.js';
import { installDesktopCloseGuard } from '../dist/desktop-close.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const profile = mkdtempSync(join(tmpdir(), 'mycompanion-renderer-character-archives-'));
const databasePath = join(profile, 'profile.sqlite');
const label = process.argv.find(value => value.startsWith('--label='))?.slice(8) ?? new Date().toISOString().replace(/[^a-z0-9]/gi, '-');
assert(/^[a-z0-9-]{1,90}$/i.test(label));
const reportPath = join(root, '.cache/reports/renderer-character-archives-' + label + '.json'); mkdirSync(dirname(reportPath), { recursive: true });
app.setPath('userData', profile); app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
const windows = [], stages = [], downloads = [];
let service, window, origin, guard;
const deadline = setTimeout(() => { writeFileSync(reportPath, JSON.stringify({ passed: false, checkedAt: new Date().toISOString(), label, profile, stages, error: 'Desktop archive verification deadline exceeded' }, null, 2), { flag: 'wx' }); app.exit(1); }, 140_000);
const recordStage = value => { stages.push(value); console.log('Passed: ' + value); };
const card = { spec: 'chara_card_v3', spec_version: '3.0', customTop: { retained: true }, data: { name: 'Archive renderer role', description: 'Archive initial setting', personality: '', scenario: '', first_mes: 'Archive greeting', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: 'MyCompanion fixture', character_version: '1', extensions: { customUnknown: { retained: true } }, customAssetNote: 'retained', assets: [ { type: 'icon', name: 'main', ext: 'jpg', uri: 'embeded://assets/icon/main.jpg' }, { type: 'audio', name: 'greeting', ext: 'wav', uri: 'embedded://assets/audio/greeting.wav' }, { type: 'background', name: 'remote', ext: 'png', uri: 'https://example.invalid/never-download.png' } ] } };
let icon, fixtureBytes;
const audio = Buffer.from([82, 73, 70, 70, 1, 2, 3, 4]), auxiliary = Buffer.from('{"custom":"retained"}');
async function zip(document = card) {
  const output = new ZipFile(), parts = [];
  const result = new Promise((resolve, reject) => { output.outputStream.on('data', part => parts.push(part)); output.outputStream.on('error', reject); output.outputStream.on('end', () => resolve(Buffer.concat(parts))); });
  for (const [path, bytes] of [['card.json', Buffer.from(JSON.stringify(document))], ['assets/icon/main.jpg', icon], ['assets/audio/greeting.wav', audio], ['app-specific.json', auxiliary], ['assets/code/never-run.js', Buffer.from('throw new Error("must never run imported card asset")')]]) output.addBuffer(bytes, path, { compress: false });
  output.end(); return result;
}
async function byafFixture() {
  const date = '2025-06-13T12:00:00.000Z';
  const manifest = { schemaVersion: 1, createdAt: date, characters: ['characters/cartographer/character.json'], scenarios: ['scenarios/first.json', 'scenarios/second.json'], author: { name: 'Project fixture', backyardURL: 'https://example.com/author' }, unknownManifest: { kept: true } };
  const character = { schemaVersion: 1, id: 'fixture-character', name: 'Cartographer', displayName: 'The Cartographer', isNSFW: false, persona: '{character} remembers {user}', createdAt: date, updatedAt: date, loreItems: [{ key: 'harbor,port', value: 'A safe harbor' }], images: [{ path: 'images/main.png', label: 'main' }, { path: 'images/alternative.jpeg', label: 'alternative' }], unknownCharacter: { kept: true } };
  const scenario = title => ({ schemaVersion: 1, title, narrative: title + ' narrative', formattingInstructions: 'Answer as {character}', minP: 0.1, minPEnabled: true, temperature: 0.7, repeatPenalty: 1.1, repeatLastN: 64, topK: 40, topP: 0.9, promptTemplate: 'ChatML', grammar: null, canDeleteExampleMessages: true, exampleMessages: [{ characterID: 'fixture-character', text: '#{character}: example' }], firstMessages: [{ characterID: 'fixture-character', text: title + ' greeting' }], backgroundImage: 'backgrounds/harbor.png', unknownScenario: { kept: true }, messages: [{ type: 'human', createdAt: date, updatedAt: date, text: 'Where?', unknownMessage: { kept: true } }, { type: 'ai', unknownMessage: { kept: true }, outputs: [{ createdAt: date, updatedAt: date, activeTimestamp: date, text: 'Old harbor' }, { createdAt: date, updatedAt: date, activeTimestamp: '2025-06-13T12:01:00.000Z', text: 'New harbor' }] }] });
  const files = new Map([['manifest.json', Buffer.from(JSON.stringify(manifest))], ['characters/cartographer/character.json', Buffer.from(JSON.stringify(character))], ['scenarios/first.json', Buffer.from(JSON.stringify(scenario('First')))], ['scenarios/second.json', Buffer.from(JSON.stringify(scenario('Second')))], ['characters/cartographer/images/main.png', nativeImage.createFromBuffer(icon).toPNG()], ['characters/cartographer/images/alternative.jpeg', icon], ['backgrounds/harbor.png', nativeImage.createFromBuffer(icon).toPNG()], ['extra/script.js', Buffer.from('throw new Error("BYAF asset is never executed")')]]);
  const archive = new ZipFile(), parts = [];
  const result = new Promise((resolve, reject) => { archive.outputStream.on('data', part => parts.push(part)); archive.outputStream.on('error', reject); archive.outputStream.on('end', () => resolve(Buffer.concat(parts))); });
  for (const [path, bytes] of files) archive.addBuffer(bytes, path);
  archive.end(); return { bytes: await result, files };
}
async function browserHarness() {
  const wait = async (predicate, label) => { const until = Date.now() + 9000; while (!await predicate()) { if (Date.now() > until) throw new Error('Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 20)); } };
  await wait(() => document.querySelector('.service-state--online') && window.__mycompanionFlushDrafts && document.querySelector('#form_create'), 'connected application');
  const script = await import('/script.js'), compat = await import('/plugin-runtime/compat-runtime.js'), core = { ...script, getContext: compat.getContext }, host = await import('/plugin-runtime/desktop-host.js'); await host.start();
  const check = (value, label) => { if (!value) throw new Error(label); };
  const button = (name, container = document) => [...container.querySelectorAll('button')].find(item => item.textContent.trim() === name);
  const nav = name => [...document.querySelectorAll('nav button')].find(item => item.textContent.trim().startsWith(name)).click();
  const edit = (element, value) => { Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set.call(element, value); element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); };
  const choose = async (encoded, name, input = document.querySelector('input[aria-label="选择角色卡文件"]')) => { const bytes = Uint8Array.from(atob(encoded), value => value.charCodeAt(0)), files = new DataTransfer(); files.items.add(new File([bytes], name)); input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(requestAnimationFrame); };
  window.archiveFixture = { wait, check, button, nav, edit, choose, core };
}
async function evaluate(body) { return window.webContents.executeJavaScript(`(async()=>{const {wait,check,button,nav,edit,choose,core}=window.archiveFixture;${body}})()`); }
async function ready() { await window.webContents.executeJavaScript(`(${browserHarness.toString()})()`); }
async function startService() { service = buildApp({ databasePath, rendererRoot: join(root, 'apps/renderer/dist') }); origin = await bindBrowserPort(port => service.listen({ host: '127.0.0.1', port })); }
async function openWindow() {
  window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } }); windows.push(window);
  if (windows.length === 1) window.webContents.session.on('will-download', (_event, item) => { const path = join(profile, downloads.length + '-' + item.getFilename()), result = { fileName: item.getFilename(), path }; downloads.push(result); item.setSavePath(path); item.once('done', (_event, state) => { result.state = state; }); });
  await window.loadURL(origin); await ready();
}
async function download(body) { const count = downloads.length; await evaluate(body); const until = Date.now() + 8000; while (downloads.length === count || !downloads[count].state) { if (Date.now() > until) throw new Error('Native download timed out'); await new Promise(resolve => setTimeout(resolve, 20)); } assert.equal(downloads[count].state, 'completed'); return downloads[count]; }
async function verify() { try {
  await app.whenReady(); icon = nativeImage.createFromBitmap(Buffer.from([0,0,255,255,0,255,0,255,255,0,0,255,255,255,255,255]), { width: 2, height: 2 }).toJPEG(80); assert(icon.length > 100, 'Fixture is a real JPEG');
  fixtureBytes = Buffer.concat([icon, await zip()]); await startService(); await openWindow();
  await evaluate(`nav('角色库');await choose(${JSON.stringify(fixtureBytes.toString('base64'))},'archive-cover.jpeg');await wait(()=>document.querySelector('#preview-title')?.textContent==='Archive renderer role','CHARX preview');check(document.querySelector('.preview-inspector').textContent.includes('实际识别 4 个文件'),'Actual asset count');check(document.querySelector('.preview-inspector').textContent.includes('CCV3-CHARX'),'Actual detected format');`);
  recordStage('real-jpeg-prefixed-charx-preview-identifies-assets-before-saving');
  const imported = await evaluate(`button('确认导入').click();await wait(()=>document.querySelector('#character-detail-title')?.textContent==='Archive renderer role','Committed role');await wait(()=>document.querySelector('.character-page .character-avatar img')?.complete&&document.querySelector('.character-page .character-avatar img')?.naturalWidth>0,'Real JPEG artwork renders');const items=await fetch('/api/characters').then(result=>result.json());return items.items.find(item=>item.name==='Archive renderer role');`);
  assert.equal(imported.sourceFormat, 'ccv3-charx');
  assert.deepEqual(Buffer.from(await evaluate(`return [...new Uint8Array(await fetch('/characters/'+${JSON.stringify(imported.avatar)}).then(result=>result.arrayBuffer()))];`)), icon);
  recordStage('real-binary-commit-and-sidebar-detail-jpeg-avatar-render');
  const exported = await download(`document.querySelector('a[href="/api/characters/${imported.id}/export?format=charx"]').click();`);
  const parsed = await parseCharacterArchive(readFileSync(exported.path)); assert.equal(parsed.card.spec, 'chara_card_v3'); assert.equal(parsed.card.data.name, card.data.name); assert.deepEqual(parsed.card.customTop, card.customTop); assert.deepEqual(parsed.card.data.extensions.customUnknown, card.data.extensions.customUnknown); assert.equal(parsed.card.data.customAssetNote, card.data.customAssetNote); assert.deepEqual(parsed.card.data.assets, card.data.assets); assert.deepEqual(parsed.assets.get('assets/icon/main.jpg'), icon); assert.deepEqual(parsed.assets.get('assets/audio/greeting.wav'), audio); assert.deepEqual(parsed.assets.get('app-specific.json'), auxiliary);
  recordStage('native-charx-download-roundtrips-unknown-metadata-and-all-stored-asset-bytes');
  await evaluate(`button('开始对话').click();await wait(()=>core.getCurrentChatId(),'Actual story');nav('角色库');await choose(${JSON.stringify(fixtureBytes.toString('base64'))},'same.charx');await wait(()=>document.querySelector('.import-duplicates'),'Real CHARX duplicate');button('打开既有角色').click();await wait(()=>!document.querySelector('#preview-title'),'Open duplicate without upload');`);
  const changed = structuredClone(card); changed.data.description = 'Archive replacement setting'; const replacement = await zip(changed);
  await evaluate(`await choose(${JSON.stringify(replacement.toString('base64'))},'replacement.charx');await wait(()=>document.querySelector('.import-duplicates'),'Replacement duplicate');button('用当前卡片替换').click();await wait(()=>!document.querySelector('#preview-title'),'Replace complete');check((await fetch('/api/characters/${imported.id}').then(result=>result.json())).description==='Archive replacement setting','Same character identity replaced');check((await fetch('/api/conversations').then(result=>result.json())).total===1,'Existing story preserved');`);
  recordStage('real-charx-duplicate-open-and-replace-preserve-character-identity-story-and-assets');
  const backup = await download(`document.querySelector('button[aria-label="设置"]').click();await wait(()=>button('导出完整备份'),'Backup entry');button('导出完整备份').click();`);
  const backupPayload = JSON.parse(readFileSync(backup.path, 'utf8')), saved = backupPayload.characters.find(item => item.id === imported.id); assert.equal(saved.assets['assets/audio/greeting.wav'], audio.toString('base64')); assert.equal(saved.assets['assets/icon/main.jpg'], icon.toString('base64'));
  const restoreLoaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve));
  await evaluate(`nav('角色库');await wait(()=>button('编辑角色'),'Library after settings');button('编辑角色').click();await wait(()=>document.querySelector('#form_create [name=avatar_url]').value===${JSON.stringify(imported.avatar)},'Real editor');$('#form_create [name=description]').val('Changed after backup').trigger('input');button('保存角色').click();await wait(async()=> (await fetch('/api/characters/${imported.id}').then(result=>result.json())).description==='Changed after backup','Actual saved edit');document.querySelector('button[aria-label="设置"]').click();await choose(${JSON.stringify(Buffer.from(JSON.stringify(backupPayload)).toString('base64'))},'archive-backup.json',document.querySelector('input[aria-label="选择备份文件"]'));await wait(()=>document.querySelector('select[aria-label="恢复冲突处理"]'),'Restore choices');edit(document.querySelector('select[aria-label="恢复冲突处理"]'),'overwrite');await new Promise(requestAnimationFrame);await wait(()=>button('确认恢复')&&!button('确认恢复').disabled,'Actual restore preview');button('确认恢复').click();`);
  await restoreLoaded; await ready();
  await evaluate(`check((await fetch('/api/characters/${imported.id}').then(result=>result.json())).description==='Archive replacement setting','Actual backup restores role setting');`);
  assert.deepEqual(Buffer.from(await evaluate(`return [...new Uint8Array(await fetch('/api/characters/${imported.id}/assets/assets/audio/greeting.wav').then(result=>result.arrayBuffer()))];`)), audio);
  recordStage('native-full-backup-and-real-ui-overwrite-restore-preserve-role-and-binary-assets');
  await evaluate(`nav('角色库');await wait(()=>[...document.querySelectorAll('.character-row')].some(item=>item.textContent.includes('Archive renderer role')),'Restored role list');[...document.querySelectorAll('.character-row')].find(item=>item.textContent.includes('Archive renderer role')).click();await wait(()=>button('编辑角色'),'Restored details');button('编辑角色').click();await wait(()=>document.querySelector('#form_create [name=avatar_url]').value===${JSON.stringify(imported.avatar)},'Restored editor');$('#form_create [name=description]').val('Unsubmitted CHARX role draft').trigger('input');`);
  guard = installDesktopCloseGuard(window, { beforeClose: async () => {}, onError: error => { throw error; } }); assert.equal(await guard.requestClose(), true);
  const oldOrigin = origin; await service.close(); await startService(); assert.notEqual(origin, oldOrigin); await openWindow();
  await evaluate(`nav('角色库');await wait(()=>document.querySelector('.character-row .character-avatar img')?.complete&&document.querySelector('.character-row .character-avatar img')?.naturalWidth>0,'Artwork after full restart');check((await fetch('/api/characters/${imported.id}').then(result=>result.json())).description==='Archive replacement setting','Unsubmitted draft not committed');await core.getCharacters();const avatar=${JSON.stringify(imported.avatar)};const found=core.characters.findIndex(item=>item.avatar===avatar);await core.selectCharacterById(found);await wait(()=>document.querySelector('#form_create [name=description]').value==='Unsubmitted CHARX role draft','Persisted CHARX role draft');`);
  const after = await service.inject({ method: 'GET', url: `/api/characters/${imported.id}/export?format=charx` }); assert.deepEqual((await parseCharacterArchive(after.rawPayload)).assets, parsed.assets);
  recordStage('actual-close-new-service-port-and-profile-restart-keep-jpeg-assets-and-character-draft');
  const png = await download(`nav('角色库');await wait(()=>document.querySelector('a[href="/api/characters/${imported.id}/export?format=png"]'),'PNG export link');document.querySelector('a[href="/api/characters/${imported.id}/export?format=png"]').click();`);
  const parsedPng = parseCharacterCardPngDocument(readFileSync(png.path));
  assert.deepEqual(parsedPng.card.customTop, card.customTop); assert.equal(parsedPng.card.data.assets[0].uri, '__asset:assets/icon/main.jpg');
  assert.equal(parsedPng.card.data.assets[2].uri, card.data.assets[2].uri);
  for (const [path, bytes] of parsed.assets) assert.deepEqual(Buffer.from(parsedPng.assets.get(path)), bytes);
  await evaluate(`await choose(${JSON.stringify(readFileSync(png.path).toString('base64'))},'assets-roundtrip.png');await wait(()=>document.querySelector('#preview-title'),'PNG asset preview');check(document.querySelector('.preview-inspector').textContent.includes('实际识别 4 个文件'),'PNG actual assets');button('导入独立副本').click();await wait(()=>!document.querySelector('#preview-title'),'PNG copy imported');`);
  const pngRole = (await service.inject({ method: 'GET', url: '/api/characters' })).json().items.find(item => item.id !== imported.id);
  assert.equal(pngRole.sourceFormat, 'ccv3-png');
  const pngToCharx = await service.inject({ method: 'GET', url: `/api/characters/${pngRole.id}/export?format=charx` });
  assert.deepEqual((await parseCharacterArchive(pngToCharx.rawPayload)).assets, parsed.assets);
  recordStage('native-png-asset-download-real-reimport-and-charx-byte-roundtrip');
  const newPortrait = nativeImage.createFromBitmap(Buffer.from([255,0,255,255,255,255,0,255,0,255,255,255,10,20,30,255]), { width: 2, height: 2 }).toPNG();
  await evaluate(`button('编辑角色').click();await wait(()=>document.querySelector('#form_create [name=avatar_url]').value===${JSON.stringify(pngRole.avatar)},'PNG copy editor');await choose(${JSON.stringify(newPortrait.toString('base64'))},'new-portrait.png',document.querySelector('#form_create input[name=avatar]'));button('保存角色').click();await wait(async()=> (await fetch('/api/characters/${pngRole.id}').then(result=>result.json())).updatedAt!==${JSON.stringify(pngRole.updatedAt)},'Portrait actually saved');`);
  const newArchive = await service.inject({ method: 'GET', url: `/api/characters/${pngRole.id}/export?format=charx` }), newParsed = await parseCharacterArchive(newArchive.rawPayload);
  const newIcon = newParsed.card.data.assets.find(item => item.type === 'icon' && item.name === 'main');
  assert.equal(newIcon.uri, 'embeded://assets/icon/main.png'); assert.equal(newIcon.ext, 'png');
  assert.deepEqual(newParsed.assets.get('assets/icon/main.png'), newPortrait);
  for (const [path, bytes] of parsed.assets) assert.deepEqual(newParsed.assets.get(path), bytes);
  assert.deepEqual((await service.inject({ method: 'GET', url: `/characters/${pngRole.avatar}` })).rawPayload, newPortrait);
  const newPng = await service.inject({ method: 'GET', url: `/api/characters/${pngRole.id}/export?format=png` }), newPngParsed = parseCharacterCardPngDocument(newPng.rawPayload);
  assert.equal(newPngParsed.card.data.assets.find(item => item.type === 'icon' && item.name === 'main').uri, '__asset:assets/icon/main.png');
  for (const [path, bytes] of newParsed.assets) assert.deepEqual(Buffer.from(newPngParsed.assets.get(path)), bytes);
  recordStage('actual-portrait-save-synchronizes-main-icon-and-retains-all-auxiliary-assets-in-png-and-charx');
  const jpegPortrait = nativeImage.createFromBitmap(Buffer.from(Array.from({length:6*9*4},(_,index)=>index%4===3?255:[20,80,180][index%4])), { width: 6, height: 9 }).toJPEG(90);
  const jpegConverted = await evaluate(`await choose(${JSON.stringify(jpegPortrait.toString('base64'))},'jpeg-portrait.jpg',document.querySelector('#form_create input[name=avatar]'));await wait(()=>document.querySelector('#form_create input[name=avatar]').files[0]?.type==='image/png','JPEG converted for same editor');const file=document.querySelector('#form_create input[name=avatar]').files[0];return [...new Uint8Array(await file.arrayBuffer())];`);
  assert.deepEqual(nativeImage.createFromBuffer(Buffer.from(jpegConverted)).getSize(), {width:6,height:9});
  const jpegDraftGuard = installDesktopCloseGuard(window, { beforeClose: async () => {}, onError: error => { throw error; } }); assert.equal(await jpegDraftGuard.requestClose(), true);
  const portraitOrigin = origin; await service.close(); await startService(); assert.notEqual(origin,portraitOrigin); await openWindow();
  await evaluate(`await core.getCharacters();await core.selectCharacterById(core.characters.findIndex(item=>item.avatar===${JSON.stringify(pngRole.avatar)}));await wait(()=>document.querySelector('#form_create input[name=avatar]').files[0]?.name==='jpeg-portrait.png','Converted JPEG draft survives actual restart');await wait(()=>document.querySelector('#avatar_load_preview').src.startsWith('data:image/png'),'Actual restored draft image');`);
  const restoredJpegDraft = await evaluate(`return [...new Uint8Array(await document.querySelector('#form_create input[name=avatar]').files[0].arrayBuffer())];`);
  assert.deepEqual(Buffer.from(restoredJpegDraft),Buffer.from(jpegConverted));
  assert.deepEqual((await service.inject({method:'GET',url:`/characters/${pngRole.avatar}`})).rawPayload,newPortrait);
  await evaluate(`button('保存角色').click();await wait(async()=>{const bytes=new Uint8Array(await fetch('/characters/${pngRole.avatar}').then(result=>result.arrayBuffer()));return bytes.length===${jpegConverted.length}&&bytes[0]===137;},'Actual JPEG-derived PNG saved');`);
  assert.deepEqual((await service.inject({method:'GET',url:`/characters/${pngRole.avatar}`})).rawPayload,Buffer.from(jpegConverted));
  recordStage('actual-jpeg-to-png-draft-pixels-survive-close-restart-without-early-commit');
  const webpConverted = await evaluate(`const canvas=document.createElement('canvas');canvas.width=6;canvas.height=9;canvas.getContext('2d').fillStyle='#20a040';canvas.getContext('2d').fillRect(0,0,6,9);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',1));check(blob.type==='image/webp','Real Chromium WebP fixture');const encoded=btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));await choose(encoded,'webp-portrait.webp',document.querySelector('#form_create input[name=avatar]'));await wait(()=>document.querySelector('#form_create input[name=avatar]').files[0]?.name==='webp-portrait.png','WebP converted');return [...new Uint8Array(await document.querySelector('#form_create input[name=avatar]').files[0].arrayBuffer())];`);
  assert.deepEqual(nativeImage.createFromBuffer(Buffer.from(webpConverted)).getSize(),{width:6,height:9});
  await evaluate(`window.archiveFixture.beforeCrop=document.querySelector('#form_create input[name=avatar]').files[0];button('裁剪头像').click();await wait(()=>document.querySelector('.popup-crop-image')&&$('.popup-crop-image').data('cropper')?.getImageData().naturalWidth===6,'Actual cropper ready');button('取消',document.querySelector('dialog[open]')).click();await wait(()=>!document.querySelector('dialog[open]'),'Cancelled crop closed');check(document.querySelector('#form_create input[name=avatar]').files[0]===window.archiveFixture.beforeCrop,'Cancel preserves prepared portrait');button('裁剪头像').click();await wait(()=>$('.popup-crop-image').data('cropper')?.getImageData().naturalWidth===6,'Cropper reopened');$('.popup-crop-image').data('cropper').setData({x:1,y:2,width:4,height:6});button('应用裁剪',document.querySelector('dialog[open]')).click();await wait(()=>!document.querySelector('dialog[open]')&&document.querySelector('#form_create input[name=avatar]').files[0]!==window.archiveFixture.beforeCrop,'Crop applied to actual file');`);
  const cropped = Buffer.from(await evaluate(`return [...new Uint8Array(await document.querySelector('#form_create input[name=avatar]').files[0].arrayBuffer())];`));
  assert.deepEqual(nativeImage.createFromBuffer(cropped).getSize(),{width:4,height:6});
  const originalWebpPixel = nativeImage.createFromBuffer(Buffer.from(webpConverted)).toBitmap().subarray(0,4), cropPixels = nativeImage.createFromBuffer(cropped).toBitmap();
  for (let index=0;index<cropPixels.length;index+=4) assert.deepEqual(cropPixels.subarray(index,index+4),originalWebpPixel);
  await evaluate(`const before=(await fetch('/api/characters/${pngRole.id}').then(result=>result.json())).updatedAt;button('保存角色').click();await wait(async()=> (await fetch('/api/characters/${pngRole.id}').then(result=>result.json())).updatedAt!==before,'Cropped WebP saved');`);
  const croppedArchive = await parseCharacterArchive((await service.inject({method:'GET',url:`/api/characters/${pngRole.id}/export?format=charx`})).rawPayload);
  const croppedIcon = croppedArchive.card.data.assets.find(item=>item.type==='icon'&&item.name==='main');
  assert.deepEqual(croppedArchive.assets.get(croppedIcon.uri.slice('embeded://'.length)),cropped);
  recordStage('actual-webp-to-png-crop-cancel-and-4-by-6-save-roundtrip');
  const legacyYaml=Buffer.from('name: YAML legacy renderer\ndescription: |\n  Legacy original paragraph\n  Second line\nfirst_mes: Legacy greeting\ncustomUnknown:\n  keep: true\n');
  await evaluate(`nav('角色库');await choose(${JSON.stringify(legacyYaml.toString('base64'))},'legacy.yaml');await wait(()=>document.querySelector('#preview-title')?.textContent==='YAML legacy renderer','Real YAML preview');check(document.querySelector('.preview-inspector').textContent.includes('旧格式会转换为 V2'),'Legacy warning rendered');button('确认导入').click();await wait(()=>document.querySelector('#character-detail-title')?.textContent==='YAML legacy renderer','Actual YAML saved');`);
  const yamlRole=(await service.inject({method:'GET',url:'/api/characters'})).json().items.find(item=>item.name==='YAML legacy renderer');assert.equal(yamlRole.sourceFormat,'tavern-yaml');
  const yamlExport=(await service.inject({method:'GET',url:`/api/characters/${yamlRole.id}/export?format=json`})).json();assert.deepEqual(yamlExport.customUnknown,{keep:true});assert.equal(yamlExport.data.first_mes,'Legacy greeting');
  recordStage('actual-yaml-file-preview-legacy-warning-and-v2-export-preserve-unknown-fields');
  const byaf = await byafFixture();
  await evaluate(`nav('角色库');await choose(${JSON.stringify(byaf.bytes.toString('base64'))},'cartographer.byaf');await wait(()=>document.querySelector('#preview-title')?.textContent==='Cartographer','Real BYAF preview');check(document.querySelector('.preview-inspector').textContent.includes('2 个故事'),'Actual BYAF scenario count');check(!(await fetch('/api/conversations').then(result=>result.json())).items.some(item=>item.title==='First'),'Preview has no story writes');button('确认导入').click();await wait(()=>document.querySelector('#character-detail-title')?.textContent==='Cartographer','Actual BYAF saved');await wait(()=>[...document.querySelectorAll('button[data-conversation-id] strong')].filter(item=>item.textContent==='First'||item.textContent==='Second').length===2,'Both imported stories immediately visible before navigation or restart');nav('故事');`);
  const byafRole = (await service.inject({ method: 'GET', url: '/api/characters' })).json().items.find(item => item.name === 'Cartographer');
  assert.equal(byafRole.sourceFormat, 'backyard-byaf');
  const byafStories = (await service.inject({ method: 'GET', url: '/api/conversations' })).json().items.filter(item => item.characterId === byafRole.id);
  assert.equal(byafStories.length, 2);
  for (const story of byafStories) {
    const state = await evaluate(`document.querySelector('button[data-conversation-id="${story.id}"]').click();await wait(()=>core.getCurrentChatId()===${JSON.stringify(story.id)}&&document.querySelectorAll('#chat .mes_text').length===3,'Actual imported story opened');check(document.querySelector('#chat').textContent.includes(${JSON.stringify(story.title + ' greeting')}),'Matching greeting');const context=core.getContext();check(context.chat[2].mes==='New harbor','Selected output rendered');check(document.querySelectorAll('#chat .mes_text')[2].textContent==='New harbor','Actual selected output DOM');return {swipes:context.chat[2].swipes,swipe_id:context.chat[2].swipe_id,source:context.chat[2].byaf_source_message,metadata:context.chatMetadata};`);
    assert.deepEqual(state.swipes, ['Old harbor', 'New harbor']); assert.equal(state.swipe_id, 1);
    assert.deepEqual(state.source.unknownMessage, { kept: true }); assert.equal(state.source.outputs.length, 2);
    assert.equal(state.metadata.scenario, story.title + ' narrative'); assert.equal(state.metadata.system_prompt, 'Answer as {{char}}');
  }
  recordStage('actual-byaf-file-preview-and-immediate-two-story-navigation-preserve-selected-output-swipes-and-source');
  const byafBackup = await download(`document.querySelector('button[aria-label="设置"]').click();await wait(()=>button('导出完整备份'),'BYAF backup entry');button('导出完整备份').click();`);
  const byafPayload = JSON.parse(readFileSync(byafBackup.path, 'utf8'));
  for (const [path, bytes] of byaf.files) assert.equal(byafPayload.characters.find(item => item.id === byafRole.id).assets[path], bytes.toString('base64'));
  for (const story of byafStories) assert(byafPayload.conversations.some(item => item.id === story.id));
  const byafRestoreLoaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve));
  await evaluate(`core.getContext().chat[2].mes='Changed after BYAF backup';core.getContext().chatMetadata.changedAfterBackup=true;await core.saveChatConditional();check((await fetch('/api/conversations/'+core.getCurrentChatId()).then(result=>result.json())).messages[2].content==='Changed after BYAF backup','Actual story changed before restore');await choose(${JSON.stringify(Buffer.from(JSON.stringify(byafPayload)).toString('base64'))},'byaf-full-backup.json',document.querySelector('input[aria-label="选择备份文件"]'));await wait(()=>document.querySelector('select[aria-label="恢复冲突处理"]'),'BYAF restore choices');edit(document.querySelector('select[aria-label="恢复冲突处理"]'),'overwrite');await new Promise(requestAnimationFrame);await wait(()=>button('确认恢复')&&!button('确认恢复').disabled,'BYAF restore ready');button('确认恢复').click();`);
  await byafRestoreLoaded; await ready();
  for (const story of byafStories) {
    const restored = (await service.inject({ method: 'GET', url: '/api/conversations/' + story.id })).json();
    assert.deepEqual(restored.messages.map(item => item.content), [story.title + ' greeting', 'Where?', 'New harbor']);
    assert.deepEqual(restored.messages[2].extensionData.swipes, ['Old harbor', 'New harbor']); assert.equal(restored.messages[2].extensionData.swipe_id, 1);
    await evaluate(`nav('故事');await wait(()=>document.querySelector('button[data-conversation-id="${story.id}"]'),'Restored story visible');document.querySelector('button[data-conversation-id="${story.id}"]').click();await wait(()=>core.getCurrentChatId()===${JSON.stringify(story.id)}&&core.getContext().chat[2]?.mes==='New harbor','Restored BYAF story host');`);
  }
  const byafArchive = await parseCharacterArchive((await service.inject({ method: 'GET', url: '/api/characters/' + byafRole.id + '/export?format=charx' })).rawPayload);
  for (const [path, bytes] of byaf.files) assert.deepEqual(byafArchive.assets.get(path), bytes);
  recordStage('native-byaf-full-backup-and-real-overwrite-restore-preserve-two-stories-swipes-and-all-source-files');
  const inlinePng = nativeImage.createFromBuffer(icon).toPNG(), inlineUri = 'data:image/png;base64,' + inlinePng.toString('base64');
  const inlineAudioUri = 'data:audio/wav;base64,' + audio.toString('base64');
  const inlineCard = structuredClone(card); inlineCard.data.name = 'Inline data URI renderer';
  inlineCard.data.assets = [{ type: 'icon', name: 'main', ext: 'png', uri: inlineUri }, { type: 'audio', name: 'greeting', ext: 'wav', uri: inlineAudioUri }];
  await evaluate(`nav('角色库');await choose(${JSON.stringify(Buffer.from(JSON.stringify(inlineCard)).toString('base64'))},'inline-data-uri.json');await wait(()=>document.querySelector('#preview-title')?.textContent==='Inline data URI renderer','Actual inline JSON preview');check(document.querySelector('.preview-inspector').textContent.includes('实际识别 2 个文件'),'Both inline assets actually recognized');button('确认导入').click();await wait(()=>document.querySelector('#character-detail-title')?.textContent==='Inline data URI renderer','Actual inline card imported');`);
  const inlineRole = (await service.inject({ method: 'GET', url: '/api/characters' })).json().items.find(item => item.name === inlineCard.data.name);
  await evaluate(`await wait(()=>[...document.images].some(image=>image.src.includes('/characters/'+encodeURIComponent(${JSON.stringify(inlineRole.avatar)}))&&image.complete&&image.naturalWidth===${nativeImage.createFromBuffer(inlinePng).getSize().width}),'Actual inline avatar decoded');`);
  assert.deepEqual((await service.inject({ method: 'GET', url: '/characters/' + inlineRole.avatar })).rawPayload, inlinePng);
  const inlineJson = await download(`document.querySelector('a[href="/api/characters/${inlineRole.id}/export?format=json"]').click();`);
  assert.deepEqual(JSON.parse(readFileSync(inlineJson.path, 'utf8')), inlineCard);
  const inlineCharx = await download(`document.querySelector('a[href="/api/characters/${inlineRole.id}/export?format=charx"]').click();`);
  const inlineArchive = await parseCharacterArchive(readFileSync(inlineCharx.path));
  assert.deepEqual(inlineArchive.card, inlineCard);
  for (const [uri, extension, bytes] of [[inlineUri, 'png', inlinePng], [inlineAudioUri, 'wav', audio]]) assert.deepEqual(inlineArchive.assets.get(inlineCharacterAssetPath(uri, extension)), bytes);
  const inlinePngDownload = await download(`document.querySelector('a[href="/api/characters/${inlineRole.id}/export?format=png"]').click();`);
  const inlinePngCard = parseCharacterCardPngDocument(readFileSync(inlinePngDownload.path));
  for (const [uri, extension, bytes] of [[inlineUri, 'png', inlinePng], [inlineAudioUri, 'wav', audio]]) {
    const path = inlineCharacterAssetPath(uri, extension); assert(inlinePngCard.card.data.assets.some(asset => asset.uri === '__asset:' + path)); assert.deepEqual(Buffer.from(inlinePngCard.assets.get(path)), bytes);
  }
  recordStage('actual-inline-data-uri-json-file-preview-avatar-and-native-json-png-charx-exact-asset-downloads');
  const inlineBackup = await download(`document.querySelector('button[aria-label="设置"]').click();await wait(()=>button('导出完整备份'),'Inline backup entry');button('导出完整备份').click();`);
  const inlineBackupPayload = JSON.parse(readFileSync(inlineBackup.path, 'utf8'));
  const inlineBackupCharacter = inlineBackupPayload.characters.find(item => item.id === inlineRole.id);
  assert.equal(inlineBackupCharacter.assets[inlineCharacterAssetPath(inlineUri, 'png')], inlinePng.toString('base64'));
  assert.equal(inlineBackupCharacter.assets[inlineCharacterAssetPath(inlineAudioUri, 'wav')], audio.toString('base64'));
  await evaluate(`nav('角色库');await wait(()=>document.querySelector('#character-detail-title')?.textContent==='Inline data URI renderer','Inline selected role');button('编辑角色').click();await wait(()=>document.querySelector('#form_create [name=avatar_url]').value===${JSON.stringify(inlineRole.avatar)},'Inline actual editor');edit(document.querySelector('#form_create [name=description]'),'Changed inline card after backup');button('保存角色').click();await wait(async()=>(await fetch('/api/characters/${inlineRole.id}').then(response=>response.json())).description==='Changed inline card after backup','Actual card modified before restore');document.querySelector('button[aria-label="设置"]').click();`);
  const inlineRestoredLoad = new Promise(resolve => window.webContents.once('did-finish-load', resolve));
  await evaluate(`await choose(${JSON.stringify(Buffer.from(JSON.stringify(inlineBackupPayload)).toString('base64'))},'inline-full-backup.json',document.querySelector('input[aria-label="选择备份文件"]'));await wait(()=>document.querySelector('select[aria-label="恢复冲突处理"]'),'Inline actual restore strategy');edit(document.querySelector('select[aria-label="恢复冲突处理"]'),'overwrite');await new Promise(requestAnimationFrame);await wait(()=>button('确认恢复')&&!button('确认恢复').disabled,'Inline restore ready');button('确认恢复').click();`);
  await inlineRestoredLoad; await ready();
  const restoredInlineArchive = await parseCharacterArchive((await service.inject({ method: 'GET', url: `/api/characters/${inlineRole.id}/export?format=charx` })).rawPayload);
  assert.deepEqual(restoredInlineArchive.card, inlineCard); assert.deepEqual(restoredInlineArchive.assets, inlineArchive.assets);
  recordStage('native-inline-full-backup-and-real-ui-overwrite-restore-keep-original-uri-and-all-bytes');
  const inlineCloseGuard = installDesktopCloseGuard(window, { beforeClose: async () => {}, onError: error => { throw error; } }); assert.equal(await inlineCloseGuard.requestClose(), true);
  const inlineOrigin = origin; await service.close(); await startService(); assert.notEqual(origin, inlineOrigin); await openWindow();
  await evaluate(`nav('角色库');await wait(()=>[...document.querySelectorAll('.character-row')].some(row=>row.textContent.includes('Inline data URI renderer')),'Inline role in reopened real library');[...document.querySelectorAll('.character-row')].find(row=>row.textContent.includes('Inline data URI renderer')).click();await wait(()=>document.querySelector('#character-detail-title')?.textContent==='Inline data URI renderer'&&[...document.images].some(image=>image.src.includes('/characters/'+encodeURIComponent(${JSON.stringify(inlineRole.avatar)}))&&image.complete&&image.naturalWidth===${nativeImage.createFromBuffer(inlinePng).getSize().width}),'Inline actual avatar after new port restart');`);
  assert.deepEqual((await service.inject({ method: 'GET', url: '/characters/' + inlineRole.avatar })).rawPayload, inlinePng);
  assert.deepEqual((await parseCharacterArchive((await service.inject({ method: 'GET', url: `/api/characters/${inlineRole.id}/export?format=charx` })).rawPayload)).assets, inlineArchive.assets);
  recordStage('actual-inline-card-close-new-service-port-restart-reopens-original-avatar-uri-and-asset-bytes');
  const report = { passed: true, checkedAt: new Date().toISOString(), label, profile, stages, downloads, expectedArtworkType: 'image/jpeg', completeC01: false };
  await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' }); console.log(JSON.stringify({ passed: report.passed, checkedAt: report.checkedAt, label, stages: stages.length, reportPath }));
} catch (error) {
  let diagnostics; try { diagnostics = await window.webContents.executeJavaScript('({text:document.body.innerText,images:[...document.images].map(item=>({src:item.src,complete:item.complete,width:item.naturalWidth}))})'); } catch {}
  await writeFile(reportPath, JSON.stringify({ passed: false, checkedAt: new Date().toISOString(), label, profile, stages, error: error.stack || String(error), diagnostics }, null, 2), { flag: 'wx' }); console.error(error); process.exitCode = 1;
} finally { clearTimeout(deadline); for (const item of windows) if (!item.isDestroyed()) item.destroy(); await service?.close(); app.exit(process.exitCode || 0); } }
void verify();
