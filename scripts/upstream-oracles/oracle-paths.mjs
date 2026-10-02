// SPDX-License-Identifier: AGPL-3.0-only
import { parseArgs } from 'node:util';
import { readFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const { values } = parseArgs({ options: {
  'upstream-dir': { type: 'string' }, 'report-dir': { type: 'string' }, 'write-fixtures': { type: 'boolean', default: false },
} });
export const upstreamCommit = '7e8663cd9c184a550b37238218bdd32c6efc68e9';
const root = fileURLToPath(new URL('../../', import.meta.url));
const upstream = resolve(values['upstream-dir'] ?? resolve(root, '.cache/research/SillyTavern-' + upstreamCommit));
export const upstreamPublicUrl = pathToFileURL(resolve(upstream, 'public') + sep);
const hashes = JSON.parse(readFileSync(new URL('./source-hashes.json', import.meta.url), 'utf8'));
for (const [path, expected] of Object.entries(hashes)) {
  let source;
  try { source = readFileSync(new URL(path, upstreamPublicUrl)); }
  catch { throw new Error('Obtain SillyTavern commit ' + upstreamCommit + ' separately and pass its root with --upstream-dir. Missing source: ' + path); }
  if (createHash('sha256').update(source).digest('hex') !== expected)
    throw new Error('Upstream source hash differs from pinned commit ' + upstreamCommit + ': ' + path);
}
const reports = resolve(values['report-dir'] ?? resolve(root, '.cache/reports'));
mkdirSync(reports, { recursive: true });
const reportBase = pathToFileURL(reports + sep);
export const reportUrl = name => new URL(name, reportBase);
export const writeFixtures = values['write-fixtures'];
