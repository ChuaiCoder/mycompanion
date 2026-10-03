// Read-only identity checks shared by actual EXE acceptance entry points.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export function argument(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  assert(argv[index + 1] && !argv[index + 1].startsWith('--'), 'Missing value for ' + name);
  return argv[index + 1];
}
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
export async function bindPackagedArtifacts(argv, executable, requireSource = false) {
  const expectedExe = argument(argv, '--expected-exe-sha256');
  const source = argument(argv, '--source-archive');
  const expectedSource = argument(argv, '--expected-source-sha256');
  if (requireSource) assert(expectedExe && source && expectedSource, 'The feature acceptance requires exact EXE and corresponding source SHA-256 arguments');
  assert(Boolean(source) === Boolean(expectedSource), 'Pass both --source-archive and --expected-source-sha256');
  for (const value of [expectedExe, expectedSource].filter(Boolean)) assert(/^[a-f0-9]{64}$/i.test(value), 'Invalid SHA-256 argument');
  const identity = { executable, executableSha256: await hash(executable),
    ...(source ? { sourceArchive: resolve(source), sourceArchiveSha256: await hash(resolve(source)) } : {}) };
  if (expectedExe) assert.equal(identity.executableSha256, expectedExe.toLowerCase(), 'Candidate EXE differs from the requested frozen artifact');
  if (expectedSource) assert.equal(identity.sourceArchiveSha256, expectedSource.toLowerCase(), 'Corresponding source differs from the requested frozen archive');
  return identity;
}
export async function assertPackagedArtifactsUnchanged(identity) {
  assert.equal(await hash(identity.executable), identity.executableSha256, 'Candidate EXE changed during acceptance');
  if (identity.sourceArchive) assert.equal(await hash(identity.sourceArchive), identity.sourceArchiveSha256, 'Source archive changed during acceptance');
}
