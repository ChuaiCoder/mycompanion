import assert from 'node:assert/strict';

export function processCreationTime(value) {
  const microsoft = typeof value === 'string' && /^\/Date\((\d+)(?:[+-]\d{4})?\)\/$/.exec(value);
  const time = microsoft ? Number(microsoft[1]) : typeof value === 'string' ? Date.parse(value) : NaN;
  assert(Number.isFinite(time), 'Process ownership requires a known creation time');
  return time;
}

// A parent PID can be reused after the actual parent exits. An older process
// that names that PID cannot be a child of its newer current instance.
export function ownedProcessTree(processes, launcher) {
  if (!launcher) return [];
  const root = processes.find(item => item.ProcessId === launcher.ProcessId
    && item.CreationDate === launcher.CreationDate
    && item.ExecutablePath === launcher.ExecutablePath);
  if (!root) return [];
  const rootTime = processCreationTime(root.CreationDate);
  const owned = new Map([[root.ProcessId, { process: root, time: rootTime }]]);
  let added;
  do {
    added = false;
    for (const process of processes) {
      if (owned.has(process.ProcessId)) continue;
      const parent = owned.get(process.ParentProcessId);
      if (!parent) continue;
      const time = processCreationTime(process.CreationDate);
      if (time < rootTime || time < parent.time) continue;
      owned.set(process.ProcessId, { process, time }); added = true;
    }
  } while (added);
  return [...owned.values()].map(item => item.process);
}
