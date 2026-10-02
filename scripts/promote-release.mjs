import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReleaseEvidence } from './release-evidence.mjs';
import { promoteVerifiedRelease } from './release-promotion.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flag = name => { const at = process.argv.indexOf(name); assert(at >= 0 && process.argv[at + 1], 'Required argument: ' + name); return resolve(process.argv[at + 1]); };
const candidatePath = flag('--candidate');
const acceptancePath = flag('--acceptance');
const manifest = JSON.parse(await readFile(candidatePath, 'utf8'));
const acceptance = JSON.parse(await readFile(acceptancePath, 'utf8'));
const ids = [...(await readFile(join(project, 'docs/project-todo.md'), 'utf8')).matchAll(/\*\*([A-Z]\d{2})\s/g)].map(match => match[1]);
assert.equal(new Set(ids).size, 37, 'Release checklist IDs must stay complete');
const problems = validateReleaseEvidence(manifest, acceptance, ids);
assert.deepEqual(problems, [], 'Release blocked:\n' + problems.join('\n'));
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
assert.equal(await hash(manifest.executable), manifest.executableSha256, 'Candidate executable changed');
assert.equal(await hash(join(dirname(candidatePath), 'MyCompanion-source.tar.gz')), manifest.sourceSha256, 'Candidate source changed');
for (const path of new Set(ids.flatMap(id => acceptance.items[id].reports))) {
  const report = JSON.parse(await readFile(resolve(dirname(acceptancePath), path), 'utf8'));
  assert(report.passed === true && report.executableSha256 === manifest.executableSha256 && report.sourceSha256 === manifest.sourceSha256,
    'Report failed or refers to a different artifact: ' + path);
}
await promoteVerifiedRelease({ project, manifest, acceptancePath });
