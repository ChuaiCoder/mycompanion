import assert from 'node:assert/strict';
import { test } from 'node:test';
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
