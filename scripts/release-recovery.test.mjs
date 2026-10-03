import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash,randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { recoverReleasePromotion } from './release-recovery.mjs';

const hash=text=>createHash('sha256').update(text).digest('hex');
const promotionUrl=new URL('./release-promotion.mjs',import.meta.url).href;
async function fixture(work,sameName=false){
  const prefix=join(tmpdir(),'mycompanion-promotion-crash-'),project=await fs.mkdtemp(prefix);
  try{
    await fs.mkdir(join(project,'release'));await fs.mkdir(join(project,'output'));
    await fs.writeFile(join(project,'release/old.exe'),'old verified fixture');
    await fs.mkdir(join(project,'candidate'));
    const executable=join(project,'candidate',sameName?'old.exe':'new.exe');await fs.writeFile(executable,'new verified fixture');
    await work({project,manifest:{executable,executableSha256:hash('new verified fixture')},acceptancePath:join(project,'fixture-only-acceptance.json')});
  }finally{
    assert(resolve(project).startsWith(resolve(prefix)),'Fixture cleanup escaped its own directory');
    await fs.rm(project,{recursive:true,force:true});
  }
}
async function crashAt(args,step){
  // The child exits from the actual fs.rename completion, without catch/finally
  // rollback. These are process-interruption checks, not simulated exceptions.
  const code=`import * as fs from 'node:fs/promises';import {basename} from 'node:path';import {promoteVerifiedRelease} from ${JSON.stringify(promotionUrl)};
    const io={...fs,copyFile:async(from,to)=>{if(${JSON.stringify(step)}==='during-copy'){await fs.writeFile(to,(await fs.readFile(from)).subarray(0,6));process.exit(73);}await fs.copyFile(from,to);},rename:async(from,to)=>{await fs.rename(from,to);const step=${JSON.stringify(step)};
      if(step==='after-old-move'&&from.includes('release')&&basename(to)==='old.exe')process.exit(73);
      if(step==='after-install'&&from.endsWith('.pending'))process.exit(73);
      if(step==='after-commit'&&from.endsWith('promotion.pending.json'))process.exit(73);}};
    await promoteVerifiedRelease(${JSON.stringify(args)},io);`;
  const child=spawn(process.execPath,['--input-type=module','--eval',code],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>output+=bytes);
  const exit=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done);});
  assert.equal(exit,73,output);return child.pid;
}
for(const step of ['after-old-move','after-install','after-commit'])test('recovers an actual stopped publisher '+step,()=>fixture(async args=>{
  await crashAt(args,step);
  const result=await recoverReleasePromotion(args.project);
  const committed=step==='after-commit';
  assert.equal(result.status,committed?'committed-promotion-cleaned':'uncommitted-promotion-rolled-back');
  assert.deepEqual(await fs.readdir(join(args.project,'release')),[committed?'new.exe':'old.exe']);
  assert.equal(await fs.readFile(join(args.project,'release',committed?'new.exe':'old.exe'),'utf8'),committed?'new verified fixture':'old verified fixture');
  assert.equal((await recoverReleasePromotion(args.project)).status,'no-pending-promotion');
}));
test('restores the same-version filename after a process exits with the uncommitted candidate installed',()=>fixture(async args=>{
  await crashAt(args,'after-install');
  await recoverReleasePromotion(args.project);
  assert.equal(await fs.readFile(join(args.project,'release/old.exe'),'utf8'),'old verified fixture');
  assert.deepEqual(await fs.readdir(join(args.project,'release')),['old.exe']);
},true));
test('live publisher, corrupted archive and unsafe journal cannot silently replace or delete existing bytes',()=>fixture(async args=>{
  await crashAt(args,'after-install');
  const lock=join(args.project,'release/.promotion.lock'),journal=JSON.parse(await fs.readFile(lock,'utf8'));
  await assert.rejects(recoverReleasePromotion(args.project,fs,()=>true),/still running/);
  const archive=join(args.project,'.cache/packaging/former-releases',journal.transactionId,'old.exe');
  await fs.writeFile(archive,'tampered archive');
  await assert.rejects(recoverReleasePromotion(args.project),/archive changed/);
  assert.equal(await fs.readFile(join(args.project,'release/new.exe'),'utf8'),'new verified fixture');
  journal.filename='../outside.exe';await fs.writeFile(lock,JSON.stringify(journal));
  await assert.rejects(recoverReleasePromotion(args.project),/Invalid promotion target/);
  assert.equal(await fs.readFile(archive,'utf8'),'tampered archive');
}));
test('no archive/stage yet is a recoverable interruption before the first write',()=>fixture(async args=>{
  const transactionId=randomUUID();await fs.writeFile(join(args.project,'release/.promotion.lock'),JSON.stringify({formatVersion:2,transactionId,pid:process.pid,
    filename:'new.exe',executableSha256:args.manifest.executableSha256,previousFiles:[{name:'old.exe',sha256:hash('old verified fixture')}]}));
  assert.equal((await recoverReleasePromotion(args.project,fs,()=>false)).status,'uncommitted-promotion-rolled-back');
  assert.deepEqual(await fs.readdir(join(args.project,'release')),['old.exe']);
}));
test('an actual interrupted stage copy is preserved while the verified former release is restored',()=>fixture(async args=>{
  await crashAt(args,'during-copy');
  const journal=JSON.parse(await fs.readFile(join(args.project,'release/.promotion.lock'),'utf8'));
  const result=await recoverReleasePromotion(args.project);
  assert.equal(result.status,'uncommitted-promotion-rolled-back');
  assert.equal(await fs.readFile(join(args.project,'release/old.exe'),'utf8'),'old verified fixture');
  assert.equal(await fs.readFile(join(args.project,'.cache/packaging/former-releases',journal.transactionId,'interrupted-stage.pending'),'utf8'),'new ve');
  assert.deepEqual(await fs.readdir(join(args.project,'release')),['old.exe']);
}));
test('an interrupted recovery can finish after explicit verification and clearing of its dead-process lock',()=>fixture(async args=>{
  await crashAt(args,'after-install');
  const recoveryUrl=new URL('./release-recovery.mjs',import.meta.url).href;
  const code=`import * as fs from 'node:fs/promises';import {basename} from 'node:path';import {recoverReleasePromotion} from ${JSON.stringify(recoveryUrl)};
    const io={...fs,rename:async(from,to)=>{await fs.rename(from,to);if(basename(to)==='old.exe')process.exit(73);}};
    await recoverReleasePromotion(${JSON.stringify(args.project)},io);`;
  const child=spawn(process.execPath,['--input-type=module','--eval',code],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';child.stderr.on('data',bytes=>output+=bytes);
  assert.equal(await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done);}),73,output);
  const lock=join(args.project,'release/.recovery.lock');
  const lockValue=JSON.parse(await fs.readFile(lock,'utf8'));
  assert.equal(lockValue.pid,child.pid);
  const journal=JSON.parse(await fs.readFile(join(args.project,'release/.promotion.lock'),'utf8'));
  assert.equal(lockValue.transactionId,journal.transactionId);
  await assert.rejects(recoverReleasePromotion(args.project),error=>error.code==='EEXIST');
  // This models the documented operator check; production never steals locks.
  await fs.rm(lock);
  assert.equal((await recoverReleasePromotion(args.project)).status,'uncommitted-promotion-rolled-back');
  assert.equal(await fs.readFile(join(args.project,'release/old.exe'),'utf8'),'old verified fixture');
  assert.deepEqual(await fs.readdir(join(args.project,'release')),['old.exe']);
}));
test('a journal-only transaction cannot create a quarantine through a substituted archive parent',()=>fixture(async args=>{
  const transactionId=randomUUID();await fs.mkdir(join(args.project,'.cache'));await fs.mkdir(join(args.project,'unrelated'));
  await fs.symlink(join(args.project,'unrelated'),join(args.project,'.cache/packaging'),'junction');
  await fs.writeFile(join(args.project,'release/.promotion.lock'),JSON.stringify({formatVersion:2,transactionId,pid:process.pid,
    filename:'new.exe',executableSha256:args.manifest.executableSha256,previousFiles:[{name:'old.exe',sha256:hash('old verified fixture')}]}));
  await fs.writeFile(join(args.project,'release',`new.exe.${transactionId}.pending`),'unknown interrupted bytes');
  await assert.rejects(recoverReleasePromotion(args.project,fs,()=>false),/Archive directory escaped/);
  assert.equal(await fs.readFile(join(args.project,'release/old.exe'),'utf8'),'old verified fixture');
  assert.deepEqual(await fs.readdir(join(args.project,'unrelated')),[]);
}));
