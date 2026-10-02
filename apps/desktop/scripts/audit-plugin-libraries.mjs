// Inspect dependency assets and their notices inside a frozen independent ASAR.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { listPackage, extractFile } from '@electron/asar';

const candidate = resolve(process.argv[2]);
const archive = join(candidate, 'win-unpacked/resources/app.asar');
const entries = listPackage(archive).map(path => path.replaceAll('\\', '/').replace(/^\//, ''));
const hash = value => createHash('sha256').update(value).digest('hex');
const packageRequire = createRequire(resolve('apps/local-service/package.json'));
async function installedDirectory(name) {
  let directory = dirname(packageRequire.resolve(name));
  while (true) {
    const metadata = await readFile(join(directory, 'package.json'), 'utf8').then(JSON.parse).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (metadata?.name === name) return directory;
    assert.notEqual(dirname(directory), directory, 'Cannot locate package metadata: ' + name);
    directory = dirname(directory);
  }
}
const dependencies = {
  yazl: ['package.json', 'LICENSE', 'index.js'],
  jquery: ['package.json', 'LICENSE.txt', 'dist/jquery.min.js'],
  lodash: ['package.json', 'LICENSE', 'lodash.min.js'],
  handlebars: ['package.json', 'LICENSE', 'dist/handlebars.min.js'],
  cropperjs: ['package.json', 'LICENSE', 'dist/cropper.min.js', 'dist/cropper.min.css'],
  dompurify: ['package.json', 'LICENSE', 'dist/purify.min.js'],
  '@popperjs/core': ['package.json', 'LICENSE.md', 'dist/umd/popper.min.js'],
  toastr: ['package.json', 'toastr.js', 'build/toastr.min.js', 'build/toastr.min.css'],
  'eventsource-parser': ['package.json', 'LICENSE', 'dist/index.js', 'dist/parse.js', 'dist/errors.js'],
  'sanitize-filename': ['package.json', 'LICENSE.md', 'index.js'],
  '@fortawesome/fontawesome-free': ['package.json', 'LICENSE.txt', 'metadata/icon-families.json', 'css/all.min.css',
    ...['fa-solid-900', 'fa-regular-400', 'fa-brands-400', 'fa-v4compatibility'].flatMap(name => [`webfonts/${name}.woff2`, `webfonts/${name}.ttf`])],
};
const checks = [];
for (const [name, files] of Object.entries(dependencies)) {
  const sourceDirectory = await installedDirectory(name);
  for (const file of files) {
    const suffix = `node_modules/${name}/${file}`;
    const entry = entries.find(path => path === suffix || path.endsWith('/' + suffix));
    assert(entry, 'Missing packaged library/license: ' + suffix);
    const packed = extractFile(archive, join(...entry.split('/')));
    const installed = await readFile(join(sourceDirectory, file));
    if (file === 'package.json') {
      // electron-builder strips development metadata. Runtime resolution and
      // package identity/license fields must still match the installed package.
      const original = JSON.parse(installed), bundled = JSON.parse(packed);
      for (const key of ['name', 'version', 'main', 'module', 'exports', 'type', 'license', 'licenses']) assert.deepEqual(bundled[key], original[key], `Package changed ${name}.${key}`);
    } else assert.equal(hash(packed), hash(installed), 'Package changed dependency bytes: ' + suffix);
    checks.push({ path: entry, bytes: packed.length, sha256: hash(packed) });
  }
}
const notices = await readFile(join(candidate, 'win-unpacked/resources/THIRD_PARTY_NOTICES.md'), 'utf8');
assert(notices.includes('MIT License — Toastr 2.1.4') && notices.includes('John Papa, Hans Fjällemark, and Tim Ferrell') && notices.includes('Permission is hereby granted, free of charge'), 'Full Toastr copyright and permission notice is missing');
const report = { passed: true, candidate, archiveSha256: hash(await readFile(archive)), checkedFiles: checks.length, toastrNoticeIncluded: true, checks };
const reportPath = resolve(process.argv[3] || '.cache/reports/independent-plugin-library-package-audit.json');
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, checks: undefined }));
