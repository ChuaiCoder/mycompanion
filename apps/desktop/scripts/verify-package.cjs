const assert = require('node:assert/strict');
const { join } = require('node:path');
const { existsSync, readdirSync, readFileSync } = require('node:fs');
const { listPackage } = require('@electron/asar');

// Workspace dependencies can contain local databases and test card archives.
// Refuse to produce a distributable if packaging filters let them through.
module.exports = async function verifyPackage({ appOutDir }) {
  const files = listPackage(join(appOutDir, 'resources', 'app.asar'));
  const forbidden = files.filter(file => {
    const path = file.replaceAll('\\', '/');
    return /\.(?:sqlite\w*|db)(?:-(?:wal|shm|journal))?$/i.test(path)
      || /\/node_modules\/@mycompanion\/[^/]+\/(?:data|fixtures|src)(?:\/|$)/.test(path);
  });
  assert.deepEqual(forbidden, [], 'Release contains local data or development fixtures');
  const resources = join(appOutDir, 'resources');
  for (const file of ['renderer/index.html', 'renderer/THIRD_PARTY_LICENSES.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
    'source/MyCompanion-source.tar.gz', 'source/source-manifest.json', 'source/LICENSE.txt', 'source/THIRD_PARTY_NOTICES.md']) {
    assert(existsSync(join(resources, file)), 'Missing runtime/license/source resource: ' + file);
  }
  // Old reference build outputs may remain on a developer machine. An allowlist
  // in the packaging configuration must keep them out of the independent app.
  for (const name of ['sillytavern', 'node']) {
    assert(!existsSync(join(resources, name)), 'Independent release contains reference runtime: ' + name);
  }
  // Own compatibility helpers such as tavern-random-core are allowed. Reject
  // the removed embedded engine's concrete outputs and any bundled upstream.
  assert(!files.some(file => /(?:sillytavern|js-slash-runner|[\\/]dist[\\/]tavern-(?:engine|child|profile|secrets|shell|extension-git|network|runtime))/i.test(file)), 'Independent ASAR contains reference runtime or third-party helper');
  assert(!readdirSync(join(resources, 'source')).includes('SillyTavern-source.tar.gz'), 'Reference engine archive was packaged as a runtime source');
  assert.deepEqual(readdirSync(join(resources, 'source')).sort(), ['LICENSE.txt', 'MyCompanion-source.tar.gz', 'THIRD_PARTY_NOTICES.md', 'source-manifest.json'], 'Unexpected corresponding source resources');
  for (const dependencyFile of ['handlebars/LICENSE', 'handlebars/dist/handlebars.min.js', 'cropperjs/LICENSE', 'cropperjs/dist/cropper.min.js', 'cropperjs/dist/cropper.min.css', 'yazl/LICENSE']) {
    assert(files.some(file => file.replaceAll('\\', '/').endsWith('/node_modules/' + dependencyFile)), 'Missing dialog/template dependency or license: ' + dependencyFile);
  }
  const notices = readFileSync(join(resources, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  const rendererLicenses = readFileSync(join(resources, 'renderer/THIRD_PARTY_LICENSES.md'), 'utf8');
  assert(files.some(file => file.replaceAll('\\', '/').endsWith('/node_modules/@mycompanion/macro-engine/dist/index.js')), 'Missing shared browser macro parser');
  assert(notices.includes('Reused macro parser and registry') && notices.includes('Apache-2.0 — Chevrotain 13.2.0'), 'Missing macro parser attribution/licenses');
  for (const name of ['markdown-it', 'dompurify', 'entities', 'linkify-it', 'mdurl', 'punycode.js', 'uc.micro', 'i18next', 'react-i18next']) {
    assert(rendererLicenses.includes('## ' + name + ' - '), 'Missing bundled renderer dependency license: ' + name);
  }
  if (files.some(file => /[\\/]node_modules[\\/]toastr[\\/]/.test(file))) {
    assert(notices.includes('MIT License — Toastr 2.1.4') && notices.includes('Permission is hereby granted, free of charge'), 'Full Toastr license notice must accompany this dependency');
  }
  assert(notices.includes('Copyright (c) 2025 Ahoy Labs, Inc.') && notices.includes('BYAF'), 'Missing full official BYAF schema license notice');
  console.log('Package verified: own renderer/service and corresponding source; no Tavern engine, standalone Node, helper or user data.');
};
