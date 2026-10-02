// Launch the actual portable executable with an explicitly isolated Chromium /
// Electron userData directory. CDP is enabled only by this test's CLI flags.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyIndependentApp } from './verify-independent-app.mjs';
import { verifyPluginMacroEngine } from './verify-plugin-macro-engine.mjs';

const run = promisify(execFile);
const project = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const flag = process.argv.indexOf('--exe');
assert(flag >= 0 && process.argv[flag + 1] && !process.argv[flag + 1].startsWith('--'), 'Pass --exe <the exact candidate executable>');
const executable = resolve(process.argv[flag + 1]);
await access(executable);
for (const flag of ['--helper', '--legacy-fixture', '--legacy-local-state', '--expected-patch-revision', '--native-lifecycle', '--native-regressions']) {
  assert(!process.argv.includes(flag), 'The embedded-engine verifier has been removed: ' + flag);
}
const labelFlag = process.argv.indexOf('--report-label');
const reportLabel = labelFlag >= 0 ? process.argv[labelFlag + 1] : '';
assert(labelFlag < 0 || /^[a-z0-9-]+$/.test(reportLabel ?? ''), 'Report label must contain only lowercase letters, digits and hyphens');
const profile = await mkdtemp(join(tmpdir(), 'mycompanion-packaged-'));
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const quote = text => "'" + text.replaceAll("'", "''") + "'";
const powershell = async source => (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', source], { windowsHide: true, maxBuffer: 1024 * 1024 })).stdout.trim();
const report = { passed: false, independent: true, executable, executableSha256: await hash(executable), artifactKind: dirname(executable).endsWith('win-unpacked') ? 'unpacked' : 'portable', profile, reportLabel, consoleApiErrorsCaptured: true, stages: [], runs: [], browserErrors: [], runtimeExceptions: [], resourceErrors: [] };
console.log('Verifying actual executable with isolated profile:', profile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket;
let pid;
let engineOrigin;
let children = [];
async function processes() {
    return JSON.parse(await powershell('ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath)'));
}
async function captureChildren() {
    const all = await processes();
    const ids = new Set([pid]);
    for (let index = 0; index < all.length; index++) {
        for (const process of all) if (ids.has(process.ParentProcessId)) ids.add(process.ProcessId);
    }
    return all.filter(process => ids.has(process.ProcessId));
}
try {
  for (const phase of ['initial', 'restart']) {
    children = [];
    await unlink(join(profile, 'DevToolsActivePort')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    const currentRun = { phase };
    report.runs.push(currentRun);
    const args = ['--user-data-dir="' + profile + '"', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--no-first-run'];
    pid = Number(await powershell(`$env:PATH = $env:SystemRoot + '\\System32'; $verificationProcess = Start-Process -FilePath ${quote(executable)} -ArgumentList @(${args.map(quote).join(',')}) -WindowStyle Hidden -PassThru; $verificationProcess.Id`));
    assert(Number.isInteger(pid) && pid > 0);
    currentRun.launcherPid = pid;
    const launchStarted = Date.now();
    // A portable build extracts the application before Electron starts. Record
    // the cost separately instead of confusing extraction with engine startup.
    const deadline = Date.now() + (report.artifactKind === 'portable' ? 300000 : 120000);
    let port;
    while (Date.now() < deadline) {
        try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (port > 0) break; } catch { /* startup */ }
        await delay(250);
    }
    assert(port > 0, 'Packaged app did not create DevToolsActivePort in the requested isolated profile');
    const debuggerOrigin = 'http://127.0.0.1:' + port;
    let target;
    while (Date.now() < deadline) {
        try {
            const targets = await fetch(debuggerOrigin + '/json/list', { signal: AbortSignal.timeout(3000) }).then(response => response.json());
            target = targets.find(item => item.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(item.url));
        } catch { /* A failed startup may display a blocking native error. */ }
        if (target) break;
        await delay(250);
    }
    assert(target, 'Packaged app did not open its independent application document');
    engineOrigin = new URL(target.url).origin;
    currentRun.documentReadyMs = Date.now() - launchStarted;
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let nextId = 0;
    const pending = new Map();
    const requestUrls = new Map();
    socket.addEventListener('close', () => {
        for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('CDP target connection closed')); }
        pending.clear();
    });
    socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.method === 'Runtime.exceptionThrown') {
            const exception = { phase, afterStage: report.stages.at(-1), details: message.params.exceptionDetails };
            report.browserErrors.push(exception);
            report.runtimeExceptions.push(exception);
        }
        if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') report.browserErrors.push({ phase, details: {
            message: message.params.args.map(arg => arg.value ?? arg.description ?? arg.type).join(' '), stackTrace: message.params.stackTrace,
        } });
        if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') report.browserErrors.push({ phase, details: message.params.entry });
        if (message.method === 'Page.javascriptDialogOpening') {
            currentRun.blockingDialog = { type: message.params.type, message: message.params.message };
        }
        if (message.method === 'Network.requestWillBeSent') requestUrls.set(message.params.requestId, message.params.request.url);
        if (message.method === 'Network.loadingFailed') report.resourceErrors.push({ phase, url: requestUrls.get(message.params.requestId), ...message.params });
        if (['Network.loadingFailed', 'Network.loadingFinished'].includes(message.method)) requestUrls.delete(message.params.requestId);
        const request = pending.get(message.id);
        if (!request) return; pending.delete(message.id); clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timed out: ' + method)); }, 45000);
        pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
        const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
    };
    const reload = async () => {
        const navigated = new Promise((resolve, reject) => {
            const timer = setTimeout(() => { socket.removeEventListener('message', onMessage); reject(new Error('Packaged page reload timed out')); }, 30000);
            const onMessage = event => {
                if (JSON.parse(event.data).method !== 'Page.loadEventFired') return;
                clearTimeout(timer); socket.removeEventListener('message', onMessage); resolve();
            };
            socket.addEventListener('message', onMessage);
        });
        await Promise.all([send('Page.reload'), navigated]);
    };
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Network.enable');
    while (Date.now() < deadline) {
        try {
            if (await evaluate('Boolean(document.querySelector("#root .desktop-shell"))')) break;
        } catch (error) {
            // CDP can discover the page before Chromium creates its first
            // execution context. Retry only this navigation/startup race.
            if (!/Cannot find (?:default execution context|context with specified id)|Execution context was destroyed/.test(error.message)) throw error;
        }
        await delay(250);
    }
        await verifyIndependentApp({ webContents: { executeJavaScript: evaluate } }, report, { phase, reload,
          onboardingErrors: process.argv.includes('--onboarding-errors') });
        if(process.argv.includes('--macro-engine')){
          const remoteService={inject:async({method,url,payload})=>{
            const response=await fetch(engineOrigin+url,{method,...(payload!==undefined?{headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}:{})});
            const data=await response.json();return {statusCode:response.status,json:()=>data};
          }};
          currentRun.macroEngine=await verifyPluginMacroEngine({webContents:{executeJavaScript:evaluate}},remoteService,{reload});
          report.stages.push(phase+'-packaged-public-macro-api-environment-and-native-parity');
        }
        await access(join(profile, 'mycompanion.sqlite'));
        assert.equal(await access(join(profile, 'tavern')).then(() => true, () => false), false, 'Independent app created a Tavern profile');
        assert(!(await readFile(join(profile, 'mycompanion.sqlite'))).includes(Buffer.from('mc-independent-verification-key')), 'API key was stored in plaintext');
    children = await captureChildren();
    assert(!children.some(process => process.ExecutablePath?.replaceAll('\\', '/').endsWith('/resources/node/node.exe')), 'Independent app started a reference engine child');
    currentRun.ownedProcesses = children;
    // Page.close follows the desktop window's normal close path. The target
    // may disappear before acknowledging; actual process/port exit is the gate.
    const closeStarted = Date.now();
    // Keep the transport alive until Chromium acknowledges the close or the
    // target disconnects. Closing our socket immediately can lose the command.
    const closeCommand = send('Page.close').then(() => { currentRun.closeCommand = 'acknowledged'; }, error => { currentRun.closeCommandError = error.message; });
    // The portable launcher removes its extracted application after Electron
    // exits. Measure cleanup separately from the 20-second engine gate.
    const stopDeadline = Date.now() + (report.artifactKind === 'portable' ? 120000 : 20000);
    let remaining;
    do {
        const all = await processes();
        remaining = children.filter(child => all.some(process => process.ProcessId === child.ProcessId && process.CreationDate === child.CreationDate));
        if (!currentRun.engineStoppedMs && !remaining.some(child => child.ProcessId !== pid)) {
            currentRun.engineStoppedMs = Date.now() - closeStarted;
            assert(currentRun.engineStoppedMs <= 20000, 'Electron/Node processes took too long to stop');
            assert.equal(await fetch(engineOrigin, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false), false);
        }
        if (Date.now() - closeStarted > 20000) assert(remaining.every(child => child.ProcessId === pid), 'Electron/Node processes remained after 20 seconds');
        if (remaining.length === 0) break;
        await delay(250);
    } while (Date.now() < stopDeadline);
    assert.equal(remaining.length, 0, 'Packaged app left owned processes running: ' + JSON.stringify(remaining));
    currentRun.allProcessesStoppedMs = Date.now() - closeStarted;
    assert.equal(await fetch(engineOrigin, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false), false);
    currentRun.stopped = true;
    socket?.close(); socket = null;
    await closeCommand;
    report.stages.push(phase + '-normal-window-close-stops-independent-app-and-launcher');
    console.log(report.stages.at(-1));
    pid = undefined;

  }
    report.assertionsPassed = true;
    assert.equal(report.runtimeExceptions.length, 0, 'Actual EXE raised unhandled runtime exceptions; inspect runtimeExceptions');
    report.passed = true;
    console.log(JSON.stringify({ passed: true, stages: report.stages, profile }));
} catch (error) {
    report.error = error.stack ?? String(error); console.error(report.error); process.exitCode = 1;
    // Only owned processes with matching creation timestamps may be stopped.
    if (pid) {
        if (!children.length) children = await captureChildren().catch(() => []);
        report.failedOwnedProcesses = children;
        if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ id: 1000000, method: 'Page.close' }));
            await delay(500);
        }
        const current = await processes().catch(() => []);
        for (const child of children.reverse()) {
            if (current.some(process => process.ProcessId === child.ProcessId && process.CreationDate === child.CreationDate)) {
                await powershell(`Stop-Process -Id ${child.ProcessId} -ErrorAction SilentlyContinue`).catch(() => {});
            }
        }
    }
} finally {
    socket?.close();
    await mkdir(join(project, '.cache/reports'), { recursive: true });
    const suffix = reportLabel ? '-' + reportLabel : '-independent';
    await writeFile(join(project, '.cache/reports/packaged' + suffix + '-verification.json'), JSON.stringify(report, null, 2));
}
