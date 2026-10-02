import { verifyHelperPromptViewer } from './verify-helper-prompt-viewer.mjs';
import { verifyHelperMacroLifecycle } from './verify-helper-macro-lifecycle.mjs';
// Runs byte-unchanged Tavern Helper against the actual portable EXE in a disposable profile.
// The helper is installed only into that profile, never into the release artifact.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../../local-service/dist/app.js';
import { RuntimeRepository } from '../../local-service/dist/runtime-repository.js';
import { verifyHelperScriptsBeforeReload, verifyHelperScriptsAfterReload } from './verify-helper-scripts.mjs';
import { seedHelperScopes, verifyHelperScopesBeforeReload, verifyHelperScopesAfterReload } from './verify-helper-scopes.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const labelIndex = process.argv.indexOf('--report-label');
const reportLabel = labelIndex >= 0 ? process.argv[labelIndex + 1] : '';
assert(labelIndex < 0 || /^[a-z0-9-]+$/.test(reportLabel ?? ''), 'Invalid report label');
const exeIndex = process.argv.indexOf('--exe');
assert(exeIndex >= 0 && process.argv[exeIndex + 1], 'Pass --exe <portable candidate>');
const executable = resolve(process.argv[exeIndex + 1]);
const verifyScripts = process.argv.includes('--scripts');
const verifyViewer = process.argv.includes('--prompt-viewer');
const verifyParameters = process.argv.includes('--generation-parameters');
const verifyMacros = process.argv.includes('--macro-api');
const providerBodies = [];
const verifyScopes = process.argv.includes('--scopes');
assert(existsSync(executable), 'Portable EXE does not exist');
const helperIndex = process.argv.indexOf('--helper');
const helperRoot = resolve(helperIndex >= 0 ? process.argv[helperIndex + 1] :
  join(root, '.cache/research/JS-Slash-Runner-519599bc68247d8e759cc844a983f8f5252941a8'));
const profile = mkdtempSync(join(tmpdir(), 'mycompanion-packaged-helper-'));
const reportPath = join(root, '.cache/reports', reportLabel ? 'packaged-'+reportLabel+'-verification.json' : verifyViewer ? 'packaged-helper-prompt-viewer-verification.json' : verifyScopes ? 'packaged-helper-scopes-verification.json' : verifyScripts ? 'packaged-helper-scripts-verification.json' : 'packaged-untouched-helper-verification.json');
const expectedHash = 'f2df4136516e5a9a13dd1a50414bd423227d745d8bc25c5e19ead2c3b8afd799';
const report = {passed:false, executable, profile, helperRoot, stages:[], runs:[], providerRequests:0, errors:[]};
let provider, candidate;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = Date.now() + 180_000;
const exec = promisify(execFile);
async function processes() {
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath)'],
  { windowsHide: true, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout);
}
async function captureChildren(pid) {
  const all = await processes(), ids = new Set([pid]);
  for (let i = 0; i < all.length; i++) for (const process of all) if (ids.has(process.ParentProcessId)) ids.add(process.ProcessId);
  return all.filter(process => ids.has(process.ProcessId));
}

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

async function waitFor(predicate, timeout = 30_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try { const result = await predicate(); if (result) return result; } catch { /* Initial CDP context may not exist yet. */ }
    await delay(100);
  }
  throw new Error('Timed out waiting for packaged helper state');
}

async function seedProfile(providerPort) {
  const databasePath = join(profile, 'mycompanion.sqlite');
  const service = buildApp({databasePath});
  try {
    const card = JSON.parse(readFileSync(join(root, 'packages/character-card/fixtures/ccv2-full.json'), 'utf8'));
    const imported = await service.inject({method:'POST',url:'/api/characters/import/commit',
      payload:{filename:'ccv2-full.json',card}});
    assert.equal(imported.statusCode, 201, imported.body);
    if (verifyScopes) report.scopeFixture = await seedHelperScopes(service,imported.json(),card);
    const created = await service.inject({method:'POST',url:'/api/conversations',
      payload:{characterId:imported.json().id}});
    assert.equal(created.statusCode, 201, created.body);
    const settings = await service.inject({method:'PUT',url:'/api/settings/provider',payload:{
      kind:'ollama',baseUrl:`http://127.0.0.1:${providerPort}/v1`,model:'packaged-helper-model',maxTokens:512,
    }});
    assert.equal(settings.statusCode, 200, settings.body);
    report.conversationId = created.json().id;
  } finally { await service.close(); }
  const manifest = JSON.parse(readFileSync(join(helperRoot, 'manifest.json'), 'utf8'));
  const paths = await filesUnder(helperRoot);
  const files = new Map(await Promise.all(paths.map(async path => [
    relative(helperRoot, path).split(sep).join('/'), await readFile(path),
  ])));
  const database = new DatabaseSync(databasePath);
  try {
    const runtime = new RuntimeRepository(database);
    runtime.installCodePlugin({manifest,files,plugin:{
      id:'js-slash-runner',kind:'sillytavern-js',displayName:manifest.display_name,
      version:manifest.version,author:manifest.author,license:'PolyForm Noncommercial 1.0.0',
      js:manifest.js,css:manifest.css,warnings:[],fileCount:files.size,
      totalBytes:[...files.values()].reduce((total,file) => total + file.length,0),
    }});
    runtime.setCodePluginEnabled('js-slash-runner',true);
  } finally { database.close(); }
}

async function launch(phase) {
  const portFile = join(profile, 'DevToolsActivePort');
  await unlink(portFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
  candidate = spawn(executable, [
    `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1', '--no-first-run',
  ], {windowsHide:true,stdio:'ignore'});
  const run = {phase,pid:candidate.pid}; report.runs.push(run);
  const port = await waitFor(async () => {
    try { return Number((await readFile(portFile,'utf8')).split('\n')[0]); } catch { return 0; }
  }, 90_000);
  const debuggerOrigin = `http://127.0.0.1:${port}`;
  const target = await waitFor(async () => {
    const tabs = await fetch(debuggerOrigin + '/json/list', {signal:AbortSignal.timeout(2000)}).then(r => r.json());
    return tabs.find(tab => tab.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(tab.url));
  });
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject) => { socket.addEventListener('open',resolve,{once:true}); socket.addEventListener('error',reject,{once:true}); });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('CDP target closed')); }
    pending.clear();
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if(verifyParameters && message.method==='Runtime.consoleAPICalled' && message.params.args.some(arg=>String(arg.value??arg.description).includes('Failed to import native createGenerationParameters')))
      (run.parameterFallbacks??=[]).push(message.params.args.map(arg=>arg.value??arg.description).join(' '));
    if(verifyParameters && message.method==='Network.requestWillBeSent' && message.params.request.url.endsWith('/api/backends/chat-completions/generate')) {
      const body=JSON.parse(message.params.request.postData||'{}');
      (run.parameterRequests??=[]).push({stream:body.stream,contextLimit:body._mycompanion_context_limit});
    }
    if (message.method === 'Runtime.exceptionThrown') report.errors.push({phase,type:'exception',details:message.params.exceptionDetails});
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error')
      report.errors.push({phase,type:'console',message:message.params.args.map(arg => arg.value ?? arg.description).join(' ')});
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
  });
  const send = (method, params={}) => new Promise((resolve,reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {pending.delete(id);reject(new Error('CDP timeout: '+method));},30_000);
    pending.set(id,{resolve,reject,timer});
    socket.send(JSON.stringify({id,method,params}));
  });
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  await send('Page.enable'); await send('Runtime.enable');
  if(verifyParameters)await send('Network.enable',{maxPostDataSize:1024*1024});
  await waitFor(() => evaluate('Boolean(document.querySelector("#root .desktop-shell"))'));
  await evaluate(`(()=>{
    const nav=[...document.querySelectorAll('nav[aria-label="主导航"] button')].find(button=>button.textContent?.includes('故事'));
    if (!nav) throw new Error('Story navigation missing'); nav.click();
  })()`);
  await waitFor(() => evaluate(`(()=>{
    const button=document.querySelector('.story-list-pane button[data-conversation-id=${JSON.stringify(report.conversationId)}]');
    if (!button) return false; button.click(); return true;
  })()`));
  await waitFor(() => evaluate(`import('/plugin-runtime/compat-runtime.js').then(host=>host.getContext().conversationId===${JSON.stringify(report.conversationId)})`));
  await waitFor(() => evaluate(`Boolean(window.TavernHelper && typeof window.TavernHelper.generate==='function')`));
  run.statuses = await evaluate(`import('/plugin-runtime/desktop-host.js').then(host=>host.getStatuses())`);
  assert.equal(run.statuses['js-slash-runner'],'扩展已运行');
  const scriptWindow = { webContents: { executeJavaScript: evaluate } };
  if (phase === 'initial') {
    run.generated = await evaluate(`TavernHelper.generate({user_input:'请说你好',should_stream:false})`);
    assert.equal(run.generated,'正式包助手回复');
    if(verifyParameters){
      run.streamGenerated=await evaluate(`TavernHelper.generate({user_input:'流式再说你好',should_stream:true})`);
      assert.equal(run.streamGenerated,'正式包助手回复');
      assert.deepEqual(run.parameterRequests?.map(request=>request.stream),[false,true]);
      assert(run.parameterRequests.every(request=>Number.isInteger(request.contextLimit) && request.contextLimit>0));
      assert.equal(run.parameterFallbacks?.length??0,0);
      report.stages.push('portable-original-helper-stream-and-nonstream-use-public-parameters-and-request-budgets');
    }
    await evaluate(`(async()=>{
      await TavernHelper.insertOrAssignVariables({portableHelper:{value:42}},{type:'chat'});
      await TavernHelper.triggerSlash('/setvar key=portableSlash 13');
      await (await import('/plugin-runtime/desktop-host.js')).flush();
    })()`);
    report.stages.push('portable-untouched-helper-initializes-generates-and-saves');
    if(verifyMacros){
      run.macroLifecycle=await verifyHelperMacroLifecycle(scriptWindow,providerBodies,'正式包助手回复');
      report.stages.push('portable-original-helper-macro-state-through-both-engines-and-both-transports');
    }
    if (verifyScripts) {
      run.scripts = await verifyHelperScriptsBeforeReload(scriptWindow, waitFor, '正式包助手回复');
      report.stages.push('portable-helper-script-generates-disables-reenables-updates-and-persists');
    }
    if (verifyScopes) {
      run.scopes={passed:false,stages:[]};
      await verifyHelperScopesBeforeReload(scriptWindow,waitFor,report.scopeFixture,run.scopes);
      report.stages.push('portable-helper-character-and-preset-scopes-fast-switch-and-delayed-save');
    }
  } else {
    run.variables = await evaluate(`TavernHelper.getVariables({type:'chat'})`);
    assert.equal(run.variables.portableHelper?.value,42);
    assert.equal(run.variables.portableSlash,'13');
    report.stages.push('portable-untouched-helper-and-variables-survive-full-restart');
    if (verifyScripts) {
      run.scripts = await verifyHelperScriptsAfterReload(scriptWindow, waitFor, 4, 5, '正式包助手回复');
      report.stages.push('portable-helper-script-and-data-survive-full-process-restart');
    }
    if (verifyScopes) {
      run.scopes=await verifyHelperScopesAfterReload(scriptWindow,waitFor);
      report.stages.push('portable-helper-character-and-preset-scopes-survive-full-process-restart');
    }
  }
  if (verifyViewer) {
    const origin = new URL(target.url).origin;
    const remoteService = { inject: async ({method,url,payload}) => {
      const response = await fetch(origin+url,{method,headers:{'Content-Type':'application/json'},...(payload ? {body:JSON.stringify(payload)} : {})});
      const data=await response.json();return {statusCode:response.status,json:()=>data};
    } };
    run.promptViewer={passed:false};
    await verifyHelperPromptViewer(scriptWindow,waitFor,remoteService,providerBodies,run.promptViewer,'正式包助手回复');
    report.stages.push('portable-original-prompt-viewer-refresh-dry-run-mutation-and-stop-'+phase);
  }
  await evaluate(`import('/plugin-runtime/desktop-host.js').then(host=>host.flush())`);
  run.statuses = await evaluate(`import('/plugin-runtime/desktop-host.js').then(host=>host.getStatuses())`);
  assert.equal(run.statuses.host,undefined);
  run.ownedProcesses = await captureChildren(candidate.pid);
  const closeStarted = Date.now();
  const closeCommand = send('Page.close').then(() => { run.closeCommand = 'acknowledged'; }, error => { run.closeCommandError = error.message; });
  run.shutdown = [];
  do {
    const all = await processes();
    const remaining = run.ownedProcesses.filter(child => all.some(process => process.ProcessId === child.ProcessId && process.CreationDate === child.CreationDate));
    const elapsedMs = Date.now() - closeStarted;
    run.shutdown.push({ elapsedMs, remainingPids: remaining.map(process => process.ProcessId), launcherExitCode: candidate.exitCode });
    if (run.engineStoppedMs === undefined && !remaining.some(process => process.ProcessId !== candidate.pid)) {
      run.engineStoppedMs = elapsedMs;
      run.serviceReachableAfterEngineExit = await fetch(new URL(target.url).origin, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);
    }
    if (candidate.exitCode !== null) break;
    await delay(2000);
  } while (Date.now() - closeStarted < 60_000);
  await closeCommand;
  run.exitCode = candidate.exitCode;
  run.allProcessesStoppedMs = run.shutdown.at(-1)?.remainingPids.length === 0 ? Date.now() - closeStarted : undefined;
  assert.notEqual(run.exitCode, null, 'Portable launcher did not exit within 60 seconds; see shutdown process samples');
  assert.equal(run.exitCode,0);
  assert(run.engineStoppedMs <= 20_000, 'Desktop processes took longer than 20 seconds to stop');
  assert.equal(run.shutdown.at(-1)?.remainingPids.length, 0, 'Owned processes remained after launcher exit');
  assert.equal(run.serviceReachableAfterEngineExit, false, 'Service remained reachable after process exit');
  socket.close();
  candidate = undefined;
}

try {
  report.executableSha256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
  report.helperEntrySha256 = createHash('sha256').update(readFileSync(join(helperRoot,'dist/index.js'))).digest('hex');
  assert.equal(report.helperEntrySha256,expectedHash);
  provider = createServer(async (request,response) => {
    if (request.url?.endsWith('/models')) {
      response.setHeader('Content-Type','application/json');
      response.end(JSON.stringify({data:[{id:'packaged-helper-model'}]})); return;
    }
    let raw=''; for await (const part of request) raw += part;
    report.providerRequests++;
    const body=JSON.parse(raw);providerBodies.push(body);
    assert(Array.isArray(body.messages));
    if(body.stream){response.setHeader('Content-Type','text/event-stream');response.end('data: '+JSON.stringify({choices:[{delta:{content:'正式包助手回复'}}]})+'\n\ndata: [DONE]\n\n');}
    else {response.setHeader('Content-Type','application/json');response.end(JSON.stringify({choices:[{message:{content:'正式包助手回复'}}]}));}
  });
  await new Promise(resolve => provider.listen(0,'127.0.0.1',resolve));
  await seedProfile(provider.address().port);
  for (const phase of ['initial','restart']) {
    assert(Date.now() < deadline,'Packaged helper verification timed out');
    await launch(phase);
  }
  if (verifyViewer) assert(report.providerRequests >= (verifyScripts ? 2 : 1) + 4);
  else assert.equal(report.providerRequests,(verifyScripts ? 2 : 1)+(verifyParameters?1:0)+(verifyMacros?4:0));
  report.passed=true;
  console.log(JSON.stringify({passed:true,stages:report.stages,providerRequests:report.providerRequests,
    executableSha256:report.executableSha256}));
} catch (error) {
  report.error=String(error?.stack||error);
  console.error(report.error);
  process.exitCode=1;
} finally {
  if (candidate?.pid) {
    const stopped = spawn('taskkill',['/PID',String(candidate.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
    await new Promise(resolve => stopped.once('close',resolve));
  }
  if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
  await mkdir(dirname(reportPath),{recursive:true});
  await writeFile(reportPath,JSON.stringify(report,null,2));
}
