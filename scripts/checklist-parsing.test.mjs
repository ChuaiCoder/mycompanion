import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { project, readChecklist } from './promote-release.mjs';

// The gap this closes: `release-evidence.test.mjs` only exercises the validator
// with synthetic inputs. Nothing checked that the real checklist still parses to
// 37 ids with the expected void set, so editing the checklist could change
// what the release gate demands without any test noticing.
//
// The real checklist lives in internal/docs/project-todo.md — local-only
// material that is not committed. CI and public clones lack it, so the two
// real-file tests skip there; the release gate itself only runs locally.
const hasRealChecklist = await access(join(project, 'internal/docs/project-todo.md')).then(() => true, () => false);
const skipMissing = hasRealChecklist ? false : 'real checklist is local-only (internal/) and absent in this checkout';

test('the real checklist parses to 37 unique ids', { skip: skipMissing }, async () => {
  const checklist = await readChecklist();
  assert.equal(checklist.length, 37, 'checklist line count changed');
  assert.equal(new Set(checklist.map(entry => entry.id)).size, 37, 'checklist ids are no longer unique');
});

test('only the three removed compatibility-layer items are void', { skip: skipMissing }, () => {
  return readChecklist().then(checklist => {
    const isVoid = Object.fromEntries(checklist.map(entry => [entry.id, entry.void]));
    for (const id of ['E01', 'E02', 'E03']) assert.equal(isVoid[id], true, id + ' must stay void while the compatibility layer is removed');
    const others = checklist.filter(entry => entry.void && !['E01', 'E02', 'E03'].includes(entry.id)).map(entry => entry.id);
    assert.deepEqual(others, [], 'unexpected void items would silently leave the release gate');
  });
});

test('a checklist that loses an id is rejected instead of quietly shrinking the gate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mycompanion-checklist-'));
  await mkdir(join(directory, 'internal/docs'), { recursive: true });
  await writeFile(join(directory, 'internal/docs/project-todo.md'), '- [ ] **G01 something.**\n');
  await assert.rejects(() => readChecklist(directory), /IDs must stay complete/);
});
