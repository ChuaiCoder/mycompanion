import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readChecklist } from './promote-release.mjs';

// The gap this closes: `release-evidence.test.mjs` only exercises the validator
// with synthetic inputs. Nothing checked that the real checklist still parses to
// 37 ids with the expected void set, so editing docs/project-todo.md could change
// what the release gate demands without any test noticing.
test('the real checklist parses to 37 unique ids', async () => {
  const checklist = await readChecklist();
  assert.equal(checklist.length, 37, 'checklist line count changed');
  assert.equal(new Set(checklist.map(entry => entry.id)).size, 37, 'checklist ids are no longer unique');
});

test('only the three removed compatibility-layer items are void', () => {
  return readChecklist().then(checklist => {
    const isVoid = Object.fromEntries(checklist.map(entry => [entry.id, entry.void]));
    for (const id of ['E01', 'E02', 'E03']) assert.equal(isVoid[id], true, id + ' must stay void while the compatibility layer is removed');
    const others = checklist.filter(entry => entry.void && !['E01', 'E02', 'E03'].includes(entry.id)).map(entry => entry.id);
    assert.deepEqual(others, [], 'unexpected void items would silently leave the release gate');
  });
});

test('a checklist that loses an id is rejected instead of quietly shrinking the gate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mycompanion-checklist-'));
  await mkdir(join(directory, 'docs'), { recursive: true });
  await writeFile(join(directory, 'docs/project-todo.md'), '- [ ] **G01 something.**\n');
  await assert.rejects(() => readChecklist(directory), /IDs must stay complete/);
});
