// Actual browser closures/providers across the renderer/native macro RPC bridge.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';
import { buildApp, bindBrowserPort } from '../../local-service/dist/app.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const profile = mkdtempSync(join(tmpdir(), 'mycompanion-renderer-browser-macros-'));
const label = process.argv.find(value => value.startsWith('--label='))?.slice(8) ?? new Date().toISOString().replace(/[^a-z0-9]/gi, '-');
assert(/^[a-z0-9-]{1,90}$/i.test(label));
const reportPath = join(root, '.cache/reports/renderer-browser-macros-' + label + '.json'); mkdirSync(dirname(reportPath), { recursive: true });
const stages = [], providerRequests = [], consoleErrors = [], evidence = [];
app.setPath('userData', profile); app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
let service, window, origin;
const isMemoryRequest = payload => payload.messages?.[0]?.content?.startsWith('你是角色扮演的记忆助手。');
const provider = createServer(async (request, response) => {
  const parts = []; for await (const part of request) parts.push(part);
  const payload = JSON.parse(Buffer.concat(parts).toString() || '{}'); providerRequests.push(payload);
  if (payload.stream) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'reply' } }] }) + '\n\ndata: [DONE]\n\n');
  } else { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: isMemoryRequest(payload) ? '[]' : 'reply' } }] })); }
});
const deadline = setTimeout(() => { writeFileSync(reportPath, JSON.stringify({ passed: false, checkedAt: new Date().toISOString(), label, profile, stages, error: 'Browser macro verification deadline exceeded' }, null, 2), { flag: 'wx' }); app.exit(1); }, 180_000);
const record = name => { stages.push(name); console.log('Passed: ' + name); };
const api = async (method, path, payload, headers) => { const result = await service.inject({ method, url: path, ...(payload === undefined ? {} : { payload }), ...(headers ? { headers } : {}) }); assert([200, 201].includes(result.statusCode), result.body); return result.json(); };
async function browserHarness() {
  const wait = async (predicate, label) => { const until = Date.now() + 12000; while (!await predicate()) { if (Date.now() > until) throw new Error('Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 20)); } };
  const check = (condition, label) => { if (!condition) throw new Error(label); };
  await wait(() => document.querySelector('.service-state--online') && window.__mycompanionFlushDrafts, 'online application');
  const script = await import('/script.js'), compat = await import('/plugin-runtime/compat-runtime.js');
  const core = { ...script, getContext: compat.getContext }, host = await import('/plugin-runtime/desktop-host.js'); await host.start();
  const { MacrosParser, MacroEnvBuilder } = await import('/plugin-runtime/macros.js');
  const { MacroRegistry } = await import('/scripts/macros/engine/MacroRegistry.js');
  const variables = await import('/plugin-runtime/variables.js'), settings = await import('/plugin-runtime/settings.js');
  const { power_user } = await import('/scripts/power-user.js');
  const { oai_settings } = await import('/scripts/openai.js');
  const openai = await import('/scripts/openai.js'), wi = await import('/scripts/world-info.js');
  const boundary = await import('/plugin-runtime/macro-boundary.js'), draft = await import('/plugin-runtime/macro-draft.js');
  let closures = 0, providers = 0, large = 0, unvisited = 0, closureText = 'browser-closure', cachedLocal, cachedGlobal;
  MacroEnvBuilder.registerProvider(env => { providers++; env.extra.m04 = 'browser-provider'; });
  MacrosParser.registerMacro('m04RendererClosure', () => {
    closures++; variables.incrementLocalVariable('callbacks'); variables.incrementGlobalVariable('callbacks');
    if (cachedLocal) {
      cachedLocal.cachedCallbacks = Number(cachedLocal.cachedCallbacks ?? 0) + 1;
      cachedGlobal.cachedCallbacks = Number(cachedGlobal.cachedCallbacks ?? 0) + 1;
      core.chat_metadata.variables.directCallbacks = Number(core.chat_metadata.variables.directCallbacks ?? 0) + 1;
    }
    return closureText;
  });
  MacroRegistry.registerMacro('m04RendererRegistry', { handler: ({ env }) => env.system.model + ':' + env.names.char + ':' + env.extra.m04 });
  MacrosParser.registerMacro('m04RendererEscaped', '\n[a].*');
  MacrosParser.registerMacro('m04RendererLarge', () => { large++; variables.incrementLocalVariable('large'); return 'large '.repeat(5000); });
  MacrosParser.registerMacro('m04RendererUnvisited', () => { unvisited++; return 'forbidden'; });
  const originalFetch = window.fetch.bind(window), events = [], submissions = [];
  let abortController;
  const observe = async response => {
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
    try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; buffer += decoder.decode(chunk.value, { stream: true }); let delimiter;
      while ((delimiter = buffer.indexOf('\n\n')) >= 0) { const frame = buffer.slice(0, delimiter); buffer = buffer.slice(delimiter + 2); for (const line of frame.split('\n')) if (line.startsWith('data:')) events.push(JSON.parse(line.slice(5))); }
    } } catch {} finally { reader.releaseLock(); }
  };
  window.fetch = async (url, options) => {
    const path = String(url);
    if (path.startsWith('/api/generation/macros/')) {
      const payload = JSON.parse(options.body); submissions.push({ path, payload, liveLocal: structuredClone(core.getContext().chatMetadata.variables ?? {}), liveGlobal: structuredClone(settings.extension_settings.variables?.global ?? {}), draftActive: draft.isMacroDraftActive() });
      if (abortController) { const controller = abortController; abortController = undefined; controller.abort(new Error('Expected browser macro cancellation')); options.signal?.throwIfAborted(); throw controller.signal.reason; }
    }
    const response = await originalFetch(url, options);
    if (response.headers.get('content-type')?.includes('text/event-stream')) void observe(response.clone());
    return response;
  };
  const request = async (method, path, payload) => { const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }); const result = await response.json(); check(response.ok, 'HTTP ' + response.status + ': ' + JSON.stringify(result)); return result; };
  const snapshot = async () => ({ story: await request('GET', '/api/conversations/' + core.getCurrentChatId()), settings: (await request('GET', '/api/extensions/settings')).extensionSettings });
  const edit = (element, value) => { Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); };
  window.m04 = { wait, check, core, host, settings, variables, power_user, oai_settings, openai, wi, boundary, events, submissions, request, snapshot, edit,
    counts: () => ({ closures, providers, large, unvisited }), setText: value => { closureText = value; }, abortNext: controller => { abortController = controller; },
    cacheAliases: () => { cachedLocal = core.chat_metadata.variables ??= {}; cachedGlobal = settings.extension_settings.variables.global; },
    reset: () => { closures = 0; providers = 0; large = 0; unvisited = 0; events.length = 0; submissions.length = 0; closureText = 'browser-closure'; },
  };
}
async function evaluate(body) { return window.webContents.executeJavaScript(`(async()=>{const {wait,check,core,host,settings,variables,power_user,oai_settings,openai,wi,boundary,events,submissions,request,snapshot,edit}=window.m04;${body}})()`); }
async function selectRole(story) {
  await evaluate(`await core.getCharacters();await core.selectCharacterById(core.characters.findIndex(item=>item.id===${JSON.stringify(story.characterId)}));await wait(()=>core.getCurrentChatId()===${JSON.stringify(story.id)}&&core.getContext().branchId===${JSON.stringify(story.activeBranchId)},'Actual story/branch context');[...document.querySelectorAll('nav button')].find(item=>item.textContent.trim().startsWith('故事')).click();await wait(()=>document.querySelector('#send_textarea'),'Chat composer');`);
}
async function verify() { try {
  await app.whenReady(); await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  service = buildApp({ databasePath: join(profile, 'profile.sqlite'), rendererRoot: join(root, 'apps/renderer/dist') });
  await api('PUT', '/api/settings/provider', { kind: 'ollama', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, model: 'gpt-4o', contextLimitTokens: 4096, maxTokens: 128 });
  origin = await bindBrowserPort(port => service.listen({ host: '127.0.0.1', port }));
  window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on('console-message', details => { if (details.level === 'error') consoleErrors.push(details.message); });
  await window.loadURL(origin); await window.webContents.executeJavaScript(`(${browserHarness.toString()})()`);
  for (const newEngine of [false, true]) {
    const character = await api('POST', '/api/characters/import/commit', { filename: 'm04.json', card: { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'M04 renderer ' + newEngine, description: 'CARD={{m04RendererClosure}}', personality: '', scenario: '', first_mes: 'Opening', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {} } } }, { 'Idempotency-Key': randomUUID() });
    const story = await api('POST', '/api/conversations', { characterId: character.id }); await selectRole(story);
    await evaluate(`power_user.experimental_macro_engine=${newEngine};settings.extension_settings.variables={global:{callbacks:0}};window.m04.cacheAliases();await settings.saveSettings();window.m04.reset();`);
    const synthetic = await evaluate(`const context=core.getContext(),before=JSON.stringify({metadata:context.chatMetadata,variables:settings.extension_settings.variables});const result=boundary.evaluateBrowserMacro({conversationId:context.conversationId,branchId:context.branchId,evaluation:{ordinal:0,content:'{{m04RendererClosure}}|{{m04RendererRegistry}}|{{model}}|{{maxContext}}|{{maxResponse}}|{{original}}|{{original}}',context:{experimentalMacroEngine:${newEngine},replaceCharacterCard:false,model:'draft-model',characterName:'DraftActor',contextLimitTokens:8000,maxResponseTokens:96,original:'once'},environment:{},local:{callbacks:0},global:{callbacks:0}}});check(before===JSON.stringify({metadata:context.chatMetadata,variables:settings.extension_settings.variables}),'Live values restored');const escaped=boundary.evaluateBrowserMacro({conversationId:context.conversationId,branchId:context.branchId,evaluation:{ordinal:1,content:'^({{m04RendererEscaped}})$',context:{experimentalMacroEngine:${newEngine},replaceCharacterCard:false,escapeRegex:true},environment:{},local:{},global:{}}});return {result,escaped};`);
    assert.deepEqual(synthetic.result, { content: 'browser-closure|draft-model:DraftActor:browser-provider|draft-model|8000|96|once|', local: { callbacks: 1, cachedCallbacks: 1, directCallbacks: 1 }, global: { callbacks: 1, cachedCallbacks: 1 } });
    assert.equal(synthetic.escaped.content, '^(\\n\\[a\\]\\.\\*)$'); record(`real-browser-closure-provider-original-regex-and-live-restoration-new-${newEngine}`);
    await evaluate(`core.setExtensionPrompt('m04-a','SCAN {{m04RendererClosure}} {{m04RendererRegistry}} trigger',1,0,true);core.setExtensionPrompt('m04-b','SCAN {{m04RendererClosure}} {{m04RendererRegistry}} trigger',1,0,true);window.m04.reset();`);
    for (const mode of ['preview', 'normal', 'quiet', 'public-assembly', 'public-wi', 'regenerate']) {
      const before = await evaluate(`await host.flush();window.m04.reset();return snapshot();`), providerBefore = providerRequests.length;
      if (mode === 'preview') await evaluate(`const summary=document.querySelector('.prompt-preview summary');summary.click();await wait(()=>events.some(event=>event.type==='macro_result')&&document.querySelector('.prompt-preview__body'),'Actual React preview result');check(!document.querySelector('.prompt-preview__error'),'Preview succeeds');summary.click();await new Promise(requestAnimationFrame);`);
      if (mode === 'normal') await evaluate(`edit(document.querySelector('#send_textarea'),'latest');await new Promise(requestAnimationFrame);await core.Generate('normal');`);
      if (mode === 'quiet') await evaluate(`const text=await core.generateQuietPrompt({quietPrompt:'QUIET {{m04RendererClosure}}'});check(text==='reply','Quiet actual provider result');`);
      if (mode === 'public-assembly') await evaluate(`const result=await openai.prepareOpenAIMessages({messages:[{role:'user',content:'latest'}]});check(JSON.stringify(result).includes('browser-closure'),'Public assembly uses closure');check(JSON.stringify(result).includes('browser-provider'),'Public assembly uses provider');`);
      if (mode === 'public-wi') await evaluate(`await request('POST','/api/worldinfo/edit',{name:'M04 renderer',data:{entries:{1:{uid:1,key:['trigger'],content:'WI={{m04RendererClosure}}',order:100,position:1,useProbability:false}}}});wi.selected_world_info.splice(0,wi.selected_world_info.length,'M04 renderer');const result=await wi.getWorldInfoPrompt([],4096);check(result.worldInfoAfter==='WI=browser-closure','Public WI runs real closure');`);
      if (mode === 'regenerate') await evaluate(`settings.extension_settings.regex=[{placement:[2],findRegex:'/reply/g',replaceString:'OUT={{m04RendererClosure}}'}];await settings.saveSettings();await core.Generate('regenerate');check(core.getContext().branchId!==${JSON.stringify(before.story.activeBranchId)},'Regeneration immediately changes host branch');check(core.getContext().chat.at(-1).mes==='OUT=browser-closure','Output regex macro sees accepted branch');`);
      const after = await evaluate(`await host.flush();await wait(()=>events.some(event=>event.type==='macro_request'),'Actual macro RPC');return {...await snapshot(),counts:window.m04.counts(),events,submissions};`);
      evidence.push({ newEngine, mode, before, after });
      assert(after.counts.closures > 0); assert(after.counts.providers > 0);
      assert.equal(after.settings.variables.global.callbacks, (before.settings.variables.global.callbacks ?? 0) + (mode === 'preview' ? 0 : after.counts.closures));
      assert.equal(after.story.chatMetadata.variables?.callbacks ?? 0, (before.story.chatMetadata.variables?.callbacks ?? 0) + (mode === 'preview' ? 0 : after.counts.closures));
      assert.equal(after.story.chatMetadata.variables?.cachedCallbacks ?? 0, (before.story.chatMetadata.variables?.cachedCallbacks ?? 0) + (mode === 'preview' ? 0 : after.counts.closures));
      assert.equal(after.story.chatMetadata.variables?.directCallbacks ?? 0, (before.story.chatMetadata.variables?.directCallbacks ?? 0) + (mode === 'preview' ? 0 : after.counts.closures));
      assert.equal(after.settings.variables.global.cachedCallbacks ?? 0, (before.settings.variables.global.cachedCallbacks ?? 0) + (mode === 'preview' ? 0 : after.counts.closures));
      assert.deepEqual(after.events.filter(event => event.type === 'error'), []);
      assert(after.submissions.every(item => !item.draftActive && !item.payload.error));
      assert.equal(providerRequests.slice(providerBefore).filter(request => !isMemoryRequest(request)).length, ['normal','quiet','regenerate'].includes(mode) ? 1 : 0);
      if (['preview','quiet','public-assembly','public-wi'].includes(mode)) assert.deepEqual(after.story.messages, before.story.messages);
      if (['normal','quiet','regenerate'].includes(mode)) { const body = JSON.stringify(providerRequests.slice(providerBefore).find(request => !isMemoryRequest(request)).messages); assert(body.includes('browser-closure')); assert(!body.includes('{{m04')); }
      if (mode === 'regenerate') { const outputEvents = after.events.filter(event => event.type === 'macro_request' && event.branchId === after.story.activeBranchId); assert(outputEvents.length > 0); assert(!after.story.messages.some(item => item.id === before.story.messages.at(-1).id)); }
      const duplicate = await api('GET', '/api/conversations/' + story.id), submission = after.submissions[0];
      const repeated = await service.inject({ method: 'POST', url: submission.path, payload: { result: { content: 'duplicate', local: {}, global: {} } } }); assert.equal(repeated.statusCode, 409); assert.deepEqual(await api('GET', '/api/conversations/' + story.id), duplicate);
      record(`real-renderer-${mode}-closure-rpc-and-atomic-effects-new-${newEngine}`);
    }
    const beforeBudget = await evaluate(`core.setExtensionPrompt('m04-a','',1,0,true);core.setExtensionPrompt('m04-b','',1,0,true);wi.selected_world_info.splice(0);settings.extension_settings.regex=[];await host.flush();window.m04.reset();return snapshot();`), providerBefore = providerRequests.length;
    const budget = await evaluate(`oai_settings.openai_max_context=1024;const result=await openai.prepareOpenAIMessages({charDescription:'',messages:[{role:'user',content:'latest'},{role:'assistant',content:'{{m04RendererLarge}}'},{role:'user',content:'{{m04RendererUnvisited}}'}]});return {result,counts:window.m04.counts(),saved:await snapshot()};`);
    assert.equal(budget.counts.large, 1); assert.equal(budget.counts.unvisited, 0); assert(!JSON.stringify(budget.result).includes('large large')); assert.equal(budget.saved.story.chatMetadata.variables.large, 1); assert.equal(providerRequests.length, providerBefore);
    record(`real-public-assembly-history-budget-never-visits-older-closure-new-${newEngine}`);
    const beforeFailure = await evaluate(`oai_settings.openai_max_context=4096;await host.flush();window.m04.reset();window.m04.setText('large '.repeat(5000));return snapshot();`);
    const failure = await evaluate(`let error;try{await core.generateQuietPrompt({quietPrompt:''});}catch(cause){error=cause.message;}await host.flush();return {error,saved:await snapshot()};`);
    assert.match(failure.error, /上下文/); assert.deepEqual(failure.saved.story, beforeFailure.story); assert.deepEqual(failure.saved.settings.variables, beforeFailure.settings.variables); assert.equal(providerRequests.length, providerBefore);
    record(`real-fixed-expansion-budget-failure-keeps-draft-and-skips-provider-new-${newEngine}`);
    const beforeCancel = await evaluate(`window.m04.reset();const before=await snapshot();window.m04.controller=new AbortController();window.m04.abortNext(window.m04.controller);return before;`);
    const cancelled = await evaluate(`let error;try{await core.generateQuietPrompt({quietPrompt:'{{m04RendererClosure}}',signal:window.m04.controller.signal});}catch(cause){error=cause.message;}await host.flush();return {error,saved:await snapshot(),submissions};`);
    assert.match(cancelled.error, /cancellation/); assert.deepEqual(cancelled.saved.story, beforeCancel.story); assert.deepEqual(cancelled.saved.settings.variables, beforeCancel.settings.variables); assert.equal(providerRequests.length, providerBefore);
    const late = await service.inject({ method: 'POST', url: cancelled.submissions[0].path, payload: { result: { content: 'late', local: {}, global: {} } } }); assert.equal(late.statusCode, 409);
    record(`real-quiet-abort-and-late-macro-rpc-cannot-commit-new-${newEngine}`);
  }
  const report = { passed: true, checkedAt: new Date().toISOString(), label, profile, stages, providerRequests, consoleErrors, evidence, completeM04: false };
  await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ passed: true, checkedAt: report.checkedAt, label, reportPath, stages: stages.length,
    providerRequests: providerRequests.length, generationRequests: providerRequests.filter(request => !isMemoryRequest(request)).length,
    memoryRequests: providerRequests.filter(isMemoryRequest).length, consoleErrors, completeM04: false }, null, 2));
} catch (error) {
  let diagnostics; try { diagnostics = await window.webContents.executeJavaScript('({text:document.body.innerText,counts:window.m04?.counts(),context:{conversationId:window.m04?.core.getContext().conversationId,branchId:window.m04?.core.getContext().branchId,chatMetadata:window.m04?.core.getContext().chatMetadata},events:window.m04?.events,submissions:window.m04?.submissions})'); } catch {}
  await writeFile(reportPath, JSON.stringify({ passed: false, checkedAt: new Date().toISOString(), label, profile, stages, providerRequests, consoleErrors, evidence, error: error.stack || String(error), diagnostics }, null, 2), { flag: 'wx' }); console.error(error); process.exitCode = 1;
} finally { clearTimeout(deadline); if (window && !window.isDestroyed()) window.destroy(); await service?.close(); await new Promise(resolve => provider.close(resolve)); app.exit(process.exitCode || 0); } }
void verify();
