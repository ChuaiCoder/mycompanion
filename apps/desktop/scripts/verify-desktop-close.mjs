// Real source Electron main, renderer, HTTP service and SQLite shutdown checks.
// CDP Page.close destroys its target without the normal title-bar close event.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ownedProcessTree } from './owned-process-tree.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const label = process.argv.find(value => value.startsWith('--label='))?.slice(8);
assert(/^[a-z0-9-]{1,90}$/.test(label ?? ''), 'Pass a new --label=<label>');
const modes = ['normal', 'page', 'destroy', 'flush-failure', 'pending-page', 'pending-destroy'];
const requestedMode = process.argv.find(value => value.startsWith('--mode='))?.slice(7);
assert(!requestedMode || modes.includes(requestedMode), 'Invalid --mode');
const reportPath = join(root, '.cache/reports/desktop-close-' + label + '.json');
mkdirSync(dirname(reportPath), { recursive: true });
assert(!existsSync(reportPath), 'Report exists; choose a new label');
const electron = join(root, 'node_modules/electron/dist/electron.exe');
const main = join(root, 'apps/desktop/dist/main.js');
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const report = { passed: false, sourceElectronOnly: true, builtMainSha256: hash(main), stages: [], runs: [] };
const exec = promisify(execFile), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, owned = [], launcher, browser, inspector;
async function processes() {
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath)'],
  { windowsHide: true, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout);
}
async function waitFor(predicate, name, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(50);
  }
  throw new Error('Timed out: ' + name);
}
async function connect(url) {
  const socket = new WebSocket(url), pending = new Map();
  let id = 0;
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data), request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
  });
  socket.addEventListener('close', () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('CDP target closed')); } pending.clear(); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id, timer = setTimeout(() => { pending.delete(next); reject(new Error('CDP timeout: ' + method)); }, 10_000);
    pending.set(next, { resolve, reject, timer }); socket.send(JSON.stringify({ id: next, method, params }));
  });
  return { socket, send, evaluate: async expression => {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  } };
}
const electronApis = `process.getBuiltinModule('module').createRequire(${JSON.stringify(join(root, 'apps/desktop/package.json'))})('electron')`;
async function run(mode) {
  const profile = mkdtempSync(join(tmpdir(), 'mycompanion-desktop-close-'));
  const current = { mode, profile, sourceElectronOnly: true, stdout: '', stderr: '' };
  report.runs.push(current);
  child = spawn(electron, [join(root, 'apps/desktop'), '--user-data-dir=' + profile, '--remote-debugging-port=0', '--inspect=0'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { current.stdout += data; });
  child.stderr.on('data', data => { current.stderr += data; });
  current.pid = child.pid;
  launcher = await waitFor(async () => (await processes()).find(row => row.ProcessId === child.pid && row.ExecutablePath?.toLowerCase() === electron.toLowerCase()), 'verified Electron identity', 5000);
  current.launcher = launcher;
  owned = ownedProcessTree(await processes(), launcher);
  const inspectorUrl = await waitFor(() => current.stderr.match(/Debugger listening on (ws:\/\/[^\s]+)/)?.[1], 'Node inspector startup');
  inspector = await connect(inspectorUrl);
  const browserPort = await waitFor(async () => { try { return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch { return 0; } }, 'renderer debugger port');
  const target = await waitFor(async () => {
    const targets = await fetch('http://127.0.0.1:' + browserPort + '/json/list').then(response => response.json());
    return targets.find(value => value.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(value.url));
  }, 'actual application page');
  current.origin = new URL(target.url).origin;
  browser = await connect(target.webSocketDebuggerUrl);
  await waitFor(() => browser.evaluate(`Boolean(document.querySelector('#root .desktop-shell')) && typeof window.__mycompanionFlushDrafts === 'function'`), 'actual React close callback');
  await browser.evaluate(`(async () => {
    const settings=await fetch('/api/extensions/settings').then(response=>response.json());
    settings.extensionSettings.closeDiagnostic={label:${JSON.stringify(label)},mode:${JSON.stringify(mode)},flushCalls:0};
    const response=await fetch('/api/extensions/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(settings)});
    if(!response.ok)throw new Error('Failed to seed disposable close marker');
    window.__mcOriginalCloseFlush=window.__mycompanionFlushDrafts;
    window.__mcCloseFlushCalls=0;
    window.__mcSuccessfulCloseFlush=async()=>{
      window.__mcCloseFlushCalls++;
      await new Promise(resolve=>setTimeout(resolve,200));
      await window.__mcOriginalCloseFlush();
      const current=await fetch('/api/extensions/settings').then(response=>response.json());
      current.extensionSettings.closeDiagnostic.flushCalls=window.__mcCloseFlushCalls;
      const saved=await fetch('/api/extensions/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(current)});
      if(!saved.ok)throw new Error('Close marker was not saved before shutdown');
    };
    window.__mycompanionFlushDrafts=window.__mcSuccessfulCloseFlush;
    return true;
  })()`);
  await inspector.evaluate(`(() => {
    globalThis.__mcServerCloseCalls=0;globalThis.__mcCloseErrors=[];
    const server=process._getActiveHandles().find(handle=>handle.constructor.name==='Server'&&handle.address()?.port===${Number(new URL(current.origin).port)});
    if(!server)throw new Error('Actual application HTTP server not found');
    const close=server.close;
    server.close=function(...args){globalThis.__mcServerCloseCalls++;console.log('MC_CLOSE_HTTP='+JSON.stringify({calls:globalThis.__mcServerCloseCalls}));return close.apply(this,args);};
    // Capture the real error-dialog boundary without opening a modal in a test.
    const {dialog}=${electronApis};
    dialog.showErrorBox=(title,message)=>{globalThis.__mcCloseErrors.push({title,message});console.log('MC_CLOSE_ERROR='+JSON.stringify({title,message}));};
    return true;
  })()`);
  if (mode === 'flush-failure') {
    await browser.evaluate(`window.__mycompanionFlushDrafts=async()=>{await new Promise(resolve=>setTimeout(resolve,100));throw new Error('Disposable close failure');};true;`);
    await inspector.evaluate(`(() => {const {app}=${electronApis};app.quit();app.quit();return true;})()`);
    await waitFor(() => inspector.evaluate('globalThis.__mcCloseErrors.length===1'), 'failed close remains visible');
    current.failedClose = await inspector.evaluate(`(() => {const {BrowserWindow}=${electronApis};return {errors:globalThis.__mcCloseErrors,windows:BrowserWindow.getAllWindows().length,serviceCloseCalls:globalThis.__mcServerCloseCalls};})()`);
    assert.equal(current.failedClose.windows, 1);
    assert.equal(current.failedClose.serviceCloseCalls, 0);
    assert.equal(current.failedClose.errors.length, 1);
    assert.match(current.failedClose.errors[0].message, /Disposable close failure/);
    assert.equal((await fetch(current.origin + '/api/health').then(response => response.json())).status, 'ok');
    await browser.evaluate('window.__mycompanionFlushDrafts=window.__mcSuccessfulCloseFlush;true;');
    report.stages.push('actual-app-quit-flush-failure-retains-window-and-service-with-single-error');
  }
  owned = ownedProcessTree(await processes(), launcher);
  current.ownedProcesses = owned;
  const closedAt = Date.now();
  if (mode.startsWith('pending-')) {
    await inspector.evaluate(`(() => {const {BrowserWindow}=${electronApis};BrowserWindow.getAllWindows()[0].close();return true;})()`);
    await waitFor(() => browser.evaluate('window.__mcCloseFlushCalls===1'), 'renderer save already pending before destruction');
    current.destroyedDuringPendingFlush = true;
    if (mode === 'pending-page') await browser.send('Page.close').catch(error => { assert.equal(error.message, 'CDP target closed'); });
    else await inspector.evaluate(`(() => {const {BrowserWindow}=${electronApis};BrowserWindow.getAllWindows()[0].destroy();return true;})()`);
  } else if (mode === 'page') await browser.send('Page.close').catch(error => { assert.equal(error.message, 'CDP target closed'); });
  else await inspector.evaluate(`(() => {const {app,BrowserWindow}=${electronApis};${mode === 'destroy' ? 'BrowserWindow.getAllWindows()[0].destroy();' : mode === 'flush-failure' ? 'app.quit();app.quit();' : 'const window=BrowserWindow.getAllWindows()[0];window.close();window.close();'}return true;})()`);
  // A connected Node inspector itself delays process exit. Disconnect after
  // triggering the product close path, before measuring the owned processes.
  browser.socket.close(); inspector.socket.close();
  await waitFor(() => child.exitCode !== null, 'normal Electron process exit', 20_000);
  current.exitCode = child.exitCode; current.exitMs = Date.now() - closedAt;
  assert.equal(current.exitCode, 0);
  const all = await processes();
  current.remainingOwned = owned.filter(row => all.some(now => now.ProcessId === row.ProcessId && now.CreationDate === row.CreationDate && now.ExecutablePath === row.ExecutablePath));
  assert.equal(current.remainingOwned.length, 0);
  current.serviceReachableAfterExit = await fetch(current.origin, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);
  assert.equal(current.serviceReachableAfterExit, false);
  current.httpServerCloseCalls = [...current.stdout.matchAll(/MC_CLOSE_HTTP=(\{[^\r\n]+\})/g)].map(match => JSON.parse(match[1]).calls);
  assert.deepEqual(current.httpServerCloseCalls, [1]);
  const database = new DatabaseSync(join(profile, 'mycompanion.sqlite'), { readOnly: true });
  try { current.persistedCloseMarker = JSON.parse(database.prepare('SELECT settings_json FROM extension_settings WHERE singleton=1').get().settings_json).closeDiagnostic; }
  finally { database.close(); }
  assert.equal(current.persistedCloseMarker.label, label);
  assert.equal(current.persistedCloseMarker.flushCalls, ['page', 'destroy', 'pending-page', 'pending-destroy'].includes(mode) ? 0 : 1);
  current.draftsFlushed = current.persistedCloseMarker.flushCalls === 1;
  report.stages.push(mode === 'normal' ? 'actual-titlebar-path-coalesces-repeated-close-and-saves-before-service-stop' : mode === 'flush-failure' ? 'actual-quit-retry-saves-once-stops-service-once-and-exits' : 'actual-' + mode + '-destruction-skips-unavailable-drafts-stops-service-once-retries-quit-and-exits');
  child = undefined; owned = []; browser = inspector = undefined;
  console.log('Passed: ' + mode);
}
try {
  for (const mode of requestedMode ? [requestedMode] : modes) await run(mode);
  assert.equal(hash(main), report.builtMainSha256, 'Built main changed during verification');
  report.passed = true;
} catch (error) {
  report.error = String(error?.stack ?? error); console.error(report.error); process.exitCode = 1;
} finally {
  browser?.socket.close(); inspector?.socket.close();
  if (child?.pid) {
    const all = await processes();
    if (all.some(row => row.ProcessId === launcher?.ProcessId && row.CreationDate === launcher.CreationDate)) owned = ownedProcessTree(all, launcher);
    report.failedOwnedProcesses = owned;
    for (const row of [...owned].reverse()) {
      const current = (await processes()).find(now => now.ProcessId === row.ProcessId && now.CreationDate === row.CreationDate && now.ExecutablePath === row.ExecutablePath);
      if (current) await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Stop-Process -Id ${row.ProcessId} -ErrorAction SilentlyContinue`], { windowsHide: true });
    }
    const after = await processes(), last = report.runs.at(-1);
    report.failedCleanup = {
      remainingOwned: owned.filter(row => after.some(now => now.ProcessId === row.ProcessId && now.CreationDate === row.CreationDate && now.ExecutablePath === row.ExecutablePath)),
      origin: last?.origin,
      serviceReachable: last?.origin ? await fetch(last.origin, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false) : false,
    };
  }
  writeFileSync(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' });
}
