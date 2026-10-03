import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const label = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 17);
const candidate = join(project, '.cache/packaging/candidates', label);
const logPath = join(candidate, 'build.log');
await mkdir(dirname(candidate), { recursive: true });
await mkdir(candidate);
const log = createWriteStream(logPath, { flags: 'wx' });
const sha256 = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const run = (args, cwd = project, extraEnvironment = {}) => new Promise((done, reject) => {
  const child = spawn('npm', args, { cwd, env: { ...process.env, ...extraEnvironment }, windowsHide: true, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', bytes => { process.stdout.write(bytes); log.write(bytes); });
  child.stderr.on('data', bytes => { process.stderr.write(bytes); log.write(bytes); });
  child.once('error', reject); child.once('exit', code => code === 0 ? done() : reject(new Error('npm exited ' + code)));
});
let source;
const assertFrozen = async () => {
  for (const file of source.files) assert.equal(await sha256(join(project, file.path)), file.sha256, 'Source changed during candidate creation: ' + file.path);
};
try {
  // Freeze before checks/build; reject concurrent source changes instead of
  // associating green results or an executable with a different source tree.
  await run(['run', 'prepare:source']);
  source = JSON.parse(await readFile(join(project, '.cache/packaging/independent-source/source-manifest.json'), 'utf8'));
  const sourceManifestSha256 = await sha256(join(project, '.cache/packaging/independent-source/source-manifest.json'));
  await run(['run', 'check']);
  await run(['run', 'build', '-w', '@mycompanion/desktop']);
  await assertFrozen();
  await run(['run', 'package:win', '-w', '@mycompanion/desktop', '--', '--config.directories.output=' + candidate], project, {
    MYCOMPANION_CANDIDATE_SOURCE_SHA256: source.archiveSha256,
    MYCOMPANION_CANDIDATE_SOURCE_MANIFEST_SHA256: sourceManifestSha256,
  });
  await assertFrozen();
  assert.equal(await sha256(join(project, '.cache/packaging/independent-source/MyCompanion-source.tar.gz')), source.archiveSha256, 'Source staging archive changed during candidate creation');
  assert.equal(await sha256(join(project, '.cache/packaging/independent-source/source-manifest.json')), sourceManifestSha256, 'Source staging manifest changed during candidate creation');
  const { version } = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
  const executable = join(candidate, `MyCompanion-${version}-windows-x64.exe`);
  for (const file of ['MyCompanion-source.tar.gz', 'source-manifest.json']) await copyFile(join(project, '.cache/packaging/independent-source', file), join(candidate, file));
  assert.equal(await sha256(join(candidate, 'MyCompanion-source.tar.gz')), source.archiveSha256, 'Candidate source copy differs from the frozen archive');
  assert.equal(await sha256(join(candidate, 'source-manifest.json')), sourceManifestSha256, 'Candidate manifest copy differs from the frozen manifest');
  const manifest = { formatVersion: 1, createdAt: new Date().toISOString(), executable,
    executableSha256: await sha256(executable), sourceSha256: source.archiveSha256, sourceManifestSha256,
    sourceFileCount: source.files.length, checksPassed: true, buildLog: logPath, promoted: false };
  await writeFile(join(candidate, 'candidate.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  console.log('Candidate created; release gates are still required: ' + join(candidate, 'candidate.json'));
} finally { await new Promise(resolveDone => log.end(resolveDone)); }
