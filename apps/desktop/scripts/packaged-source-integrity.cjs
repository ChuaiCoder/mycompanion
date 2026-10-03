const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

// Check the bytes copied into the actual app, rather than trusting the mutable
// workspace staging directory or a separately supplied acceptance archive.
module.exports = function verifyPackagedSource(sourceDirectory, expected = {}) {
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const manifestBytes = readFileSync(join(sourceDirectory, 'source-manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  const archiveSha256 = hash(readFileSync(join(sourceDirectory, 'MyCompanion-source.tar.gz')));
  const manifestSha256 = hash(manifestBytes);
  assert.equal(archiveSha256, manifest.archiveSha256, 'Packaged source archive differs from its manifest');
  if (expected.archiveSha256) assert.equal(archiveSha256, expected.archiveSha256, 'Packaged source differs from the frozen candidate source');
  if (expected.manifestSha256) assert.equal(manifestSha256, expected.manifestSha256, 'Packaged source manifest differs from the frozen candidate manifest');
  return { archiveSha256, manifestSha256 };
};
