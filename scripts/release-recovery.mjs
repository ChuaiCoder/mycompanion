import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as filesystem from 'node:fs/promises';
import { join,resolve,sep } from 'node:path';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const validName=name=>typeof name==='string'&&/^[^\\/:]+\.exe$/i.test(name)&&!['.','..'].includes(name);
const validHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value);
const exists=async(io,path)=>{try{await io.access(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
async function checkArchiveDirectories(io,root,archive){
  for(const path of [join(root,'.cache'),join(root,'.cache/packaging'),join(root,'.cache/packaging/former-releases'),archive]){
    if(!await exists(io,path))continue;
    assert((await io.lstat(path)).isDirectory()&&await io.realpath(path)===resolve(path),'Archive directory escaped the project');
  }
}
export function processIsRunning(pid){try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}}

/** Recover only a dead process's own verified file transaction. No acceptance
 * gate is bypassed: an uncommitted candidate is quarantined, never promoted. */
export async function recoverReleasePromotion(project,io=filesystem,isRunning=processIsRunning){
  const root=await io.realpath(project),release=join(root,'release'),lock=join(release,'.promotion.lock');
  if(!await exists(io,lock))return {status:'no-pending-promotion'};
  assert.equal(await io.realpath(release),resolve(release),'Release directory must stay inside its project');
  const journal=JSON.parse(await io.readFile(lock,'utf8'));
  assert(journal.formatVersion===2&&/^[a-f0-9-]{36}$/i.test(journal.transactionId),'Unknown promotion journal; preserve it for inspection');
  assert(Number.isSafeInteger(journal.pid)&&journal.pid>0&&!isRunning(journal.pid),'Promotion process is still running');
  assert(validName(journal.filename)&&validHash(journal.executableSha256),'Invalid promotion target');
  assert(Array.isArray(journal.previousFiles)&&journal.previousFiles.every(item=>validName(item.name)&&validHash(item.sha256)),'Invalid former release inventory');
  assert.equal(new Set(journal.previousFiles.map(item=>item.name)).size,journal.previousFiles.length,'Duplicate former release names');
  const archive=join(root,'.cache/packaging/former-releases',journal.transactionId);
  const staged=join(release,journal.filename+'.'+journal.transactionId+'.pending'),target=join(release,journal.filename);
  // Refuse junction/symlink escapes before moving or deleting a derived path.
  assert(archive.startsWith(root+sep),'Archive directory escaped the project');
  await checkArchiveDirectories(io,root,archive);
  for(const path of [lock,staged,target,join(archive,'promotion.json'),join(archive,'recovery.json'),
    ...journal.previousFiles.flatMap(item=>[join(release,item.name),join(archive,item.name)])])
    if(await exists(io,path))assert((await io.lstat(path)).isFile()&&!(await io.lstat(path)).isSymbolicLink(),'Promotion paths must be regular files');
  const recoveryLock=join(release,'.recovery.lock');
  await io.writeFile(recoveryLock,JSON.stringify({pid:process.pid,transactionId:journal.transactionId}),{flag:'wx',flush:true});
  try{
    // copyFile can be interrupted before checksum validation. Preserve its
    // exact internal staging bytes instead of deleting them or blocking a
    // verified old release's restoration on a naturally incomplete copy.
    const preserveStage=async()=>{
      if(!await exists(io,staged))return;
      await io.mkdir(archive,{recursive:true});await checkArchiveDirectories(io,root,archive);
      const quarantine=join(archive,'interrupted-stage.pending');
      assert(!await exists(io,quarantine),'Stage quarantine is already occupied');
      await io.rename(staged,quarantine);
    };
    const receipt=join(archive,'promotion.json');
    if(await exists(io,receipt)){
      const committed=JSON.parse(await io.readFile(receipt,'utf8'));
      assert(committed.promoted===true&&committed.executableSha256===journal.executableSha256,'Committed receipt disagrees with the journal');
      assert.equal(hash(await io.readFile(target)),journal.executableSha256,'Committed executable changed');
      assert.deepEqual((await io.readdir(release)).filter(name=>/\.exe$/i.test(name)),[journal.filename],'Committed release inventory changed');
      await preserveStage();await io.rm(lock,{force:true});
      return {status:'committed-promotion-cleaned',target,archive};
    }
    // Validate all sources before the first restoration; unrelated files or
    // corrupted old/candidate bytes must not be silently overwritten.
    for(const item of journal.previousFiles){
      const old=join(release,item.name),backup=join(archive,item.name);
      const oldHash=await exists(io,old)?hash(await io.readFile(old)):undefined;
      const backupHash=await exists(io,backup)?hash(await io.readFile(backup)):undefined;
      if(backupHash!==undefined)assert.equal(backupHash,item.sha256,'Former archive changed: '+item.name);
      assert(oldHash===item.sha256||backupHash===item.sha256,'A recoverable former release is missing: '+item.name);
      if(oldHash!==undefined&&oldHash!==item.sha256)assert(item.name===journal.filename&&oldHash===journal.executableSha256,'Unrelated release bytes must be preserved: '+item.name);
    }
    const priorNames=new Set(journal.previousFiles.map(item=>item.name));
    const actual=(await io.readdir(release)).filter(name=>/\.exe$/i.test(name));
    assert(actual.every(name=>priorNames.has(name)||name===journal.filename),'Unrelated executable appeared during promotion');
    const targetHash=await exists(io,target)?hash(await io.readFile(target)):undefined;
    const formerTarget=journal.previousFiles.find(item=>item.name===journal.filename);
    if(targetHash!==undefined&&targetHash!==formerTarget?.sha256){
      assert.equal(targetHash,journal.executableSha256,'Uncommitted executable changed');
      const quarantine=join(archive,'uncommitted-candidate.exe');
      assert(!await exists(io,quarantine),'Candidate quarantine is already occupied');
      await io.rename(target,quarantine);
    }
    for(const item of journal.previousFiles){
      const old=join(release,item.name);
      if(!await exists(io,old))await io.rename(join(archive,item.name),old);
      assert.equal(hash(await io.readFile(old)),item.sha256,'Restored release checksum mismatch');
    }
    await preserveStage();
    assert.deepEqual((await io.readdir(release)).filter(name=>/\.exe$/i.test(name)).sort(),[...priorNames].sort(),'Recovery inventory mismatch');
    if(await exists(io,archive)){
      const receipt=join(archive,'recovery.json');
      if(await exists(io,receipt)){
        const restored=JSON.parse(await io.readFile(receipt,'utf8'));
        assert(restored.status==='rolled-back'&&restored.transactionId===journal.transactionId,'Recovery receipt changed');
      }else await io.writeFile(receipt,JSON.stringify({status:'rolled-back',recoveredAt:new Date().toISOString(),transactionId:journal.transactionId}),{flag:'wx',flush:true});
    }
    await io.rm(lock,{force:true});
    return {status:'uncommitted-promotion-rolled-back',archive};
  }finally{await io.rm(recoveryLock,{force:true});}
}
