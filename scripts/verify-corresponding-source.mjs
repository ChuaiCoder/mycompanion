import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t as listTar } from 'tar';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = join(project, '.cache/packaging/independent-source');
const archive = join(destination, 'MyCompanion-source.tar.gz');
const manifest = JSON.parse(await readFile(join(destination, 'source-manifest.json'), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const workspace = await mkdtemp(join(tmpdir(), 'mycompanion-source-check-'));
const report = { passed: false, sourceSha256: sha256(await readFile(archive)), workspace,
  checkedAt: new Date().toISOString(), isolatedInstall: !process.argv.includes('--skip-install'), offline: process.argv.includes('--offline'), checks: [] };
const run = (command, args, cwd = workspace) => new Promise((resolveDone, reject) => {
  const child = spawn(command, args, { cwd, windowsHide: true, stdio: 'inherit',
    ...(command === 'npm' && process.platform === 'win32' ? { shell: true } : {}) });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolveDone() : reject(new Error(`${command} exited ${code}`)));
});
try {
  assert.equal(report.sourceSha256, manifest.archiveSha256, 'Archive no longer matches manifest');
  // Inspect all names before extraction. The archive must contain only its
  // declared project inputs, never links, user data or a third-party helper.
  const expected = new Set(manifest.files.map(file => file.path));
  const seen = new Set();
  await listTar({ file: archive, onentry(entry) {
    assert.equal(entry.type, 'File', 'Only regular source files may be extracted');
    assert(expected.has(entry.path) && !seen.has(entry.path), 'Unexpected or duplicate archive path: ' + entry.path);
    seen.add(entry.path);
  } });
  assert.equal(seen.size, expected.size, 'Archive omits declared inputs');
  await run('tar', ['-xzf', archive, '-C', workspace]);
  for (const file of manifest.files) {
    const path = resolve(workspace, file.path);
    assert(path.startsWith(workspace + '/') || path.startsWith(workspace + '\\'), 'Source manifest escapes extraction directory');
    assert.equal(sha256(await readFile(path)), file.sha256, 'Input hash mismatch: ' + file.path);
  }
  report.checks.push({ name: 'archive-and-input-hashes', files: manifest.files.length, passed: true });
  if (report.isolatedInstall) await run('npm', ['ci', ...(report.offline ? ['--offline'] : [])]);
  else {
    // CI can select the structural-only mode, but this is not an isolated build.
    report.checks.push({ name: 'isolated-install-and-check', passed: false, skipped: true });
  }
  if (report.isolatedInstall) {
    await run('npm', ['run', 'check']);
    await run('npm', ['run', 'build', '-w', '@mycompanion/desktop']);
    report.checks.push({ name: 'isolated-install-test-build', passed: true });
  }
  report.passed = true;
} catch (error) { report.error = String(error?.stack ?? error); process.exitCode = 1; }
finally {
  await mkdir(join(project, '.cache/reports'), { recursive: true });
  const timestamp = report.checkedAt.replace(/[^0-9TZ]/g, '');
  await writeFile(join(project, `.cache/reports/corresponding-source-${timestamp}.json`), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
}
