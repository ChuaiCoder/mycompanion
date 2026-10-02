import { verifyHelperPromptViewer } from './verify-helper-prompt-viewer.mjs';
import { verifyHelperMacroLifecycle } from './verify-helper-macro-lifecycle.mjs';
import { verifyHelperSlash } from './verify-helper-slash.mjs';
// Runs the cached, byte-unchanged Tavern Helper in an isolated Electron profile.
// This is a compatibility test only; helper files are never part of packaging.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { app, BrowserWindow } from 'electron';
import { codePluginContributionSchema, toExtensionChatState } from '@mycompanion/shared';
import { buildApp } from '../../local-service/dist/app.js';
import { RuntimeRepository } from '../../local-service/dist/runtime-repository.js';
import { verifyHelperScriptsBeforeReload, verifyHelperScriptsAfterReload } from './verify-helper-scripts.mjs';
import { seedHelperScopes, verifyHelperScopesBeforeReload, verifyHelperScopesAfterReload } from './verify-helper-scopes.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const helperRoot = resolve(root, process.argv[2] || '.cache/research/JS-Slash-Runner-519599bc68247d8e759cc844a983f8f5252941a8');
const asciiExample = process.env.MYCOMPANION_VERIFY_ASCII_EXAMPLE === '1';
const chatOverrides = process.env.MYCOMPANION_VERIFY_CHAT_OVERRIDES === '1';
const streamGeneration = process.env.MYCOMPANION_VERIFY_STREAM === '1';
const stopGeneration = process.env.MYCOMPANION_VERIFY_STOP === '1';
const disconnectGeneration = process.env.MYCOMPANION_VERIFY_DISCONNECT === '1';
const scriptLifecycle = process.env.MYCOMPANION_VERIFY_SCRIPTS === '1';
const promptViewer = process.env.MYCOMPANION_VERIFY_PROMPT_VIEWER === '1';
const scriptScopes = process.env.MYCOMPANION_VERIFY_SCOPES === '1';
const macroLifecycle = process.env.MYCOMPANION_VERIFY_MACRO_LIFECYCLE === '1';
const slashExecution = process.env.MYCOMPANION_VERIFY_SLASH === '1';
const profile = mkdtempSync(join(tmpdir(), 'mycompanion-untouched-helper-'));
app.setPath('userData', profile);
app.disableHardwareAcceleration();
const reportLabel = process.env.MYCOMPANION_VERIFY_REPORT_LABEL;
if (reportLabel && !/^[a-z0-9-]+$/i.test(reportLabel)) throw new Error('Invalid verification report label');
const reportPath = join(root, '.cache/reports', reportLabel ? reportLabel + '.json' : promptViewer ? 'untouched-helper-prompt-viewer-runtime.json' : scriptScopes ? 'untouched-helper-scopes-runtime.json' : scriptLifecycle
  ? 'untouched-helper-scripts-runtime.json'
  : disconnectGeneration
  ? 'untouched-helper-disconnect-runtime.json'
  : stopGeneration
  ? 'untouched-helper-stop-runtime.json'
  : streamGeneration
  ? 'untouched-helper-stream-runtime.json'
  : chatOverrides
  ? 'untouched-helper-chat-overrides-runtime.json'
  : asciiExample ? 'untouched-helper-ascii-example-runtime.json' : 'untouched-helper-runtime.json');
const deadline = setTimeout(() => app.exit(124), 90_000);
let service, window;
const providerRequests = [];
let providerFirstChunk = false, providerDisconnects = 0;
const provider = createServer(async (request, response) => {
  if (request.url?.endsWith('/models')) {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({data:[{id:'helper-fixture-model'}]}));
    return;
  }
  let raw = ''; for await (const part of request) raw += part;
  const body = JSON.parse(raw); providerRequests.push(body);
  if (body.stream) {
    response.setHeader('Content-Type', 'text/event-stream');
    response.on('close', () => { providerDisconnects++; });
    response.write('data: {"choices":[{"delta":{"content":"原版"}}]}\n\n');
    providerFirstChunk = true;
    if (disconnectGeneration) setTimeout(() => response.destroy(new Error('fixture stream disconnected')), 25);
    else if (!stopGeneration) setTimeout(() => response.end('data: {"choices":[{"delta":{"content":"助手回复"}}]}\n\ndata: [DONE]\n\n'), 15);
  } else {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({choices:[{message:{content:'原版助手回复'}}]}));
  }
});
async function filesUnder(directory) {
  const files = [];
  for (const item of await readdir(directory, {withFileTypes:true})) {
    if (item.name === '.git') continue;
    const path = join(directory, item.name);
    if (item.isDirectory()) files.push(...await filesUnder(path));
    else if (item.isFile()) files.push(path);
  }
  return files;
}
async function waitFor(predicate, timeout = 25_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await predicate();
    if (value) return value;
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error('Timed out waiting for the original helper');
}
async function main() {
  const result = { checkedAt:new Date().toISOString(), helperRoot, helperVersion:'4.11.2',
    exampleStyle:chatOverrides ? 'chat-override' : asciiExample ? 'ascii' : 'full-width',
    streamGeneration,
    stopGeneration,
    disconnectGeneration,
    passed:false, initialized:false, generated:false, errors:[], statuses:{}, providerRequests:0 };
  try {
    assert(existsSync(join(helperRoot, 'manifest.json')));
    const entry = readFileSync(join(helperRoot, 'dist/index.js'));
    result.entrySha256 = createHash('sha256').update(entry).digest('hex');
    assert.equal(result.entrySha256, 'f2df4136516e5a9a13dd1a50414bd423227d745d8bc25c5e19ead2c3b8afd799');
    await app.whenReady();
    await new Promise(done => provider.listen(0, '127.0.0.1', done));
    const databasePath = join(profile, 'test.sqlite');
    service = buildApp({databasePath, rendererRoot:join(root, 'apps/renderer/dist')});
    result.generationParameterRequests=[];result.generationParameterFallbacks=[];
    service.addHook('preHandler',async request=>{
      if(request.url==='/api/backends/chat-completions/generate')result.generationParameterRequests.push({contextLimit:request.body?._mycompanion_context_limit,stream:request.body?.stream});
    });
    service.addHook('preValidation', async request => {
      if (!request.url.endsWith('/contributions') || request.method !== 'PUT') return;
      const body = request.body;
      const parsed = codePluginContributionSchema.safeParse(body);
      result.contributionDiagnostic = {
        commandCount: Array.isArray(body?.commands) ? body.commands.length : null,
        descriptionLengths: Array.isArray(body?.commands) ? body.commands.map(command => String(command.description ?? '').length) : [],
        issues: parsed.success ? [] : parsed.error.issues.map(issue => ({path:issue.path.join('.'), message:issue.message})),
      };
    });
    const card = JSON.parse(readFileSync(join(root, 'packages/character-card/fixtures/ccv2-full.json'), 'utf8'));
    if (asciiExample) card.data.mes_example = card.data.mes_example.replace('：', ':');
    const characterResponse = await service.inject({method:'POST',url:'/api/characters/import/commit',payload:{filename:'ccv2-full.json',card}});
    assert.equal(characterResponse.statusCode, 201);
    const characterId = characterResponse.json().id;
    const scopes = scriptScopes ? await seedHelperScopes(service,characterResponse.json(),card) : undefined;
    const conversationResponse = await service.inject({method:'POST',url:'/api/conversations',payload:{characterId}});
    assert.equal(conversationResponse.statusCode, 201);
    const conversationId = conversationResponse.json().id;
    if (chatOverrides) {
      const conversation = conversationResponse.json();
      const base = toExtensionChatState(conversation);
      const next = structuredClone(base);
      next.metadata = { scenario:'聊天级场景：{{char}} {{getvar::route}} {{date}} {{maxPrompt}}/{{maxContext}}/{{maxResponse}}',
        system_prompt:'聊天级系统规则 {{getglobalvar::weather}}。',
        mes_example:'<START>\n{{char}}: 聊天级示例。', variables:{route:'北方'} };
      const saved = await service.inject({method:'PUT',url:`/api/conversations/${conversationId}/extension-state`,
        payload:{branchId:conversation.activeBranchId,base,next}});
      assert.equal(saved.statusCode,200,saved.body);
      const settings = await service.inject({method:'PUT',url:'/api/extensions/settings',
        payload:{extensionSettings:{variables:{global:{weather:'雨'}}}}});
      assert.equal(settings.statusCode,200,settings.body);
    }
    await service.inject({method:'PUT',url:'/api/settings/provider',payload:{kind:'ollama',
      baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,model:'helper-fixture-model',maxTokens:512}});
    const manifest = JSON.parse(readFileSync(join(helperRoot, 'manifest.json'), 'utf8'));
    const paths = await filesUnder(helperRoot);
    const files = new Map(await Promise.all(paths.map(async path => [relative(helperRoot, path).split(sep).join('/'), await readFile(path)])));
    const database = new DatabaseSync(databasePath);
    try {
      const runtime = new RuntimeRepository(database);
      runtime.installCodePlugin({manifest, files, plugin:{id:'js-slash-runner',kind:'sillytavern-js',
        displayName:manifest.display_name,version:manifest.version,author:manifest.author,
        license:'PolyForm Noncommercial 1.0.0',js:manifest.js,css:manifest.css,warnings:[],
        fileCount:files.size,totalBytes:[...files.values()].reduce((total, file) => total + file.length, 0)}});
    } finally { database.close(); }
    const origin = await service.listen({host:'127.0.0.1',port:0});
    window = new BrowserWindow({show:false,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});
    result.networkFailures = [];
    window.webContents.session.webRequest.onErrorOccurred(details => {
      result.networkFailures.push({url:details.url,error:details.error});
    });
    window.webContents.on('console-message', details => {
      if (details.level === 'error') result.errors.push(String(details.message).slice(0, 400));
      if(String(details.message).includes('Failed to import native createGenerationParameters'))result.generationParameterFallbacks.push(String(details.message));
    });
    await window.loadURL(origin);
    await waitFor(() => window.webContents.executeJavaScript(`(()=>{
      const nav = [...document.querySelectorAll('nav[aria-label="主导航"] button')].find(button => button.textContent?.includes('故事'));
      if (!nav) return false;
      nav.click();
      return true;
    })()`));
    await waitFor(() => window.webContents.executeJavaScript(`(()=>{
      const button = document.querySelector('.story-list-pane button[data-conversation-id=${JSON.stringify(conversationId)}]');
      if (!button) return false;
      button.click();
      return true;
    })()`));
    await waitFor(() => window.webContents.executeJavaScript(`import('/plugin-runtime/compat-runtime.js').then(host => host.getContext().conversationId === ${JSON.stringify(conversationId)})`));
    const enabled = await service.inject({method:'PUT',url:'/api/code-plugins/js-slash-runner/enabled',payload:{enabled:true}});
    assert.equal(enabled.statusCode, 200);
    await new Promise(done => { window.webContents.once('did-finish-load', done); window.webContents.reload(); });
    await waitFor(() => window.webContents.executeJavaScript(`import('/plugin-runtime/compat-runtime.js').then(host => host.getContext().conversationId === ${JSON.stringify(conversationId)})`));
    const initialized = await waitFor(() => window.webContents.executeJavaScript(`(()=>{
      const host=window.TavernHelper;
      return host && typeof host.generate==='function' ? {panel:!!document.getElementById('tavern_helper'), functions:Object.keys(host).length} : null;
    })()`));
    result.initialized = true; result.panel = initialized.panel; result.functionCount = initialized.functions;
    result.statuses = await window.webContents.executeJavaScript(`import('/plugin-runtime/desktop-host.js').then(host=>host.getStatuses())`);
    if (slashExecution) {
      result.slash=await verifyHelperSlash(window,service,providerRequests);
      result.passed=result.initialized&&result.slash.passed;
      return;
    }
    await window.webContents.executeJavaScript(`(()=>{
      const original = window.fetch.bind(window);
      window.fetch = (input, init) => {
        if (String(input).includes('/extension-prompt-assembly') && typeof init?.body === 'string') {
          const data = JSON.parse(init.body);
          const shape = message => Object.fromEntries(
            Object.entries(message).filter(([key]) => key !== 'content').map(([key,value]) =>
              [key, Array.isArray(value) ? {type:'array',length:value.length} : {type:typeof value,present:value != null}]));
          window.__helperPromptShape = { messages:data.messages?.map(shape),
            messageExamples:data.messageExamples?.map(block => block.map(shape)) };
        }
        return original(input, init).then(async response => {
          if (String(input).includes('/extension-prompt-assembly') && response.ok)
            window.__helperAssembly = await response.clone().json();
          return response;
        });
      };
    })()`);
    if (streamGeneration || stopGeneration || disconnectGeneration) {
      result.streamingHostContract = await window.webContents.executeJavaScript(`import('/scripts/power-user.js').then(module => {
        module.power_user.custom_stopping_strings = JSON.stringify(['固定停止', '{{char}}']);
        module.power_user.custom_stopping_strings_macro = true;
        module.addEphemeralStoppingString('临时停止');
        return {limited:module.getCustomStoppingStrings(2),all:module.getCustomStoppingStrings()};
      })`);
      assert.deepEqual(result.streamingHostContract.limited, ['固定停止', '阿斯特']);
      assert.deepEqual(result.streamingHostContract.all, ['固定停止', '阿斯特', '临时停止']);
    }
    let generated;
    if (stopGeneration) {
      await window.webContents.executeJavaScript(`(()=>{
        window.__stopGenerationResult = null;
        window.__stopGenerationPromise = TavernHelper.generate({user_input:'请说你好',
          should_stream:true,generation_id:'stop-fixture'}).then(
          value => window.__stopGenerationResult = {value},
          error => window.__stopGenerationResult = {error:String(error?.stack||error)});
        return true;
      })()`);
      await waitFor(() => providerRequests.length === 1 && providerFirstChunk);
      result.stopRequested = await window.webContents.executeJavaScript(`TavernHelper.stopGenerationById('stop-fixture')`);
      generated = await waitFor(() => window.webContents.executeJavaScript('window.__stopGenerationResult ?? null'), 10_000);
      await waitFor(() => providerDisconnects > 0, 10_000);
      result.controlsReleased = await waitFor(() => window.webContents.executeJavaScript(`document.body.dataset.generating !== 'true'`), 5_000);
      result.messagesAfterStop = (await service.inject({method:'GET',url:`/api/conversations/${conversationId}`})).json().messages.length;
      result.stopVerified = result.stopRequested === true && Boolean(generated.error) && providerDisconnects > 0 &&
        result.controlsReleased && result.messagesAfterStop === 1;
      result.providerDisconnects = providerDisconnects;
    } else {
      generated = await window.webContents.executeJavaScript(`(async()=>{
        try { return {value:await TavernHelper.generate({user_input:'请说你好',should_stream:${streamGeneration || disconnectGeneration}})}; }
        catch(error) { return {error:String(error?.stack||error)}; }
      })()`);
      if (disconnectGeneration) {
        await waitFor(() => providerDisconnects > 0, 10_000);
        result.controlsReleased = await waitFor(() => window.webContents.executeJavaScript(`document.body.dataset.generating !== 'true'`), 5_000);
        result.messagesAfterDisconnect = (await service.inject({method:'GET',url:`/api/conversations/${conversationId}`})).json().messages.length;
        result.disconnectVerified = Boolean(generated.error) && result.controlsReleased &&
          result.messagesAfterDisconnect === 1 && providerDisconnects > 0;
        result.providerDisconnects = providerDisconnects;
      }
    }
    result.generateResult = generated;
    result.providerOptions = { stream:providerRequests[0]?.stream, stop:providerRequests[0]?.stop };
    if (streamGeneration || stopGeneration || disconnectGeneration) assert.equal(providerRequests[0]?.stream, true,
      'The original helper did not send a streaming provider request');
    if (streamGeneration || stopGeneration || disconnectGeneration) assert.deepEqual(result.providerOptions.stop, result.streamingHostContract.all,
      'The original helper did not pass configured stop strings to the provider');
    const preview = await service.inject({method:'POST',
      url:`/api/conversations/${conversationId}/prompt-preview`, payload:{draft:'请说你好'}});
    assert.equal(preview.statusCode,200,preview.body);
    const helperAssembly = await window.webContents.executeJavaScript('window.__helperAssembly ?? null');
    const nativePreview = preview.json();
    result.promptParity = {
      nativeMessages:nativePreview.messages,
      helperMessages:helperAssembly?.messages,
      providerMessages:providerRequests[0]?.messages,
      nativeTokens:nativePreview.totalTokens,
      helperTokens:helperAssembly?.totalTokens,
    };
    assert.deepEqual(result.promptParity.helperMessages, result.promptParity.nativeMessages,
      'Untouched helper and native generation assembled different model messages');
    assert.deepEqual(result.promptParity.providerMessages, result.promptParity.helperMessages,
      'The provider received different messages from the helper assembly');
    assert.equal(result.promptParity.helperTokens, result.promptParity.nativeTokens,
      'Untouched helper and native generation used different token budgets');
    if (chatOverrides) {
      assert.match(result.promptParity.nativeMessages[0].content, /聊天级场景：阿斯特 北方/);
      assert.match(result.promptParity.nativeMessages[0].content, /32256\/32768\/512/);
      assert.match(result.promptParity.nativeMessages[0].content, /聊天级系统规则 雨。/);
      assert.match(result.promptParity.nativeMessages[0].content, /聊天级示例。/);
      assert.doesNotMatch(result.promptParity.nativeMessages[0].content, /旧天文台/);
    }
    if(macroLifecycle)result.macroLifecycle=await verifyHelperMacroLifecycle(window,providerRequests,'原版助手回复');
    result.lifecycleBeforeReload = await window.webContents.executeJavaScript(`(async()=>{
      const helper = window.TavernHelper;
      await helper.insertOrAssignVariables({mcHelperChat:{value:7}}, {type:'chat'});
      await helper.insertOrAssignVariables({mcHelperGlobal:{value:9}}, {type:'global'});
      const slash = await helper.triggerSlash('/setvar key=mcHelperSlash 11');
      return {chat:helper.getVariables({type:'chat'}), global:helper.getVariables({type:'global'}), slash};
    })()`);
    result.messageBeforeReload = await window.webContents.executeJavaScript(`(async()=>{
      const helper = window.TavernHelper;
      await helper.createChatMessages([{role:'user',message:'助手新增消息'}]);
      const id = helper.getLastMessageId();
      await helper.setChatMessages([{message_id:id,message:'助手修改消息'}]);
      return {id,last:helper.getChatMessages(-1)[0]};
    })()`);
    result.flushError = await window.webContents.executeJavaScript(`import('/plugin-runtime/desktop-host.js').then(host => host.flush().then(() => null, error => String(error)))`);
    result.statuses = await window.webContents.executeJavaScript(`import('/plugin-runtime/desktop-host.js').then(host => host.getStatuses())`);
    result.promptShape = await window.webContents.executeJavaScript('window.__helperPromptShape ?? null');
    result.generated = !generated.error && JSON.stringify(generated.value).includes('原版助手回复');
    result.providerRequests = providerRequests.length;
    if (scriptLifecycle) result.scriptsBeforeReload = await verifyHelperScriptsBeforeReload(window, waitFor);
    if (scriptScopes) {
      result.scopesBeforeReload={passed:false,stages:[]};
      await verifyHelperScopesBeforeReload(window, waitFor, scopes, result.scopesBeforeReload);
    }
    await new Promise(done => { window.webContents.once('did-finish-load', done); window.webContents.reload(); });
    await waitFor(() => window.webContents.executeJavaScript(`window.TavernHelper && typeof window.TavernHelper.getVariables === 'function'`));
    if (scriptLifecycle) result.scriptsAfterReload = await verifyHelperScriptsAfterReload(window, waitFor, 4, 5);
    if (scriptScopes) result.scopesAfterReload = await verifyHelperScopesAfterReload(window, waitFor);
    result.lifecycleAfterReload = await window.webContents.executeJavaScript(`(()=>{
      const helper = window.TavernHelper;
      return {chat:helper.getVariables({type:'chat'}), global:helper.getVariables({type:'global'})};
    })()`);
    result.messageAfterReload = await window.webContents.executeJavaScript(`(async()=>{
      const helper = window.TavernHelper;
      const before = helper.getChatMessages(-1)[0];
      await helper.deleteChatMessages([${JSON.stringify(result.messageBeforeReload.id)}]);
      await (await import('/plugin-runtime/desktop-host.js')).flush();
      return {before,after:helper.getChatMessages('0-{{lastMessageId}}')};
    })()`);
    await window.webContents.executeJavaScript(`(()=>{
      const nav = [...document.querySelectorAll('nav[aria-label="主导航"] button')].find(button => button.textContent?.includes('插件'));
      if (!nav) throw new Error('Plugin navigation missing');
      nav.click();
    })()`);
    await waitFor(() => window.webContents.executeJavaScript(`!![...document.querySelectorAll('.code-plugin-list button')].find(button => button.textContent === '停用')`));
    const disabledLoad = new Promise(done => window.webContents.once('did-finish-load', done));
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('.code-plugin-list button')].find(button => button.textContent === '停用').click()`);
    await disabledLoad;
    result.disabled = await window.webContents.executeJavaScript(`import('/plugin-runtime/desktop-host.js').then(async host => {
      await host.start();
      return { helper:typeof window.TavernHelper, statuses:host.getStatuses() };
    })`);
    await waitFor(() => window.webContents.executeJavaScript(`!![...document.querySelectorAll('.code-plugin-list button')].find(button => button.textContent === '启用')`));
    const enabledLoad = new Promise(done => window.webContents.once('did-finish-load', done));
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('.code-plugin-list button')].find(button => button.textContent === '启用').click()`);
    await enabledLoad;
    await waitFor(() => window.webContents.executeJavaScript(`window.TavernHelper && typeof window.TavernHelper.getVariables === 'function'`));
    result.reenabled = await window.webContents.executeJavaScript(`(()=>({
      chat:window.TavernHelper.getVariables({type:'chat'}),
      status:window.TavernHelper.getTavernHelperVersion(),
    }))()`);
    if (scriptScopes) result.scopesAfterHelperReenabled = await verifyHelperScopesAfterReload(window, waitFor);
    if (scriptLifecycle) {
      result.scriptsAfterHelperReenabled = await verifyHelperScriptsAfterReload(window, waitFor, 5, 6);
      result.providerRequests = providerRequests.length;
    }
    if (promptViewer) {
      result.promptViewer={passed:false};
      await verifyHelperPromptViewer(window, waitFor, service, providerRequests, result.promptViewer);
      result.providerRequests=providerRequests.length;
    }
    assert.equal(result.generationParameterFallbacks.length,0,'Helper must use the public generation parameter API');
    assert.ok(result.generationParameterRequests.length>0,'Expected an extension completion request');
    assert.ok(result.generationParameterRequests.every(request=>Number.isInteger(request.contextLimit) && request.contextLimit>0),'Extension requests must carry context limits');
    result.passed = result.initialized && (stopGeneration ? result.stopVerified
      : disconnectGeneration ? result.disconnectVerified : result.generated) && !result.flushError &&
      result.statuses['js-slash-runner'] === '扩展已运行' && !result.statuses.host &&
      result.lifecycleAfterReload?.chat?.mcHelperChat?.value === 7 &&
      result.lifecycleAfterReload?.global?.mcHelperGlobal?.value === 9 &&
      result.lifecycleAfterReload?.chat?.mcHelperSlash === '11' &&
      result.messageBeforeReload?.last?.message === '助手修改消息' &&
      result.messageAfterReload?.before?.message === '助手修改消息' &&
      !result.messageAfterReload?.after?.some(message => message.message === '助手修改消息') &&
      result.disabled?.helper === 'undefined' &&
      result.reenabled?.chat?.mcHelperChat?.value === 7;
  } catch (error) {
    result.error = String(error?.stack || error);
    if (window && !window.isDestroyed()) {
      try { result.diagnostic = await window.webContents.executeJavaScript(`(async()=>({
        status:(await import('/plugin-runtime/desktop-host.js')).getStatuses(),
        readyState:document.readyState,helper:typeof window.TavernHelper,
        panel:!!document.getElementById('tavern_helper'),
        body:document.body?.textContent?.slice(0,800)
      }))()`); } catch (secondary) { result.diagnosticError = String(secondary); }
    }
  }
  finally {
    await mkdir(dirname(reportPath), {recursive:true});
    await writeFile(reportPath, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    window?.destroy();
    await service?.close();
    provider.closeAllConnections();
    await new Promise(done => provider.close(done));
    clearTimeout(deadline);
    app.exit(result.passed ? 0 : 1);
  }
}
void main();
