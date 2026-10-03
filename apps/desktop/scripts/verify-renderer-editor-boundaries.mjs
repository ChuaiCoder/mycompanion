// Actual React/editor error and preview boundary checks; private temporary profile.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, nativeImage } from 'electron';
import { bindBrowserPort, buildApp } from '../../local-service/dist/app.js';
import { installDesktopCloseGuard } from '../dist/desktop-close.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const profile = mkdtempSync(join(tmpdir(), 'mycompanion-editor-boundaries-'));
const databasePath = join(profile, 'profile.sqlite');
const label = process.argv.find(value => value.startsWith('--label='))?.slice(8) ?? new Date().toISOString().replace(/[^a-z0-9]/gi, '-');
const mode = process.argv.find(value => value.startsWith('--case='))?.slice(7) ?? 'all';
assert(/^[a-z0-9-]{1,90}$/i.test(label)); assert(['all', 'portrait', 'preview'].includes(mode));
const reportPath = join(root, '.cache/reports/renderer-editor-boundaries-' + label + '.json'); mkdirSync(dirname(reportPath), { recursive: true });
app.setPath('userData', profile); app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
const windows = [], stages = [];
let service, window, origin, failNextSave = false;
const deadline = setTimeout(() => { writeFileSync(reportPath, JSON.stringify({ passed: false, checkedAt: new Date().toISOString(), label, profile, mode, stages, error: 'Editor boundary verification deadline exceeded' }, null, 2), { flag: 'wx' }); app.exit(1); }, 65_000);
function stage(value) { stages.push(value); console.log('Passed: ' + value); }
async function harness() {
  const script = await import('/script.js'), compat = await import('/plugin-runtime/compat-runtime.js');
  const core = { ...script, getContext: compat.getContext };
  const host = await import('/plugin-runtime/desktop-host.js'); await host.start();
  const wait = async (predicate, label) => { const until = Date.now() + 6500; while (!await predicate()) { if (Date.now() > until) throw new Error('Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 20)); } };
  const check = (value, label) => { if (!value) throw new Error(label); };
  const button = name => [...document.querySelectorAll('button')].find(item => item.textContent.trim() === name);
  const nav = name => [...document.querySelectorAll('nav button')].find(item => item.textContent.trim().startsWith(name)).click();
  const choose = async (encoded, name) => { const bytes = Uint8Array.from(atob(encoded), value => value.charCodeAt(0)), transfer = new DataTransfer(); transfer.items.add(new File([bytes], name)); const input = document.querySelector('#form_create input[name=avatar]'); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(requestAnimationFrame); };
  await wait(() => document.querySelector('.service-state--online') && document.querySelector('#form_create') && window.__mycompanionFlushDrafts, 'connected application');
  window.editorBoundary = { core, wait, check, button, nav, choose };
}
const evaluate = body => window.webContents.executeJavaScript(`(async()=>{const {core,wait,check,button,nav,choose}=window.editorBoundary;${body}})()`);
async function start() {
  service = buildApp({ databasePath, rendererRoot: join(root, 'apps/renderer/dist') });
  service.addHook('preHandler', async (request, reply) => {
    if (failNextSave && request.url === '/api/characters/edit') { failNextSave = false; return reply.code(503).send({ error: { code: 'BOUNDARY_FIXTURE', message: 'Temporary portrait save failure' } }); }
  });
  origin = await bindBrowserPort(port => service.listen({ host: '127.0.0.1', port }));
}
async function open() {
  window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } }); windows.push(window);
  await window.loadURL(origin); await window.webContents.executeJavaScript(`(${harness.toString()})()`);
}
async function verify() { try {
  await app.whenReady(); await start(); await open();
  const fixtures = await evaluate(`const roles=[];for(const name of ['Boundary A','Boundary B']){const data=new FormData();data.set('ch_name',name);data.set('first_mes',name+' greeting');const response=await fetch('/api/characters/create',{method:'POST',body:data});check(response.ok,'Create real role');roles.push(await response.text());}await core.getCharacters();await core.selectCharacterById(core.characters.findIndex(item=>item.avatar===roles[0]));await wait(()=>document.querySelector('#form_create [name=avatar_url]').value===roles[0],'Role A editor');return {avatars:roles,storyId:core.getCurrentChatId()};`);
  if (mode !== 'preview') {
    const portrait = nativeImage.createFromBitmap(Buffer.from([20,80,180,255,20,80,180,255,20,80,180,255,20,80,180,255]), { width: 2, height: 2 }).toPNG();
    await evaluate(`const original=Image.prototype.decode;let delayOne=true;window.editorBoundary.decodeOriginal=original;Image.prototype.decode=function(...args){if(delayOne){delayOne=false;return new Promise((_resolve,reject)=>window.editorBoundary.rejectOld=()=>reject(new Error('Delayed invalid portrait')));}return original.apply(this,args);};await choose(btoa('invalid jpeg'),'old-invalid.jpg');await choose(${JSON.stringify(portrait.toString('base64'))},'current-valid.png');await wait(()=>document.querySelector('#form_create input[name=avatar]').files[0]?.name==='current-valid.png','Valid later portrait ready');window.editorBoundary.rejectOld();await new Promise(resolve=>setTimeout(resolve,80));Image.prototype.decode=original;check(!document.querySelector('#form_create [data-character-error]').textContent,'Late old portrait failure must not overwrite latest valid image');check(document.querySelector('#form_create input[name=avatar]').files[0]?.name==='current-valid.png','Latest valid file stays selected');`);
    stage('delayed-invalid-portrait-does-not-overwrite-new-valid-selection-or-error-state');
    const before = (await service.inject({ method: 'GET', url: '/characters/' + fixtures.avatars[0] })).rawPayload;
    failNextSave = true;
    await evaluate(`button('保存角色').click();await wait(()=>document.querySelector('#form_create [data-character-error]').textContent.includes('503'),'Real save failure shown');check(document.querySelector('#form_create input[name=avatar]').files[0]?.name==='current-valid.png','Failed save retains prepared portrait');`);
    assert.deepEqual((await service.inject({ method: 'GET', url: '/characters/' + fixtures.avatars[0] })).rawPayload, before);
    await evaluate(`button('保存角色').click();await wait(()=>document.querySelector('#form_create [data-character-status]').textContent==='已保存'&&!document.querySelector('#form_create input[name=avatar]').files.length,'Real same-file retry saves');`);
    const savedPortrait = nativeImage.createFromBuffer((await service.inject({ method: 'GET', url: '/characters/' + fixtures.avatars[0] })).rawPayload);
    assert.deepEqual(savedPortrait.getSize(), { width: 2, height: 2 }); assert.deepEqual(savedPortrait.toBitmap(), nativeImage.createFromBuffer(portrait).toBitmap());
    stage('actual-http-503-keeps-original-avatar-and-prepared-file-then-retry-saves-exact-raster');
    await evaluate(`await choose(btoa('invalid webp'),'invalid.webp');await wait(()=>document.querySelector('#form_create [data-character-error]').textContent.includes('有效的 PNG、JPEG 或 WebP'),'Current malformed image has actionable error');check(!document.querySelector('#form_create input[name=avatar]').files.length,'Invalid file never replaces saved portrait');await choose(${JSON.stringify(portrait.toString('base64'))},'recovered.png');await wait(()=>!document.querySelector('#form_create [data-character-error]').textContent&&document.querySelector('#form_create input[name=avatar]').files[0]?.name==='recovered.png','Valid image recovers from decode error');`);
    stage('actual-invalid-webp-rejection-preserves-saved-avatar-and-valid-reselection-recovers');
    await evaluate(`const role=core.characters.find(item=>item.avatar===${JSON.stringify(fixtures.avatars[1])});const second=await fetch('/api/conversations',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({characterId:role.id})}).then(result=>result.json());check(second.id,'Other story actually created');const original=Image.prototype.decode;let delayOne=true;Image.prototype.decode=function(...args){if(delayOne){delayOne=false;return new Promise((_resolve,reject)=>window.editorBoundary.rejectNavigated=()=>reject(new Error('Old role delayed invalid portrait')));}return original.apply(this,args);};await choose(btoa('invalid'),'old-role.jpg');nav('角色库');await new Promise(requestAnimationFrame);nav('故事');await wait(()=>document.querySelector('button[data-conversation-id="'+second.id+'"]'),'Other real story in list');document.querySelector('button[data-conversation-id="'+second.id+'"]').click();await wait(()=>document.querySelector('#form_create [name=avatar_url]').value===${JSON.stringify(fixtures.avatars[1])},'Actual different role editor');window.editorBoundary.rejectNavigated();await new Promise(resolve=>setTimeout(resolve,80));Image.prototype.decode=original;check(!document.querySelector('#form_create [data-character-error]').textContent,'Old role failure cannot write new role error');document.querySelector('button[data-conversation-id="${fixtures.storyId}"]').click();await wait(()=>document.querySelector('#form_create [name=avatar_url]').value===${JSON.stringify(fixtures.avatars[0])},'Return to role A');check(document.querySelector('#form_create input[name=avatar]').files[0]?.name==='recovered.png','Earlier valid draft remains after failed old decode and navigation');`);
    stage('delayed-old-role-decode-error-cannot-overwrite-another-story-role-or-valid-draft');
  }
  if (mode !== 'portrait') {
    await evaluate(`const context=core.getContext();context.chat.push({id:crypto.randomUUID(),mes:'Boundary question',is_user:true},{id:crypto.randomUUID(),mes:'PREVIEW_ORIGINAL_REPLY',is_user:false});await core.saveChatConditional();nav('故事');document.querySelector('.prompt-preview > summary').click();await wait(()=>document.querySelector('.prompt-preview__body'),'Real original preview ready');[...document.querySelectorAll('.prompt-preview__message summary')].forEach(item=>item.click());await wait(()=>document.querySelector('.prompt-preview').textContent.includes('PREVIEW_ORIGINAL_REPLY'),'Original request history visible');`);
    const modified = await evaluate(`const context=core.getContext(),last=context.chat.at(-1);const result=await fetch('/api/conversations/'+context.conversationId+'/messages/'+last.id,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({content:'PREVIEW_NEW_BRANCH_REPLY'})}).then(response=>response.json());await core.reloadCurrentChat();return result;`);
    await evaluate(`await wait(()=>!document.querySelector('.prompt-preview').textContent.includes('PREVIEW_ORIGINAL_REPLY'),'Old branch preview cleared without changing draft');await wait(()=>document.querySelector('.prompt-preview__body'),'New branch preview ready automatically');[...document.querySelectorAll('.prompt-preview__message summary')].forEach(item=>item.click());await wait(()=>document.querySelector('.prompt-preview').textContent.includes('PREVIEW_NEW_BRANCH_REPLY'),'New branch automatically reflected in actual request preview');check(core.getContext().branchId===${JSON.stringify(modified.branchId)},'Actual branch changed');`);
    stage('same-story-actual-branch-edit-automatically-refreshes-open-preview-with-unchanged-draft');
    await evaluate(`core.getContext().chat.at(-1).mes='PREVIEW_SAME_BRANCH_SWIPE';await core.saveChatConditional();await wait(()=>!document.querySelector('.prompt-preview').textContent.includes('PREVIEW_NEW_BRANCH_REPLY'),'Old same-branch preview cleared');await wait(()=>document.querySelector('.prompt-preview__body'),'Same-branch saved message preview refreshed');[...document.querySelectorAll('.prompt-preview__message summary')].forEach(item=>item.click());await wait(()=>document.querySelector('.prompt-preview').textContent.includes('PREVIEW_SAME_BRANCH_SWIPE'),'Saved same-branch content automatically visible');`);
    stage('same-branch-host-save-automatically-refreshes-open-preview-after-message-selection');
  }
  const guard = installDesktopCloseGuard(window, { beforeClose: async () => {}, onError: error => { throw error; } }); assert.equal(await guard.requestClose(), true);
  const previous = origin; await service.close(); await start(); assert.notEqual(previous, origin); await open();
  await evaluate(`nav('故事');await wait(()=>document.querySelector('button[data-conversation-id="${fixtures.storyId}"]'),'Saved story survives new port restart');document.querySelector('button[data-conversation-id="${fixtures.storyId}"]').click();await wait(()=>core.getCurrentChatId()===${JSON.stringify(fixtures.storyId)},'Saved story opens after actual restart');${mode !== 'portrait' ? "check(core.getContext().chat.at(-1).mes==='PREVIEW_SAME_BRANCH_SWIPE','Latest same-branch content survives restart');" : ''}`);
  stage('actual-close-new-port-and-profile-restart-preserve-saved-story-and-content');
  await writeFile(reportPath, JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), label, mode, profile, stages, completeC01: false, completeU05: false }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ passed: true, label, stages: stages.length, reportPath }));
} catch(error) {
  let diagnostics; try { diagnostics = await window.webContents.executeJavaScript('document.body.innerText'); } catch {}
  await writeFile(reportPath, JSON.stringify({ passed: false, checkedAt: new Date().toISOString(), label, mode, profile, stages, error: error.stack || String(error), diagnostics }, null, 2), { flag: 'wx' }); console.error(error); process.exitCode = 1;
} finally { clearTimeout(deadline); for(const item of windows) if(!item.isDestroyed()) item.destroy(); await service?.close(); app.exit(process.exitCode || 0); } }
void verify();
