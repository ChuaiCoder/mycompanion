import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { batchPage, productionInventory } from './audit-production-osv.mjs';

test('inventory deduplicates nested/scoped packages and includes shipped Electron', () => {
  const packages = productionInventory({ lockfileVersion: 3, packages: {
    '': { version: '1.0.0' },
    'node_modules/@mycompanion/shared': { link: true },
    'node_modules/@scope/parser': { version: '2.0.0', integrity: 'sha512-a' },
    'node_modules/host/node_modules/@scope/parser': { version: '2.0.0', optional: true },
    'node_modules/build-tool': { version: '3.0.0', dev: true },
    'node_modules/electron': { version: '44.4.4', dev: true },
    'node_modules/alias': { name: 'actual-name', version: '1.2.3' },
  } });
  assert.deepEqual(packages.map(p => p.name), ['@scope/parser', 'actual-name', 'electron']);
  assert.equal(packages[0].paths.length, 2);
  assert.equal(packages[0].paths[1].optional, true);
  assert.equal(packages[2].deliveredElectron, true);
});

test('pagination follows only original package indices and rejects partial responses', () => {
  const pages = batchPage([{ vulns: [{ id: 'GHSA-first' }], next_page_token: 'more' }, {}], [{ index: 7 }, { index: 19 }]);
  assert.deepEqual(pages, [{ index: 7, ids: ['GHSA-first'], token: 'more' }, { index: 19, ids: [] }]);
  assert.deepEqual(batchPage([{ vulns: [{ id: 'GHSA-last' }] }], [{ index: 7, token: 'more' }]), [{ index: 7, ids: ['GHSA-last'] }]);
  assert.throws(() => batchPage([{}], [{ index: 7 }, { index: 19 }]), /count/);
  assert.throws(() => batchPage([{ vulns: [{ id: 1 }] }], [{ index: 7 }]), /IDs/);
  assert.throws(() => batchPage([{ next_page_token: '' }], [{ index: 7 }]), /token/);
});

// An audit that never completed must not read as "no advisories". Before this
// was enforced, a network failure left the process exit code at zero, so the
// release gate passed while no dependency was ever queried.
test('an unreachable OSV endpoint fails the gate instead of reporting success', async () => {
  const script = fileURLToPath(new URL('./audit-production-osv.mjs', import.meta.url));
  const result = await new Promise(done => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, MYCOMPANION_OSV_API: 'http://127.0.0.1:9/v1' },
      windowsHide: true,
    });
    let stdout = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.once('exit', code => done({ code, stdout }));
  });
  assert.notEqual(result.code, 0, 'an incomplete audit must not exit successfully');
  const report = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
  assert.equal(report.completed, false);
  assert.equal(report.passed, false);
  assert.ok(report.error?.message, 'the failure reason must be recorded in the report');
});
