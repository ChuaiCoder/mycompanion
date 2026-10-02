import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
await build({ entryPoints: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
  outfile: fileURLToPath(new URL('../dist/index.js', import.meta.url)),
  bundle: true, platform: 'neutral', format: 'esm', target: 'es2023', legalComments: 'eof',
  banner: { js: '/*! Macro parser: adapted from SillyTavern 1.19.0 (AGPL-3.0-only). Chevrotain 13.2.0 (Apache-2.0). See accompanying LICENSE, THIRD_PARTY_NOTICES.md and corresponding source. */' } });
await copyFile(new URL('../src/index.d.ts', import.meta.url), new URL('../dist/index.d.ts', import.meta.url));
