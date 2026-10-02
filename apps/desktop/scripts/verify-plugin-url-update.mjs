// Exercises the real isomorphic-git URL path against a disposable smart-HTTP Git repository.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../local-service/dist/app.js';

const temporary = await mkdtemp(join(tmpdir(), 'mycompanion-git-update-'));
const work = join(temporary, 'work');
const bare = join(temporary, 'fixture.git');
const databasePath = join(temporary, 'profile.sqlite');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const labelIndex = process.argv.indexOf('--report-label');
const reportLabel = labelIndex >= 0 ? process.argv[labelIndex + 1] : '';
assert(labelIndex < 0 || /^[a-z0-9-]+$/.test(reportLabel ?? ''), 'Invalid report label');
const exeIndex = process.argv.indexOf('--exe');
const executable = exeIndex >= 0 ? resolve(process.argv[exeIndex + 1]) : null;
if (executable) assert(existsSync(executable), 'Packaged EXE does not exist');
let app;
let server;
let candidate;
const serviceReport = { passed: false, checkedAt: new Date().toISOString(), scope: 'Source service against actual disposable Git smart HTTP', stages: [] };
const serviceReportPath = join(root, '.cache/reports', `plugin-url-ref-update-${new Date().toISOString().replace(/[^0-9TZ]/g, '')}.json`);

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function waitFor(predicate, timeout = 45_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try { const result = await predicate(); if (result) return result; } catch { /* Navigation can destroy the old page context. */ }
    await delay(100);
  }
  throw new Error('Timed out waiting for packaged URL installation or update');
}

function git(args, cwd = temporary) {
  const result = spawnSync('git', args, {cwd, encoding:'utf8'});
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr || result.error}`);
  return result.stdout.trim();
}

async function writeVersion(version, marker) {
  await writeFile(join(work, 'manifest.json'), JSON.stringify({
    display_name:'URL Update Fixture', version, js:'index.js', license:'MIT',
  }));
  await writeFile(join(work, 'index.js'), `globalThis.__urlUpdateMarker = ${JSON.stringify(marker)};\n`);
  git(['add', '.'], work);
  git(['commit', '-m', version], work);
  git(['push', 'origin', 'main'], work);
  return git(['rev-parse', 'HEAD'], work);
}

function smartHttp(request, response) {
  const url = new URL(request.url || '/', 'http://localhost');
  const child = spawn('git', ['http-backend'], {env:{...process.env,
    GIT_PROJECT_ROOT:temporary, GIT_HTTP_EXPORT_ALL:'1',
    PATH_INFO:url.pathname, QUERY_STRING:url.search.slice(1),
    REQUEST_METHOD:request.method || 'GET', CONTENT_TYPE:request.headers['content-type'] || '',
    CONTENT_LENGTH:request.headers['content-length'] || '', SERVER_PROTOCOL:'HTTP/1.1',
  }});
  request.pipe(child.stdin);
  const parts = [];
  child.stdout.on('data', part => parts.push(part));
  child.on('error', error => { if (!response.headersSent) response.writeHead(500); response.end(String(error)); });
  child.on('close', code => {
    if (response.writableEnded) return;
    const output = Buffer.concat(parts);
    const separator = output.indexOf('\r\n\r\n');
    const alternate = separator < 0 ? output.indexOf('\n\n') : -1;
    const boundary = separator >= 0 ? separator : alternate;
    if (code !== 0 || boundary < 0) { response.writeHead(500); response.end(`git http-backend exited ${code}`); return; }
    const headers = output.subarray(0, boundary).toString('utf8').split(/\r?\n/);
    const values = {};
    let status = 200;
    for (const line of headers) {
      const index = line.indexOf(':');
      if (index < 0) continue;
      const key = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim();
      if (key.toLowerCase() === 'status') status = Number(value.slice(0, 3));
      else values[key] = value;
    }
    response.writeHead(status, values);
    response.end(output.subarray(boundary + (separator >= 0 ? 4 : 2)));
  });
}

async function verifyPackaged(sourceUrl, installedRevision) {
  const profile = join(temporary, 'packaged-profile');
  await mkdir(profile);
  const reportPath = join(root, '.cache/reports', reportLabel ? 'packaged-'+reportLabel+'-verification.json' : 'packaged-plugin-url-update-verification.json');
  const report = {passed:false,executable,profile,sourceUrl,stages:[],errors:[],
    executableSha256:createHash('sha256').update(readFileSync(executable)).digest('hex')};
  let socket;
  try {
    candidate = spawn(executable, [
      `--user-data-dir=${profile}`, '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1', '--no-first-run',
    ], {windowsHide:true,stdio:'ignore',env:{...process.env,
      PATH:join(process.env.SystemRoot || 'C:\\Windows','System32')}});
    const port = await waitFor(async () => {
      try { return Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]); }
      catch { return 0; }
    },90_000);
    const debuggerOrigin = `http://127.0.0.1:${port}`;
    const target = await waitFor(async () => {
      const tabs = await fetch(debuggerOrigin+'/json/list',{signal:AbortSignal.timeout(2000)}).then(r=>r.json());
      return tabs.find(tab=>tab.type==='page' && /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(tab.url));
    });
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
    let nextId=0;
    const pending=new Map();
    socket.addEventListener('close',()=>{
      for(const request of pending.values()){clearTimeout(request.timer);request.reject(new Error('CDP target closed'));}
      pending.clear();
    });
    socket.addEventListener('message',event=>{
      const message=JSON.parse(event.data);
      if(message.method==='Runtime.exceptionThrown')report.errors.push({type:'exception',details:message.params.exceptionDetails});
      const request=pending.get(message.id);
      if(!request)return;
      pending.delete(message.id);clearTimeout(request.timer);
      if(message.error)request.reject(new Error(message.error.message));else request.resolve(message.result);
    });
    const send=(method,params={})=>new Promise((resolve,reject)=>{
      const id=++nextId;
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method));},30_000);
      pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
    });
    const evaluate=async expression=>{
      const reply=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
      if(reply.exceptionDetails)throw new Error(JSON.stringify(reply.exceptionDetails));
      return reply.result.value;
    };
    const enterUrl=async()=>{
      await waitFor(()=>evaluate('Boolean(document.querySelector(\'input[aria-label="扩展仓库地址"]\'))'));
      await evaluate(`(()=>{
        const input=document.querySelector('input[aria-label="扩展仓库地址"]');
        const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
        setter.call(input,${JSON.stringify(sourceUrl)});
        input.dispatchEvent(new Event('input',{bubbles:true}));
      })()`);
      await waitFor(()=>evaluate(`Boolean([...document.querySelectorAll('.plugin-install-actions button')].find(button=>!button.disabled))`));
      await evaluate(`[...document.querySelectorAll('.plugin-install-actions button')].find(button=>!button.disabled).click()`);
    };
    await send('Page.enable');await send('Runtime.enable');
    await waitFor(()=>evaluate('Boolean(document.querySelector("#root .desktop-shell"))'));
    await evaluate(`(()=>{
      const nav=[...document.querySelectorAll('nav[aria-label="主导航"] button')].find(button=>button.textContent?.includes('插件'));
      if(!nav)throw new Error('Plugin navigation missing');nav.click();
    })()`);
    await enterUrl();
    const first=await waitFor(()=>evaluate(`fetch('/api/code-plugins').then(r=>r.json()).then(data=>{
      const plugin=data.items.find(item=>item.id==='fixture');
      return plugin?.sourceRevision===${JSON.stringify(installedRevision)}?plugin:null;
    })`));
    assert.equal(first.version,'1.1.0');assert.equal(first.enabled,false);
    report.stages.push('portable-ui-git-url-install-without-system-git');
    await waitFor(()=>evaluate(`Boolean([...document.querySelectorAll('.code-plugin-list button')].find(button=>button.textContent==='启用'))`));
    await evaluate(`[...document.querySelectorAll('.code-plugin-list button')].find(button=>button.textContent==='启用').click()`);
    await waitFor(()=>evaluate(`globalThis.__urlUpdateMarker==='second'`));
    const enabled=await evaluate(`fetch('/api/code-plugins').then(r=>r.json()).then(data=>data.items.find(item=>item.id==='fixture'))`);
    assert.equal(enabled.enabled,true);
    report.stages.push('portable-ui-enabled-js-runs-after-reload');
    const nextRevision=await writeVersion('1.2.0','third');
    await enterUrl();
    await waitFor(()=>evaluate(`globalThis.__urlUpdateMarker==='third'`));
    const updated=await evaluate(`fetch('/api/code-plugins').then(r=>r.json()).then(data=>data.items.find(item=>item.id==='fixture'))`);
    assert.equal(updated.version,'1.2.0');
    assert.equal(updated.sourceRevision,nextRevision);
    assert.equal(updated.enabled,true);
    assert.equal(updated.installedAt,first.installedAt);
    report.stages.push('portable-ui-same-url-update-retains-enabled-state-and-runs-new-js');
    report.firstRevision=installedRevision;report.updatedRevision=nextRevision;
    const exited=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Portable launcher did not exit')),60_000);
      candidate.once('exit',code=>{clearTimeout(timer);resolve(code);});
    });
    try{await send('Page.close');}catch{/* Closing the target can race with its CDP reply. */}
    report.exitCode=await exited;
    assert.equal(report.exitCode,0);
    candidate=undefined;
    report.passed=true;
    return report;
  }catch(error){report.error=String(error?.stack||error);throw error;}
  finally{
    socket?.close();
    if(candidate?.pid){
      const stopped=spawn('taskkill',['/PID',String(candidate.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
      await new Promise(resolve=>stopped.once('close',resolve));
      candidate=undefined;
    }
    await mkdir(dirname(reportPath),{recursive:true});
    await writeFile(reportPath,JSON.stringify(report,null,2));
  }
}

try {
  await mkdir(work);
  git(['init', '--bare', '--initial-branch=main', bare]);
  git(['init', '--initial-branch=main', work]);
  git(['config', 'user.email', 'fixture@example.invalid'], work);
  git(['config', 'user.name', 'Fixture'], work);
  git(['remote', 'add', 'origin', bare], work);
  const firstRevision = await writeVersion('1.0.0', 'first');
  server = createServer(smartHttp);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const sourceUrl = `http://127.0.0.1:${server.address().port}/fixture.git`;
  app = buildApp({databasePath});

  const installed = await app.inject({method:'POST', url:'/api/code-plugins/install-url',
    payload:{url:sourceUrl}});
  assert.equal(installed.statusCode, 201, installed.body);
  assert.equal(installed.json().sourceRevision, firstRevision);
  assert.equal(installed.json().enabled, false);
  serviceReport.stages.push('default-branch-url-install');
  const enabled = await app.inject({method:'PUT',url:'/api/code-plugins/fixture/enabled',payload:{enabled:true}});
  assert.equal(enabled.statusCode, 200);
  const saved = await app.inject({method:'PUT',url:'/api/code-plugins/fixture/contributions',
    payload:{systemPrompt:'Retain across URL update',commands:[]}});
  assert.equal(saved.statusCode, 200);
  const secondRevision = await writeVersion('1.1.0', 'second');
  const updated = await app.inject({method:'POST',url:'/api/code-plugins/install-url',payload:{url:sourceUrl}});
  assert.equal(updated.statusCode, 201, updated.body);
  assert.equal(updated.json().sourceRevision, secondRevision);
  assert.equal(updated.json().version, '1.1.0');
  assert.equal(updated.json().enabled, true);
  assert.equal(updated.json().installedAt, installed.json().installedAt);
  const asset = await app.inject({method:'GET',url:'/scripts/extensions/third-party/fixture/index.js'});
  assert.equal(asset.statusCode, 200);
  assert.match(asset.body, /second/);
  serviceReport.stages.push('same-url-update-retains-state-and-assets');
  const backup = (await app.inject({method:'GET',url:'/api/backup'})).json();
  assert.equal(backup.codePlugins.find(item => item.id === 'fixture').contributions.systemPrompt,
    'Retain across URL update');
  const check = async () => {
    const response = await app.inject({ method:'POST', url:'/api/code-plugins/fixture/check-update' });
    assert.equal(response.statusCode,200,response.body); return response.json();
  };
  assert.equal((await check()).state,'up_to_date');
  git(['tag','-a','v1.0','-m','Original fixture release',firstRevision],work);
  git(['push','origin','v1.0'],work);
  git(['branch','alternate',firstRevision],work);
  git(['push','origin','alternate'],work);
  const refs = (await check()).refs;
  assert(refs.some(item => item.ref==='refs/heads/alternate' && item.revision===firstRevision));
  assert(refs.some(item => item.ref==='refs/tags/v1.0' && item.revision===firstRevision));
  serviceReport.stages.push('lists-actual-branches-and-peeled-annotated-tag');
  const update = async (expectedRevision,branch,status=200) => {
    const response = await app.inject({ method:'POST',url:'/api/code-plugins/fixture/update',payload:{expectedRevision,...(branch?{branch}:{})} });
    assert.equal(response.statusCode,status,response.body); return response.json();
  };
  const tag = await update(secondRevision,'refs/tags/v1.0');
  assert.equal(tag.sourceRef,'refs/tags/v1.0'); assert.equal(tag.sourceRevision,firstRevision);
  assert.equal((await check()).state,'up_to_date');
  serviceReport.stages.push('actual-annotated-tag-switch-and-update-status');
  const alternative = await update(firstRevision,'refs/heads/alternate');
  assert.equal(alternative.sourceRef,'refs/heads/alternate'); assert.equal(alternative.enabled,true);
  git(['push','origin','--delete','alternate'],work);
  assert.equal((await check()).state,'ref_missing');
  await update(firstRevision,undefined,422);
  assert.match((await app.inject({method:'GET',url:'/scripts/extensions/third-party/fixture/index.js'})).body,/first/);
  serviceReport.stages.push('deleted-branch-is-explicit-and-failed-update-retains-old-assets');
  const returned = await update(firstRevision,'refs/heads/main');
  assert.equal(returned.sourceRevision,secondRevision); assert.equal(returned.enabled,true);
  await update(firstRevision,undefined,409);
  serviceReport.stages.push('branch-switch-back-and-stale-revision-rejection');
  const failedInstall = await app.inject({method:'POST',url:'/api/code-plugins/install-url',payload:{url:sourceUrl,branch:'refs/heads/absent'}});
  assert.equal(failedInstall.statusCode,422);
  assert.match((await app.inject({method:'GET',url:'/scripts/extensions/third-party/fixture/index.js'})).body,/second/);
  serviceReport.stages.push('missing-install-ref-leaves-installed-extension-intact');
  const packaged = executable ? await verifyPackaged(sourceUrl, secondRevision) : null;
  console.log(JSON.stringify({passed:true,sourceUrl,firstRevision,secondRevision,
    version:updated.json().version,enabled:updated.json().enabled,contributionsRetained:true,
    packaged:packaged && {passed:packaged.passed,stages:packaged.stages,executableSha256:packaged.executableSha256}}));
  Object.assign(serviceReport,{ passed:true,firstRevision,secondRevision,sourceUrl,systemGitUsedByApp:false });
} catch(error) {
  serviceReport.error=String(error?.stack??error); throw error;
} finally {
  await app?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(temporary, {recursive:true,force:true});
  await mkdir(dirname(serviceReportPath),{recursive:true});
  await writeFile(serviceReportPath,JSON.stringify(serviceReport,null,2)+'\n',{flag:'wx'});
  console.log('Report: '+serviceReportPath);
}
