import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReleaseEvidence } from './release-evidence.mjs';
import { promoteVerifiedRelease } from './release-promotion.mjs';

export const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Derive the release checklist from its single source of truth. Ids stay fixed
 * at 37 so a rewritten checklist cannot silently shrink the gate; an item marked
 * void (its object was removed from the product) is recorded as void instead of
 * being required to produce passing evidence it can never have.
 */
export async function readChecklist(root = project) {
  // 清单位于 internal/（本地内部资料，不入库）；CI 与公开克隆没有该文件，
  // 晋升门禁只在含 internal/ 的机器上可用。
  const markdown = await readFile(join(root, 'internal/docs/project-todo.md'), 'utf8');
  const checklist = [...markdown.matchAll(/^.*\*\*([A-Z]\d{2})\s[^\n]*$/gm)]
    .map(match => ({ id: match[1], void: match[0].includes('本项已作废') }));
  assert.equal(new Set(checklist.map(entry => entry.id)).size, 37, 'Release checklist IDs must stay complete');
  return checklist;
}

async function main() {
  const flag = name => { const at = process.argv.indexOf(name); assert(at >= 0 && process.argv[at + 1], 'Required argument: ' + name); return resolve(process.argv[at + 1]); };
  const candidatePath = flag('--candidate');
  const acceptancePath = flag('--acceptance');
  const manifest = JSON.parse(await readFile(candidatePath, 'utf8'));
  const acceptance = JSON.parse(await readFile(acceptancePath, 'utf8'));
  const checklist = await readChecklist();
  const problems = validateReleaseEvidence(manifest, acceptance, checklist);
  assert.deepEqual(problems, [], 'Release blocked:\n' + problems.join('\n'));
  const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
  assert.equal(await hash(manifest.executable), manifest.executableSha256, 'Candidate executable changed');
  assert.equal(await hash(join(dirname(candidatePath), 'MyCompanion-source.tar.gz')), manifest.sourceSha256, 'Candidate source changed');
  for (const id of checklist.filter(entry => !entry.void).map(entry => entry.id)) {
    for (const path of new Set(acceptance.items[id].reports)) {
      const report = JSON.parse(await readFile(resolve(dirname(acceptancePath), path), 'utf8'));
      assert(report.passed === true && report.executableSha256 === manifest.executableSha256 && report.sourceSha256 === manifest.sourceSha256,
        'Report failed or refers to a different artifact: ' + path);
    }
  }
  await promoteVerifiedRelease({ project, manifest, acceptancePath });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
