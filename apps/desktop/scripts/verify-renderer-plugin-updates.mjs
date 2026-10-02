// Actual React controls, extension modules and Git smart HTTP in an isolated desktop profile.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';
import { bindBrowserPort, buildApp } from '../../local-service/dist/app.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const temporary = mkdtempSync(join(tmpdir(), 'mycompanion-renderer-plugin-updates-'));
const work = join(temporary, 'work'), bare = join(temporary, 'fixture.git');
const label = process.argv.find(value => value.startsWith('--label='))?.slice(8) ?? new Date().toISOString().replace(/[^a-z0-9]/gi, '-');
assert(/^[a-z0-9-]{1,90}$/i.test(label));
const reportPath = join(root, '.cache/reports/renderer-plugin-updates-' + label + '.json');
mkdirSync(dirname(reportPath), { recursive: true });
app.setPath('userData', join(temporary, 'profile')); app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
let service, window, sourceUrl, offline = false, loadRevision = 0, handledLoadRevision = 0;
const stages = [], revisions = [], consoleErrors = [];
const report = { passed: false, scope: 'Source Electron with actual React, SQLite, JS hooks and disposable Git smart HTTP', label, temporaryProfile: temporary, stages, revisions, consoleErrors };
const recordStage = stage => { stages.push(stage); console.log('Passed: ' + stage); };
const deadline = setTimeout(() => {
  Object.assign(report, { checkedAt: new Date().toISOString(), error: 'Desktop verification deadline exceeded', temporaryProfile: temporary });
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); app.exit(1);
}, 120_000);

function git(args, cwd = work) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
  return result.stdout.trim();
}
async function commitVersion(version, marker, invalid = false) {
  await writeFile(join(work, 'manifest.json'), JSON.stringify({ display_name: 'Renderer URL Fixture', version, author: 'MyCompanion', license: 'MIT', js: invalid ? 'missing.js' : 'index.js', hooks: { update: 'beforeUpdate' } }));
  await writeFile(join(work, 'index.js'), `import { extension_settings, saveSettings } from '/plugin-runtime/settings.js';
globalThis.__rendererUrlMarker=${JSON.stringify(marker)};
export async function beforeUpdate(){ if(globalThis.__rendererUrlHookFail) throw new Error('Expected old update hook failure'); (extension_settings.__rendererUrlHookHistory??=[]).push(${JSON.stringify(marker)}); await saveSettings(); }
`);
  git(['add', '.']); git(['commit', '-m', version]); git(['push', 'origin', 'main']);
  const revision = git(['rev-parse', 'HEAD']); revisions.push({ version, marker, revision }); return revision;
}
function smartHttp(request, response) {
  report.lastGitRequest = { method: request.method, url: request.url, at: new Date().toISOString() };
  if (offline) { response.writeHead(503); response.end('Git fixture intentionally unavailable'); return; }
  const url = new URL(request.url || '/', 'http://localhost');
  const child = spawn('git', ['http-backend'], { windowsHide: true, env: { ...process.env, GIT_PROJECT_ROOT: temporary, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method || 'GET', CONTENT_TYPE: request.headers['content-type'] || '', CONTENT_LENGTH: request.headers['content-length'] || '', SERVER_PROTOCOL: 'HTTP/1.1' } });
  request.pipe(child.stdin); const parts = [];
  child.stdout.on('data', part => parts.push(part));
  child.on('error', error => { if (!response.headersSent) response.writeHead(500); response.end(String(error)); });
  child.on('close', code => {
    if (response.writableEnded) return;
    const output = Buffer.concat(parts), separator = output.indexOf('\r\n\r\n'), boundary = separator >= 0 ? separator : output.indexOf('\n\n');
    if (code !== 0 || boundary < 0) { response.writeHead(500); response.end('Git HTTP backend failed'); return; }
    let status = 200; const values = {};
    for (const header of output.subarray(0, boundary).toString().split(/\r?\n/)) {
      const index = header.indexOf(':'); if (index < 0) continue;
      const key = header.slice(0, index).trim(), value = header.slice(index + 1).trim();
      if (key.toLowerCase() === 'status') status = Number(value.slice(0, 3)); else values[key] = value;
    }
    response.writeHead(status, values); response.end(output.subarray(boundary + (separator >= 0 ? 4 : 2)));
  });
}
const server = createServer(smartHttp);
async function browserHarness() {
  const wait = async (predicate, label) => { const until = Date.now() + 9000; while (!await predicate()) { if (Date.now() > until) throw new Error('Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 20)); } };
  await wait(() => document.querySelector('.service-state--online') && window.__mycompanionFlushDrafts && document.querySelector('#form_create'), 'connected React and editors');
  const core = await import('/script.js'), wi = await import('/plugin-runtime/world-info.js'), host = await import('/plugin-runtime/desktop-host.js'); await host.start();
  const row = () => document.querySelector('[data-code-plugin-id="fixture"]');
  const button = (name, container = document) => [...container.querySelectorAll('button')].find(item => item.textContent.trim() === name);
  const nav = name => [...document.querySelectorAll('nav button')].find(item => item.textContent.trim().startsWith(name)).click();
  const edit = (element, value) => { Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set.call(element, value); element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); };
  const check = (value, label) => { if (!value) throw new Error(label); };
  const getPlugin = async () => (await fetch('/api/code-plugins').then(result => result.json())).items.find(item => item.id === 'fixture');
  const field = name => document.querySelector('#form_create').elements.namedItem(name);
  const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  window.pluginFixture = { wait, core, wi, row, button, nav, edit, check, getPlugin, field, post };
}
async function evaluate(body) {
  report.lastOperation = body.slice(0, 160); let timer;
  try { return await Promise.race([window.webContents.executeJavaScript(`(async()=>{const { wait, core, wi, row, button, nav, edit, check, getPlugin, field, post }=window.pluginFixture;${body}})()`), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Browser operation exceeded 20 seconds: ' + report.lastOperation)), 20000); })]); }
  finally { clearTimeout(timer); }
}
async function ready() {
  const until = Date.now() + 14_000;
  while (Date.now() < until) { try { await window.webContents.executeJavaScript(`(${browserHarness.toString()})()`); return; } catch (error) { if (Date.now() + 100 >= until) throw error; await new Promise(resolve => setTimeout(resolve, 50)); } }
}
async function expectReload(marker) {
  const until = Date.now() + 20000;
  while (loadRevision <= handledLoadRevision) { if (Date.now() > until) throw new Error('Actual desktop document did not reload'); await new Promise(resolve => setTimeout(resolve, 30)); }
  handledLoadRevision = loadRevision; await ready(); await evaluate(`check(globalThis.__rendererUrlMarker===${JSON.stringify(marker)},'Actual new extension executes');`);
}
async function checkUpdates() { await evaluate(`button('检查更新',row()).click(); await new Promise(requestAnimationFrame); await wait(()=>row()?.querySelector('.plugin-update-status') && button('检查更新',row())?.disabled===false,'remote refs checked');`); }
async function switchRef(ref, marker) {
  await checkUpdates(); await evaluate(`edit(row().querySelector('select'),${JSON.stringify(ref)}); await new Promise(requestAnimationFrame); button('切换版本',row()).click();`); await expectReload(marker);
}
async function verify() { try {
  mkdirSync(work); git(['init', '--bare', '--initial-branch=main', bare], temporary); git(['init', '--initial-branch=main']);
  git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']); git(['remote', 'add', 'origin', bare]);
  const first = await commitVersion('1.0', 'first'); git(['tag', '-a', 'v1', '-m', 'Actual annotated release']); git(['push', 'origin', 'v1']); git(['branch', 'alternate']); git(['push', 'origin', 'alternate']);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); sourceUrl = `http://127.0.0.1:${server.address().port}/fixture.git`;
  await app.whenReady(); service = buildApp({ databasePath: join(temporary, 'profile.sqlite'), rendererRoot: join(root, 'apps/renderer/dist') });
  const origin = await bindBrowserPort(port => service.listen({ host: '127.0.0.1', port }));
  window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  window.webContents.on('did-finish-load', () => { loadRevision++; });
  window.webContents.on('console-message', event => { if (event.level === 'error' || event.level === 3) consoleErrors.push(event.message); });
  await window.loadURL(origin); await ready(); handledLoadRevision = loadRevision;
  await evaluate(`nav('插件'); await wait(()=>document.querySelector('input[aria-label="扩展仓库地址"]'),'URL form');
    check(!document.querySelector('.plugin-center input[type=file]'),'Only URL installer');
    edit(document.querySelector('input[aria-label="扩展仓库地址"]'),${JSON.stringify(sourceUrl)}); edit(document.querySelector('input[aria-label="安装分支或标签"]'),'refs/heads/main');
    await new Promise(requestAnimationFrame); button('安装 / 更新').click(); await wait(()=>row(),'installed UI row');
    const installed=await getPlugin(); check(installed.sourceRevision===${JSON.stringify(first)} && installed.sourceRef==='refs/heads/main' && !installed.enabled,'Actual selected-ref URL install');
  `);
  recordStage('real-single-url-form-installs-selected-branch-and-displays-commit');
  await evaluate(`button('启用',row()).click();`); await expectReload('first');
  recordStage('real-enabled-extension-js-executes-after-ui-reload');
  const fixture = await evaluate(`
    const form=new FormData();form.set('ch_name','Plugin update draft role');form.set('first_mes','Hello');
    const avatar=await fetch('/api/characters/create',{method:'POST',body:form}).then(result=>result.text());await core.getCharacters();nav('角色库');
    await wait(()=>[...document.querySelectorAll('.character-row')].some(item=>item.textContent.includes('Plugin update draft role')),'role list');
    [...document.querySelectorAll('.character-row')].find(item=>item.textContent.includes('Plugin update draft role')).click();await wait(()=>button('编辑角色'),'role details');button('编辑角色').click();
    await wait(()=>field('avatar_url').value===avatar,'role editor');$('#form_create [name=description]').val('E04 unsaved role draft').trigger('input');
    await wi.createNewWorldInfo('e04-world');await wi.saveWorldInfo('e04-world',{entries:{0:{...structuredClone(wi.newWorldInfoEntryTemplate),uid:0,content:'Saved world'}}},true);
    nav('角色库');await wait(()=>document.querySelector('#world_button'),'world editor button');document.querySelector('#world_button').click();wi.selectWorldInfoEditor('e04-world');await wait(()=>document.querySelector('.world-info-dock fieldset textarea'),'world editor');
    edit(document.querySelector('.world-info-dock fieldset label:last-of-type textarea'),'E04 unsaved world draft');nav('插件');return {avatar};
  `);
  const second = await commitVersion('1.1', 'second'); await checkUpdates();
  await evaluate(`check(row().querySelector('.plugin-update-status').textContent.includes('有可用'),'Actual remote change detected');button('更新',row()).click();`); await expectReload('second');
  await evaluate(`
    const installed=await getPlugin();check(installed.enabled&&installed.sourceRevision===${JSON.stringify(second)},'Installed real second commit');
    const settings=await fetch('/api/extensions/settings').then(result=>result.json());check(settings.extensionSettings.__rendererUrlHookHistory.at(-1)==='first','Old loaded module runs update hook');
    check(field('description').value==='E04 unsaved role draft','Role draft survives update');wi.selectWorldInfoEditor('e04-world');await wait(()=>document.querySelector('.world-info-dock fieldset label:last-of-type textarea')?.value==='E04 unsaved world draft','World draft survives update');
    check((await post('/api/characters/get',{avatar_url:${JSON.stringify(fixture.avatar)}}).then(result=>result.json())).description==='','Role original remains unsubmitted');
    check((await post('/api/worldinfo/get',{name:'e04-world'}).then(result=>result.json())).entries[0].content==='Saved world','World original remains unsubmitted');
  `);
  recordStage('real-update-detection-old-module-hook-settings-flush-and-both-drafts-survive');
  await switchRef('refs/tags/v1', 'first');
  await evaluate(`const installed=await getPlugin();check(installed.sourceRef==='refs/tags/v1'&&installed.sourceRevision===${JSON.stringify(first)},'Annotated tag resolves to commit');`);
  recordStage('real-ui-annotated-tag-switch-resolves-commit-and-loads-selected-js');
  await switchRef('refs/heads/alternate', 'first'); git(['push', 'origin', '--delete', 'alternate']); await checkUpdates();
  await evaluate(`check(row().querySelector('.plugin-update-status').textContent.includes('已不存在'),'Deleted branch surfaced');check(button('更新',row()).disabled,'Cannot update an absent ref');edit(row().querySelector('select'),'refs/heads/main');`);
  offline = true; await evaluate(`await new Promise(requestAnimationFrame);button('切换版本',row()).click();await wait(()=>row().querySelector('[role=alert]'),'Network failure shown');check((await getPlugin()).sourceRef==='refs/heads/alternate'&&globalThis.__rendererUrlMarker==='first','Failed network keeps old ref and running JS');`);
  recordStage('real-missing-branch-and-network-failure-preserve-old-installed-running-version');
  offline = false; await evaluate(`button('切换版本',row()).click();`); await expectReload('second');
  recordStage('real-network-retry-switches-back-without-reinstalling-through-other-entry');
  await commitVersion('1.2-invalid', 'invalid', true); await checkUpdates();
  await evaluate(`button('更新',row()).click();await wait(()=>row().querySelector('[role=alert]'),'Invalid package shown');check((await getPlugin()).sourceRevision===${JSON.stringify(second)}&&globalThis.__rendererUrlMarker==='second','Package validation failure preserves assets and runtime');`);
  recordStage('actual-invalid-remote-package-retains-old-assets-and-running-module');
  const third = await commitVersion('1.2', 'third'); await checkUpdates();
  await evaluate(`globalThis.__rendererUrlHookFail=true;button('更新',row()).click();await wait(()=>button('应用已安装版本',row()),'Failed old hook offers apply recovery');check((await getPlugin()).sourceRevision===${JSON.stringify(third)}&&globalThis.__rendererUrlMarker==='second','Installed new assets while old runtime preserved');check(row().querySelector('[role=alert]').textContent.includes('新版本已安装'),'Accurate partial-success message');button('应用已安装版本',row()).click();`);
  await expectReload('third');
  await evaluate(`check(field('description').value==='E04 unsaved role draft','Recovery still preserves role draft');wi.selectWorldInfoEditor('e04-world');await wait(()=>document.querySelector('.world-info-dock fieldset label:last-of-type textarea')?.value==='E04 unsaved world draft','Recovery still preserves world draft');`);
  recordStage('actual-old-hook-failure-displays-installed-version-and-apply-recovery-flushes-drafts');
  Object.assign(report, { passed: true, checkedAt: new Date().toISOString(), sourceUrl, rendererHtmlSha256: createHash('sha256').update(await readFile(join(root, 'apps/renderer/dist/index.html'))).digest('hex'), systemGitUsedByApp: false });
} catch (error) {
  report.error = error.stack || String(error);
  try { report.diagnostics = await window.webContents.executeJavaScript('({text:document.body.innerText,marker:globalThis.__rendererUrlMarker})'); } catch {}
  console.error(error); process.exitCode = 1;
} finally {
  clearTimeout(deadline); if (window && !window.isDestroyed()) window.destroy(); await service?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify(report, null, 2));
  for (const target of [work, bare]) {
    const cleanupPath = resolve(target); assert(cleanupPath.startsWith(resolve(temporary) + sep));
    await rm(cleanupPath, { recursive: true, force: true });
  }
  app.exit(process.exitCode || 0);
} }
void verify();
