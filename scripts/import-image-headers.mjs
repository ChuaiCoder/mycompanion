import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const commit = 'e6e83a5578961de81f6d5834d90fb7430d8f29a5';
const base = `https://codeberg.org/image-size/image-size/raw/commit/${commit}/`;
const names = ['interface', 'utils', 'png', 'jpg', 'gif', 'webp'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestPath = resolve(root, 'apps/local-service/image-headers-upstream.json');
if (!process.argv.includes('--refresh')) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.commit, commit);
  for (const file of manifest.files) assert.equal(hash(await readFile(resolve(root, file.output))), file.outputSha256, 'Changed header parser: ' + file.output);
  console.log('Verified fixed image header parsers and MIT license: ' + manifest.files.length + ' files');
} else {
  const inputs = await Promise.all([...names.map(name => `lib/types/${name}.ts`), 'LICENSE'].map(async path => {
    const response = await fetch(base + path, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
    assert(response.ok, 'Upstream HTTP ' + response.status + ': ' + path);
    return { path, bytes: Buffer.from(await response.arrayBuffer()) };
  }));
  const prefix = '// @ts-nocheck -- retain upstream bodies under stricter host indexed-access settings.\n' +
    '// image-size, MIT; Copyright 2013-Present Aditya Yadav.\n' +
    `// Fixed upstream commit ${commit}; ESM import specifiers and compiler directive only.\n`;
  await mkdir(resolve(root, 'apps/local-service/src/image-header-upstream'), { recursive: true });
  const files = [];
  for (const input of inputs) {
    const output = input.path === 'LICENSE' ? 'apps/local-service/src/image-header-upstream/LICENSE.txt'
      : 'apps/local-service/src/image-header-upstream/' + input.path.split('/').at(-1);
    const bytes = input.path === 'LICENSE' ? input.bytes : Buffer.from(prefix + input.bytes.toString('utf8')
      .replace(/from '(\.\/(?:interface|utils))'/g, "from '$1.js'"));
    await writeFile(resolve(root, output), bytes);
    files.push({ source: base + input.path, sourceSha256: hash(input.bytes), output, outputSha256: hash(bytes) });
  }
  await writeFile(manifestPath, JSON.stringify({ formatVersion: 1, commit, repository: 'https://codeberg.org/image-size/image-size',
    license: 'MIT', scope: 'Memory-only PNG/JPEG/GIF/WebP header handlers; generic detector and other formats excluded',
    changes: ['ESM relative import specifiers receive .js; provenance comments and module-local ts-nocheck added; function bodies unchanged'], files }, null, 2) + '\n');
  console.log('Imported four unchanged image handlers, utilities, types and MIT license.');
}
