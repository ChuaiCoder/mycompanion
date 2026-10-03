import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import * as filesystem from 'node:fs/promises';
import { basename, join } from 'node:path';

/** The caller validates acceptance evidence before entering this file transaction. */
export async function promoteVerifiedRelease({ project, manifest, acceptancePath }, io = filesystem) {
  const release = join(project, 'release');
  assert.equal((await io.readdir(join(project, 'output'))).length, 0, 'output must remain empty');
  const filename = basename(manifest.executable);
  assert(/^[^\\/:]+\.exe$/i.test(filename), 'Candidate must be an executable filename');
  await io.mkdir(release, { recursive: true });
  const lock = join(release, '.promotion.lock');
  const transactionId=randomUUID();
  const previous=(await io.readdir(release)).filter(name=>/\.exe$/i.test(name));
  const previousFiles=await Promise.all(previous.map(async name=>({name,sha256:createHash('sha256').update(await io.readFile(join(release,name))).digest('hex')})));
  // Flush an immutable journal before changing any former release. Recovery
  // derives paths from this transaction ID, never arbitrary journal paths.
  await io.writeFile(lock, JSON.stringify({formatVersion:2,transactionId,pid:process.pid,filename,
    candidate:manifest.executable,executableSha256:manifest.executableSha256,previousFiles,startedAt:new Date().toISOString()}),{flag:'wx',flush:true});
  const archive = join(project, '.cache/packaging/former-releases',transactionId);
  const staged = join(release, filename + '.' + transactionId + '.pending');
  const target = join(release, filename);
  const moved = [];
  let installed = false, completed = false, rollbackFailed = false;
  try {
    await io.mkdir(archive, { recursive: true });
    await io.copyFile(manifest.executable, staged);
    assert.equal(createHash('sha256').update(await io.readFile(staged)).digest('hex'), manifest.executableSha256, 'Staged executable changed');
    // Prepare the receipt before touching the former executable. Its final
    // rename is the commit point; any earlier failure restores the old files.
    const pendingReceipt = join(archive, 'promotion.pending.json');
    await io.writeFile(pendingReceipt, JSON.stringify({ ...manifest, promoted: true,
      promotedAt: new Date().toISOString(), acceptancePath, previous }, null, 2) + '\n', { flag: 'wx' });
    for (const name of previous) {
      assert.equal(createHash('sha256').update(await io.readFile(join(release,name))).digest('hex'),previousFiles.find(item=>item.name===name).sha256,'Former release changed during promotion');
      await io.rename(join(release, name), join(archive, name)); moved.push(name);
    }
    await io.rename(staged, target); installed = true;
    const actual = (await io.readdir(release)).filter(name => /\.exe$/i.test(name));
    assert.deepEqual(actual, [filename], 'Promotion must leave one verified executable');
    await io.rename(pendingReceipt, join(archive, 'promotion.json'));
    completed = true;
    return { target, archive };
  } catch (error) {
    const rollbackErrors = [];
    if (installed) {
      try { await io.rename(target, staged); }
      catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    for (const name of moved.reverse()) {
      try { await io.rename(join(archive, name), join(release, name)); }
      catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    rollbackFailed = rollbackErrors.length > 0;
    if (rollbackFailed) throw new AggregateError([error, ...rollbackErrors], 'Promotion failed; inspect the retained lock and release archive before retrying');
    throw error;
  } finally {
    if (!rollbackFailed) {
      await io.rm(staged, { force: true });
      await io.rm(lock, { force: true });
    }
    // After commit a leftover lock is harmless and must never trigger rollback.
    if (completed) console.log('Promoted one verified release: ' + target);
  }
}
