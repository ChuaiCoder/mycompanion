// Project-authored integration fixtures. Runs hidden Electron windows against
// temporary SQLite and loopback servers; never opens the user's profile.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { writeFile } from 'node:fs/promises';
import { app, BrowserWindow } from 'electron';
import { bindBrowserPort, buildApp } from '../../local-service/dist/app.js';
import { RuntimeRepository } from '../../local-service/dist/runtime-repository.js';
import { verifyPluginPrimitives } from './verify-plugin-primitives.mjs';
import { verifyPluginDom } from './verify-plugin-dom.mjs';
import { verifyPluginUi } from './verify-plugin-ui.mjs';
import { verifyPluginWorldInfo } from './verify-plugin-world-info.mjs';
import { verifyPluginCharacters } from './verify-plugin-characters.mjs';
import { verifyPluginCharacterEditor } from './verify-plugin-character-editor.mjs';
import { verifyPluginCharacterDeletion } from './verify-plugin-character-deletion.mjs';
import { verifyPluginMessageSurface } from './verify-plugin-message-surface.mjs';
import { verifyPluginGreeting } from './verify-plugin-greeting.mjs';
import { verifyPluginGenerationControls } from './verify-plugin-generation-controls.mjs';
import { verifyPluginPromptInjection } from './verify-plugin-prompt-injection.mjs';
import { verifyPluginRawGeneration } from './verify-plugin-raw-generation.mjs';
import { verifyPluginPromptCollections } from './verify-plugin-prompt-collections.mjs';
import { verifyPluginOpenAITransport } from './verify-plugin-openai-transport.mjs';
import { verifyPluginOpenAISettings } from './verify-plugin-openai-settings.mjs';
import { verifyPluginPresets } from './verify-plugin-presets.mjs';
import { verifyPluginRegex } from './verify-plugin-regex.mjs';
import { verifyPluginMacros } from './verify-plugin-macros.mjs';
import { verifyPluginMacroEngine } from './verify-plugin-macro-engine.mjs';
import { verifyPluginSlash } from './verify-plugin-slash.mjs';
import { verifyPluginPersonas } from './verify-plugin-personas.mjs';
import { verifyPluginScriptData } from './verify-plugin-script-data.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
mkdirSync(join(root, '.cache/reports'), { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'mycompanion-plugin-verification-'));
app.setPath('userData', profile);
app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error('Plugin verification timed out'); app.exit(1); }, 60_000);
let window;
let service;
const remote = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/javascript', 'Access-Control-Allow-Origin': '*' });
  response.end('export const remoteValue = "remote-ok";');
});

async function verify() {
  try {
    await app.whenReady();
    await bindBrowserPort(port => new Promise((resolve, reject) => {
      remote.once('error', reject);
      remote.listen(port, '127.0.0.1', () => { remote.off('error', reject); resolve(); });
    }));
    const remoteOrigin = `http://127.0.0.1:${remote.address().port}`;
    const databasePath = join(profile, 'test.sqlite');
    service = buildApp({ databasePath, rendererRoot: join(root, 'apps/renderer/dist') });
    let failedChatSave = false;
    const templateRequests = new Map();
    service.get('/scripts/templates/fixture-default.html', (_request, reply) => reply.type('text/html').send('<b>{{title}}</b>'));
    service.get('/fixture-templates/retry.html', (_request, reply) => templateRequests.get('/fixture-templates/retry.html') === 1
      ? reply.code(503).send('Temporary fixture failure') : reply.type('text/html').send('<b>Recovered</b>'));
    service.addHook('preHandler', async (request, reply) => {
      if (request.url.endsWith('.html')) templateRequests.set(request.url, (templateRequests.get(request.url) || 0) + 1);
      if (request.url === '/api/extensions/settings' && request.method === 'PUT' && request.body?.extensionSettings?.fixtureSequence === 1) {
        await new Promise(resolve => setTimeout(resolve, 75));
      }
      if (request.url.endsWith('/extension-state') && request.body?.next?.metadata?.fixtureSaveSequence === 1) await new Promise(resolve => setTimeout(resolve, 100));
      if (request.url.endsWith('/extension-state') && request.body?.next?.metadata?.fixtureFailure && !failedChatSave) {
        failedChatSave = true;
        return reply.code(503).send({ error: { message: 'fixture-chat-save-failure' } });
      }
    });
    const database = new DatabaseSync(databasePath);
    const runtime = new RuntimeRepository(database);
    const fixtures = [
      ['success', `import{delay}from'/scripts/utils.js';
        import {extension_settings, getContext} from '/scripts/extensions.js';
        import {eventSource,event_types,setExtensionPrompt} from '/script.js';
        import {value} from './part.js';
        // import './not-a-real-dependency.js';
        const example = "import './not-a-real-dependency.js'";
        const dynamic = await import('./dynamic.js');
        const remote = await import('${remoteOrigin}/remote.js');
        await delay(0);
        const api = await fetch('/api/health').then(response => response.json());
        localStorage.setItem('plugin-smoke', 'storage-ok');
        document.body.dataset.pluginSmoke = [value, dynamic.value, remote.remoteValue, api.status].join(',');
        window.fixtureOrder = ['success']; window.fixtureEvents = []; window.fixtureReady = 0;
        window.fixtureSuccessBus = eventSource; window.fixtureSuccessSettings = extension_settings;
        $(function() { eventSource.on(event_types.APP_READY, () => window.fixtureReady++); });
        for (const name of ['MESSAGE_SENT', 'USER_MESSAGE_RENDERED', 'MESSAGE_RECEIVED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED']) {
          eventSource.on(event_types[name], index => {
            const element = document.querySelector('#chat .mes[mesid="' + index + '"] .mes_text');
            window.fixtureEvents.push({ name, index, text: element?.textContent, content: getContext().chat[index]?.mes });
            if (name === 'CHARACTER_MESSAGE_RENDERED' && element) $('<button class="fixture-message-button">Extension action</button>').appendTo(element);
          });
        }
        $('<button id="fixture-setting">Real extension setting</button>').appendTo('#extensions_settings');
        setExtensionPrompt('fixture', 'Fixture prompt from actual extension.', 0, 0);
        eventSource.on(event_types.CHAT_CHANGED, () => setExtensionPrompt('fixture', 'Fixture prompt from actual extension.', 0, 0));
        export function activate() { extension_settings.activations = (extension_settings.activations || 0) + 1; }
        export function disable() { extension_settings.disableHook = true; }
        export function uninstall() { extension_settings.deleteHook = true; }
        `,
        [['dist/part.js', 'export const value="static-ok";'], ['dist/dynamic.js', 'export const value="dynamic-ok";'],
          ['views/form.html', '<section><h3>{{fixtureUpper title}}</h3>{{#if enabled}}<ul>{{#each items}}<li>{{@index}}: {{../title}} / {{this}}</li>{{/each}}</ul>{{/if}}<div>{{{raw}}}</div><span data-i18n="fixture-template-caption">Default label</span><input data-i18n="[placeholder]fixture-template-placeholder"></section>'],
          ['views/sync.html', '{{#with person}}{{name}}{{/with}}']]],
      ['missing-file', "import {value} from './missing.js';", []],
      ['missing-core', "import {fixtureMissing} from '../../../../../scripts/fixture-missing-core.js';", []],
      ['missing-export', "import {unimplementedExport} from '/scripts/utils.js';", []],
      ['peer', `import {extension_settings} from '/scripts/extensions.js'; import {eventSource} from '/script.js';
        window.fixturePeerSettings = extension_settings; window.fixturePeerBus = eventSource;
        (window.fixtureOrder ||= []).push('peer');`, []],
      ['bad-hook', 'export function activate() { throw new Error("fixture-hook-error"); }', []],
      ['dormant', `import {setExtensionPrompt} from '/script.js'; import {extension_settings} from '/scripts/extensions.js';
        document.body.dataset.dormantLoaded = 'yes'; setExtensionPrompt('dormant', 'Dormant prompt.', 0, 0);
        export function enable() { extension_settings.enableHook = true; }`, []],
    ];
    for (const [id, source, extra] of fixtures) {
      const hooks = id === 'success' ? { activate: 'activate', disable: 'disable', delete: 'uninstall' } : id === 'bad-hook' ? { activate: 'activate' } : id === 'dormant' ? { enable: 'enable' } : {};
      const manifest = { display_name: id, js: 'dist/index.js', css: 'dist/index.css', loading_order: id === 'success' ? -20 : id === 'peer' ? -10 : 0, hooks };
      const files = new Map([
        ['manifest.json', Buffer.from(JSON.stringify(manifest))],
        ['dist/index.js', Buffer.from(source)],
        ['dist/index.css', Buffer.from(id === 'success' ? '#chat { outline-color: rgb(11, 22, 33); } #plugin-root { color: rgb(11, 22, 33); }' : '')],
        ...extra.map(([path, text]) => [path, Buffer.from(text)]),
      ]);
      runtime.installCodePlugin({ manifest, files, plugin: {
        id, kind: 'sillytavern-js', displayName: id, version: '1', author: 'MyCompanion', license: 'AGPL-3.0-only',
        js: manifest.js, css: manifest.css, warnings: [], fileCount: files.size,
        totalBytes: [...files.values()].reduce((sum, buffer) => sum + buffer.length, 0),
      } });
      runtime.setCodePluginEnabled(id, id !== 'dormant');
    }
    database.close();
    const descriptors = (await service.inject({ method: 'GET', url: '/api/code-plugins/runtime' })).json().items;
    assert.deepEqual(descriptors.slice(0, 2).map(item => item.id), ['success', 'peer']);
    assert.deepEqual(descriptors[0].hooks, { activate: 'activate', disable: 'disable', delete: 'uninstall' });
    assert.equal(descriptors.find(item => item.id === 'dormant').enabled, false);
    assert.equal((await service.inject({ method: 'GET', url: '/scripts/extensions/third-party/dormant/dist/index.js' })).statusCode, 200);
    const origin = await bindBrowserPort(port => service.listen({ host: '127.0.0.1', port }));
    for (const prefix of ['/plugin-runtime/scripts/', '/scripts/']) {
      const resource = await service.inject({ method: 'GET', url: prefix + 'extensions/third-party/success/dist/index.js' });
      assert.equal(resource.statusCode, 200);
      assert.equal(resource.body, fixtures[0][1], 'Extension source must not be rewritten');
      assert.match(resource.headers['content-type'], /javascript/);
    }
    window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
    await window.loadURL(origin);
    const result = await window.webContents.executeJavaScript(`(async () => {
      const host = await import('/plugin-runtime/desktop-host.js');
      return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const states = host.getStatuses();
        if (Object.keys(states).length === 6 && Object.values(states).every(state => !state.includes('正在加载'))) {
          clearInterval(timer);
          window.smokeChat = document.getElementById('chat');
          resolve({ states, marker: document.body.dataset.pluginSmoke, storage: localStorage.getItem('plugin-smoke'),
            color: getComputedStyle(document.getElementById('chat')).outlineColor, frames: document.querySelectorAll('iframe').length,
            order: fixtureOrder, ready: fixtureReady, sharedBus: fixtureSuccessBus === fixturePeerBus, sharedSettings: fixtureSuccessSettings === fixturePeerSettings,
            dormantLoaded: Boolean(document.body.dataset.dormantLoaded) });
        } else if (Date.now() - started > 15000) { clearInterval(timer); reject(new Error(JSON.stringify(states))); }
      }, 50);
      });
    })()`);
    assert.equal(result.states.success, '扩展已运行');
    assert.equal(result.marker, 'static-ok,dynamic-ok,remote-ok,ok');
    assert.equal(result.storage, 'storage-ok');
    assert.equal(result.color, 'rgb(11, 22, 33)');
    assert.equal(result.frames, 0);
    assert.deepEqual(result.order, ['success', 'peer']); assert.equal(result.ready, 1);
    assert(result.sharedBus && result.sharedSettings); assert.equal(result.dormantLoaded, false);
    assert.match(result.states['missing-file'], /missing\.js.*HTTP 404/);
    assert.match(result.states['missing-core'], /fixture-missing-core\.js.*HTTP 404/);
    assert.match(result.states['missing-export'], /unimplementedExport/);
    assert.match(result.states['bad-hook'], /fixture-hook-error/);
    const navigation = await window.webContents.executeJavaScript(`(async () => {
      for (const label of ['故事', '插件']) {
        [...document.querySelectorAll('nav button')].find(button => button.textContent.startsWith(label)).click();
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return { sameChat: window.smokeChat === document.getElementById('chat'), text: document.querySelector('.plugin-center').textContent };
    })()`);
    assert.equal(navigation.sameChat, true);
    assert.match(navigation.text, /扩展已运行/);
    assert.doesNotMatch(navigation.text, /安装 ZIP|安装 JSON|安装示例/);
    const primitives = await verifyPluginPrimitives(window, profile);
    const ui = await verifyPluginUi(window, templateRequests);
    const worldInfo = await verifyPluginWorldInfo(window);
    const characters = await verifyPluginCharacters(window);
    const characterEditor = await verifyPluginCharacterEditor(window);
    const characterDeletion = await verifyPluginCharacterDeletion(window);
    const messageSurface = await verifyPluginMessageSurface(window);
    const greeting = await verifyPluginGreeting(window);
    const generationControls = await verifyPluginGenerationControls(window, service);
    const promptInjection = await verifyPluginPromptInjection(window, service);
    const rawGeneration = await verifyPluginRawGeneration(window, service);
    const promptCollections = await verifyPluginPromptCollections(window, service);
    const openAITransport = await verifyPluginOpenAITransport(window, service);
    const openAISettings = await verifyPluginOpenAISettings(window, service);
    const presets = await verifyPluginPresets(window, service);
    const regex = await verifyPluginRegex(window, service);
    const macros = await verifyPluginMacros(window, service);
    const macroEngine = await verifyPluginMacroEngine(window, service);
    const slash = await verifyPluginSlash(window, service);
    const dom = await verifyPluginDom(window, service);
    const scriptData = await verifyPluginScriptData(window);
    const personas = await verifyPluginPersonas(window);
    const report = { checkedAt: new Date().toISOString(), passed: true, ...result, preservedAcrossNavigation: navigation.sameChat, primitives, dom, ui, worldInfo, characters, characterEditor, characterDeletion, messageSurface, greeting, generationControls, promptInjection, rawGeneration, promptCollections, openAITransport, openAISettings, presets, regex, macros, macroEngine, slash, scriptData, personas, completeHelperCompatibility: false };
    await writeFile(join(root, '.cache/reports/independent-plugin-runtime-verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    await writeFile(join(root, '.cache/reports/independent-plugin-runtime-verification.json'), JSON.stringify({ checkedAt: new Date().toISOString(), passed: false, error: error.stack || String(error), completeHelperCompatibility: false }, null, 2));
    console.error(error);
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    window?.destroy();
    await service?.close();
    remote.closeAllConnections();
    await new Promise(resolve => remote.close(resolve));
    app.exit(process.exitCode || 0);
  }
}

// Electron must finish evaluating its ESM entry before it emits ready.
void verify();
