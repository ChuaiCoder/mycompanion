import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ownedProcessTree, processCreationTime } from '../apps/desktop/scripts/owned-process-tree.mjs';

const record = (pid, parent, time) => ({ ProcessId: pid, ParentProcessId: parent,
  CreationDate: `/Date(${time})/`, ExecutablePath: `C:\\fixture\\${pid}.exe` });

test('ownership excludes parent PID reuse before the launcher or an intermediate parent', () => {
  const root = record(10, 1, 1000), child = record(20, 10, 2000), grandchild = record(30, 20, 3000);
  const beforeLauncher = record(40, 10, 500), reusedParent = record(50, 20, 1500);
  const staleDescendant = record(60, 40, 4000);
  assert.deepEqual(ownedProcessTree([grandchild, reusedParent, staleDescendant, beforeLauncher, child, root], root)
    .map(item => item.ProcessId), [10, 20, 30]);
});

test('ownership refuses a changed launcher instance or unknown creation metadata', () => {
  const root = record(10, 1, 1000);
  assert.deepEqual(ownedProcessTree([record(10, 1, 2000), record(20, 10, 3000)], root), []);
  assert.deepEqual(ownedProcessTree([{ ...root, ExecutablePath: 'C:\\other.exe' }], root), []);
  assert.throws(() => ownedProcessTree([root, { ...record(20, 10, 2000), CreationDate: null }], root), /known creation time/);
  assert.equal(processCreationTime('2026-10-02T22:15:30.081Z'), Date.parse('2026-10-02T22:15:30.081Z'));
});
