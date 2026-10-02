import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';
import { installDesktopNetwork } from '../dist/desktop-network.js';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const profile = mkdtempSync(join(tmpdir(), 'mycompanion-cdn-'));
app.setPath('userData', profile);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const report = { passed: false, profile, attempts: [], browserErrors: [], stages: [] };
const fixtureTimers = new Set();
const entry = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html><head><title>Network verification</title></head><body><div id="card">Fixture</div></body></html>');
});
const integrityScript = 'globalThis.validIntegrityFixture = true;';
const payloads = {
    'classic.js': ['application/javascript', 'globalThis.fixtureClassic = (globalThis.fixtureClassic || 0) + 1;'],
    'cookie.js': ['application/javascript', 'globalThis.cookieFixture = true;'],
    'module.js': ['application/javascript', 'import { value } from "./child.js"; export const result = value + 1;'],
    'child.js': ['application/javascript', 'export const value = 41;'],
    'style.css': ['text/css', '@import url("./child.css"); #card {color: rgb(10, 20, 30);}'],
    'child.css': ['text/css', '#card {font-weight: 700;}'],
    'integrity.js': ['application/javascript', integrityScript],
    'bad-integrity.js': ['application/javascript', 'globalThis.invalidIntegrityRan = true;'],
    'timeout.js': ['application/javascript', 'globalThis.timeoutRecovered = true;'],
    'cors.js': ['application/javascript', 'export const leaked = true;'],
};
const remote = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://fixture').pathname;
    const file = pathname.split('/').at(-1);
    if (pathname.includes('/cdn.jsdelivr.net/') && file === 'timeout.js') return;
    if (file !== 'cors.js') {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, range');
    }
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    if (file === 'cancel') {
        res.writeHead(200, { 'content-type': 'text/plain', 'x-content-type-options': 'nosniff' }); res.write('first'.padEnd(1024, '.'));
        res.on('close', () => { report.cancelledConnectionClosed = true; });
        return;
    }
    if (file === 'stream') {
        res.writeHead(200, { 'content-type': 'text/plain', 'x-content-type-options': 'nosniff' }); res.write('first'.padEnd(1024, '.'));
        const timer = setTimeout(() => { res.end('second'); fixtureTimers.delete(timer); }, 600);
        fixtureTimers.add(timer);
        return;
    }
    if (file === 'echo') {
        let body = ''; for await (const chunk of req) body += chunk;
        return res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify({ body, authorization: req.headers.authorization, method: req.method }));
    }
    if (file === 'missing.js') return res.writeHead(404, { 'content-type': 'text/plain' }).end('Missing fixture');
    const [type, body] = payloads[file] ?? ['text/plain', 'unrelated-request-ok'];
    res.writeHead(200, { 'content-type': type }).end(body);
});
let window;
let tlsServer;
const watchdog = setTimeout(() => { report.error = 'CDN verification timed out'; finish(1); }, 120000);
async function finish(code) {
    clearTimeout(watchdog);
    for (const timer of fixtureTimers) clearTimeout(timer);
    window?.destroy(); entry.closeAllConnections(); remote.closeAllConnections();
    tlsServer?.closeAllConnections();
    await Promise.all([new Promise(done => entry.close(done)), new Promise(done => remote.close(done))]);
    if (tlsServer) await new Promise(done => tlsServer.close(done));
    mkdirSync(join(project, '.cache/reports'), { recursive: true });
    writeFileSync(join(project, '.cache/reports/cdn-verification.json'), JSON.stringify(report, null, 2));
    app.exit(code);
}
async function verify() {
    try {
        await app.whenReady();
        await Promise.all([new Promise(done => entry.listen(0, '127.0.0.1', done)), new Promise(done => remote.listen(0, '127.0.0.1', done))]);
        const origin = 'http://127.0.0.1:' + entry.address().port;
        const remoteOrigin = 'http://127.0.0.1:' + remote.address().port;
        window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
        window.webContents.on('console-message', event => { if (event.level === 'error') report.browserErrors.push(event.message); });
        // Inject transport failures below the production HTTPS handler. Use real
        // Chromium response handling and cross-origin HTTP, with no TLS bypass.
        installDesktopNetwork(window.webContents.session, { fetcher: async request => {
            const url = new URL(request.url);
            report.attempts.push({ host: url.hostname, path: url.pathname, method: request.method, cookie: request.headers.get('cookie'), authorization: request.headers.get('authorization') });
            if (url.hostname === '127.0.0.1') return window.webContents.session.fetch(request, { bypassCustomProtocolHandlers: true });
            if (url.pathname.includes('all-fail') || (url.hostname === 'testingcf.jsdelivr.net' && !url.pathname.includes('missing.js'))) throw new TypeError('Deliberate transport failure');
            return window.webContents.session.fetch(new Request(remoteOrigin + '/' + url.hostname + url.pathname, request), { bypassCustomProtocolHandlers: true });
        } });
        await window.loadURL(origin);
        const base = 'https://testingcf.jsdelivr.net/npm/mycompanion-network-fixture@1.0.0/';
        await window.webContents.executeJavaScript(`window.loadFixtureScript = (url, integrity) => new Promise((resolve, reject) => {
            const script = document.createElement('script'); script.src = url;
            if (integrity) { script.integrity = integrity; script.crossOrigin = 'anonymous'; }
            script.onload = () => resolve(true); script.onerror = () => reject(new Error('Script rejected: ' + url)); document.head.append(script);
        }); true`);
        await window.webContents.executeJavaScript(`loadFixtureScript(${JSON.stringify(base + 'classic.js')})`);
        assert.equal(await window.webContents.executeJavaScript('window.fixtureClassic'), 1);
        assert.deepEqual(report.attempts.filter(item => item.path.endsWith('classic.js')).map(item => item.host), ['testingcf.jsdelivr.net', 'fastly.jsdelivr.net']);
        assert.equal(await window.webContents.executeJavaScript(`import(${JSON.stringify(base + 'module.js')}).then(module => module.result)`), 42);
        await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
            const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = ${JSON.stringify(base + 'style.css')};
            link.onload = () => resolve(true); link.onerror = () => reject(new Error('Style failed')); document.head.append(link);
        })`);
        const style = await window.webContents.executeJavaScript('({color: getComputedStyle(document.getElementById("card")).color, weight: getComputedStyle(document.getElementById("card")).fontWeight})');
        assert.deepEqual(style, { color: 'rgb(10, 20, 30)', weight: '700' });
        report.stages.push('classic-script-native-esm-relative-import-css-and-relative-stylesheet');

        for (const blob of [false, true]) {
            const iframeResult = await window.webContents.executeJavaScript(`(async () => {
                const frame = document.createElement('iframe');
                const html = '<script src="' + ${JSON.stringify(base + 'classic.js')} + '"><' + '/script>';
                if (${blob}) frame.src = URL.createObjectURL(new Blob([html], {type: 'text/html'})); else frame.srcdoc = html;
                await new Promise((resolve, reject) => { frame.onload = resolve; frame.onerror = reject; document.body.append(frame); });
                const value = {count: frame.contentWindow.fixtureClassic, node: typeof frame.contentWindow.require};
                frame.remove(); if (${blob}) URL.revokeObjectURL(frame.src); return value;
            })()`);
            assert.deepEqual(iframeResult, { count: 1, node: 'undefined' });
        }
        report.stages.push('srcdoc-and-blob-iframe-resource-fallback-node-isolation');
        const integrity = 'sha256-' + createHash('sha256').update(integrityScript).digest('base64');
        assert.equal(await window.webContents.executeJavaScript(`loadFixtureScript(${JSON.stringify(base + 'integrity.js')}, ${JSON.stringify(integrity)})`), true);
        assert.equal(await window.webContents.executeJavaScript(`loadFixtureScript(${JSON.stringify(base + 'bad-integrity.js')}, ${JSON.stringify(integrity)}).then(() => false, () => true)`), true);
        assert.equal(await window.webContents.executeJavaScript('typeof invalidIntegrityRan'), 'undefined');
        assert.equal(await window.webContents.executeJavaScript(`import(${JSON.stringify(base + 'cors.js')}).then(() => false, () => true)`), true);
        report.stages.push('integrity-and-cors-remain-enforced');
        assert.equal(await window.webContents.executeJavaScript(`fetch(${JSON.stringify(base + 'missing.js')}).then(response => response.status)`), 404);
        assert.equal(report.attempts.filter(item => item.path.endsWith('missing.js')).length, 1);
        assert.equal(await window.webContents.executeJavaScript(`fetch(${JSON.stringify(base + 'all-fail.js')}).then(() => false, () => true)`), true);
        assert.equal(report.attempts.filter(item => item.path.endsWith('all-fail.js')).length, 3);
        assert.equal(await window.webContents.executeJavaScript(`fetch(${JSON.stringify(base + 'private.js?token=fixture')}).then(() => false, () => true)`), true);
        assert.equal(report.attempts.filter(item => item.path.endsWith('private.js')).length, 1);
        assert.equal(await window.webContents.executeJavaScript(`fetch('https://unrelated.invalid/data').then(response => response.text())`), 'unrelated-request-ok');
        const echo = await window.webContents.executeJavaScript(`fetch('https://unrelated.invalid/echo', { method: 'POST', headers: {'Content-Type':'application/json','Authorization':'Bearer fixture-token'}, body: JSON.stringify({value:42}) }).then(response => response.json())`);
        assert.deepEqual(echo, { body: '{"value":42}', authorization: 'Bearer fixture-token', method: 'POST' });
        assert.equal(await window.webContents.executeJavaScript(`fetch(${JSON.stringify(base + 'authorized.js')}, { headers: {'Authorization':'Bearer fixture-token'} }).then(() => false, () => true)`), true);
        assert.equal(report.attempts.filter(item => item.path.endsWith('authorized.js')).length, 1);
        await window.webContents.session.cookies.set({ url: 'https://testingcf.jsdelivr.net', name: 'private_fixture', value: 'original-host-only', secure: true, sameSite: 'no_restriction' });
        await window.webContents.session.cookies.set({ url: 'https://fastly.jsdelivr.net', name: 'mirror_fixture', value: 'mirror-host-only', secure: true, sameSite: 'no_restriction' });
        await window.webContents.executeJavaScript(`loadFixtureScript(${JSON.stringify(base + 'classic.js?cookie-probe')})`).catch(() => {});
        // Observe the actual protocol headers with populated test cookie jars;
        // this does not claim to verify server-side cookie attachment on HTTPS.
        await window.webContents.executeJavaScript(`loadFixtureScript(${JSON.stringify(base + 'cookie.js')})`);
        assert(!report.attempts.filter(item => item.host === 'fastly.jsdelivr.net').some(item => item.cookie?.includes('original-host-only')));
        report.stages.push('404-query-bearing-and-unrelated-requests-preserved-all-mirrors-failure-propagated');
        report.stages.push('unrelated-post-body-authorization-and-no-copied-cookie-header');
        const streamed = await window.webContents.executeJavaScript(`(async () => {
            const started = performance.now();
            const response = await fetch('https://unrelated.invalid/stream');
            const reader = response.body.getReader(); const first = await reader.read();
            const firstMs = performance.now() - started;
            const second = await reader.read();
            return {first: new TextDecoder().decode(first.value), second: new TextDecoder().decode(second.value), firstMs};
        })()`);
        assert.equal(streamed.first, 'first'.padEnd(1024, '.')); assert.equal(streamed.second, 'second'); assert(streamed.firstMs < 550);
        report.streaming = streamed;
        const cancelled = await window.webContents.executeJavaScript(`(async () => {
            const controller = new AbortController();
            const response = await fetch('https://unrelated.invalid/cancel', {signal:controller.signal});
            const reader = response.body.getReader(); await reader.read(); controller.abort();
            return reader.read().then(() => 'resolved', error => error.name);
        })()`);
        assert.equal(cancelled, 'AbortError');
        const cancelDeadline = Date.now() + 3000;
        while (!report.cancelledConnectionClosed && Date.now() < cancelDeadline) await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(report.cancelledConnectionClosed, true, 'Aborted ordinary HTTPS fetch must close the native request');
        report.stages.push('ordinary-https-streaming-and-abort-propagation');
        // This generated certificate is deliberately untrusted. The production
        // session must reject it without any certificate override or TLS flag.
        const cert = join(profile, 'fixture-cert.pem'), key = join(profile, 'fixture-key.pem');
        execFileSync(process.env.MYCOMPANION_FIXTURE_OPENSSL ?? 'C:/Program Files/Git/usr/bin/openssl.exe',
            ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert, '-sha256', '-days', '1', '-nodes', '-subj', '/CN=localhost'],
            { windowsHide: true, stdio: 'ignore' });
        tlsServer = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_req, res) => res.end('untrusted'));
        await new Promise(done => tlsServer.listen(0, '127.0.0.1', done));
        assert.equal(await window.webContents.executeJavaScript(`fetch('https://127.0.0.1:${tlsServer.address().port}/').then(() => false, () => true)`), true);
        report.stages.push('untrusted-tls-certificate-rejected');
        const started = Date.now();
        await window.webContents.executeJavaScript(`loadFixtureScript('https://cdn.jsdelivr.net/npm/mycompanion-network-fixture@1.0.0/timeout.js')`);
        assert.equal(await window.webContents.executeJavaScript('window.timeoutRecovered'), true);
        report.timeoutElapsedMs = Date.now() - started;
        assert(report.timeoutElapsedMs >= 7500 && report.timeoutElapsedMs < 15000);
        report.stages.push('hung-primary-request-aborted-before-mirror-recovery');
        await window.loadURL(origin);
        assert.equal(await window.webContents.executeJavaScript(`import(${JSON.stringify(base + 'module.js')}).then(module => module.result)`), 42);
        report.stages.push('network-handler-persists-across-navigation');
        report.passed = true;
        console.log(JSON.stringify({ passed: true, stages: report.stages }));
        await finish(0);
    } catch (error) {
        report.error = error.stack ?? String(error); console.error(report.error); await finish(1);
    }
}
void verify();
