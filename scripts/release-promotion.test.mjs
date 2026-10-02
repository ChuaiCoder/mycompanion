import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promoteVerifiedRelease } from './release-promotion.mjs';

async function fixture(run) {
  const project = await fs.mkdtemp(join(tmpdir(), 'mycompanion-promotion-test-'));
  try {
    await fs.mkdir(join(project, 'release')); await fs.mkdir(join(project, 'output'));
    await fs.writeFile(join(project, 'release/old.exe'), 'old verified version');
    const executable = join(project, 'new.exe'); await fs.writeFile(executable, 'new verified version');
    const manifest = { executable, executableSha256: createHash('sha256').update('new verified version').digest('hex') };
    await run({ project, manifest, acceptancePath: join(project, 'fixture-acceptance.json') });
  } finally { await fs.rm(project, { recursive: true, force: true }); }
}

test('promotes one executable with a committed receipt and recoverable former version', async () => fixture(async args => {
  const result = await promoteVerifiedRelease(args);
  assert.deepEqual(await fs.readdir(join(args.project, 'release')), ['new.exe']);
  assert.equal(await fs.readFile(join(result.archive, 'old.exe'), 'utf8'), 'old verified version');
  assert.equal(JSON.parse(await fs.readFile(join(result.archive, 'promotion.json'), 'utf8')).promoted, true);
}));

test('receipt preparation failure leaves the former release intact', async () => fixture(async args => {
  const io = { ...fs, writeFile: async (path, ...other) => {
    if (path.endsWith('promotion.pending.json')) throw new Error('injected receipt write failure');
    return fs.writeFile(path, ...other);
  } };
  await assert.rejects(promoteVerifiedRelease(args, io), /receipt write failure/);
  assert.deepEqual(await fs.readdir(join(args.project, 'release')), ['old.exe']);
  assert.equal(await fs.readFile(join(args.project, 'release/old.exe'), 'utf8'), 'old verified version');
}));

test('receipt commit failure after installing the new executable rolls back the entire swap', async () => fixture(async args => {
  const io = { ...fs, rename: async (from, to) => {
    if (from.endsWith('promotion.pending.json')) throw new Error('injected receipt commit failure');
    return fs.rename(from, to);
  } };
  await assert.rejects(promoteVerifiedRelease(args, io), /receipt commit failure/);
  assert.deepEqual(await fs.readdir(join(args.project, 'release')), ['old.exe']);
  assert.equal(await fs.readFile(join(args.project, 'release/old.exe'), 'utf8'), 'old verified version');
}));

test('stage checksum mismatch and occupied promotion lock cannot replace the release', async () => fixture(async args => {
  await assert.rejects(promoteVerifiedRelease({ ...args, manifest: { ...args.manifest, executableSha256: 'changed' } }), /Staged executable changed/);
  await fs.writeFile(join(args.project, 'release/.promotion.lock'), 'owned by another publisher');
  await assert.rejects(promoteVerifiedRelease(args), /EEXIST/);
  assert.equal(await fs.readFile(join(args.project, 'release/old.exe'), 'utf8'), 'old verified version');
  assert.equal(await fs.readFile(join(args.project, 'release/.promotion.lock'), 'utf8'), 'owned by another publisher');
}));
