import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import verifyPackagedSource from '../apps/desktop/scripts/packaged-source-integrity.cjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
test('actual packaged source rejects a changed archive or unrelated internally consistent source', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mycompanion-source-integrity-'));
  try {
    const original = Buffer.from('project-authored source fixture');
    const manifest = JSON.stringify({ archiveSha256: hash(original) });
    const expected = { archiveSha256: hash(original), manifestSha256: hash(manifest) };
    writeFileSync(join(directory, 'MyCompanion-source.tar.gz'), original);
    writeFileSync(join(directory, 'source-manifest.json'), manifest);
    assert.deepEqual(verifyPackagedSource(directory, expected), expected);
    const unrelated = Buffer.from('a different source snapshot');
    writeFileSync(join(directory, 'MyCompanion-source.tar.gz'), unrelated);
    assert.throws(() => verifyPackagedSource(directory, expected), /differs from its manifest/);
    writeFileSync(join(directory, 'source-manifest.json'), JSON.stringify({ archiveSha256: hash(unrelated) }));
    assert.throws(() => verifyPackagedSource(directory, expected), /frozen candidate source/);
    writeFileSync(join(directory, 'MyCompanion-source.tar.gz'), original);
    writeFileSync(join(directory, 'source-manifest.json'), JSON.stringify({ archiveSha256: hash(original), files: [] }));
    assert.throws(() => verifyPackagedSource(directory, expected), /frozen candidate manifest/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
