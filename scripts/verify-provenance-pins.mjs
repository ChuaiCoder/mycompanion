// Guard the byte-pinned provenance chain.
//
// Several adapted modules must keep their exact bytes: their sha256 is recorded
// in an upstream manifest, and `.gitattributes` marks them `-text` so line-ending
// normalization never rewrites them. Because those `.gitattributes` rules are
// path globs, a directory move can silently unpin a file while everything still
// looks green. This check fails loudly instead:
//
//   1. every recorded adapted/generated hash still matches the file on disk;
//   2. every `-text` rule in `.gitattributes` still matches at least one file
//      (an empty rule means the pinned files moved out from under it).
//
// Run with `--list` to print the resolved pins.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { project } from './lib/project-root.mjs';

const sha256 = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const listOnly = process.argv.includes('--list');

// Manifests declare adapted or generated outputs under two shapes. Only entries
// that actually record a local hash are pins; the other fields are provenance
// narrative and are checked as documentation, not bytes.
const manifests = [
  'apps/local-service/vector-upstream.json',
  'apps/local-service/world-info-upstream.json',
  'apps/local-service/world-info-vector-upstream.json',
  'apps/local-service/byaf-upstream.json',
  'apps/local-service/character-assets-upstream.json',
  'apps/local-service/provider-converters-upstream.json',
  'apps/local-service/prompt-manager-upstream.json',
  'apps/local-service/image-headers-upstream.json',
];
// `image-headers-upstream.json` records repository-relative outputs, while the
// manifests beside the package record paths relative to `apps/local-service`
// (for example `src/vector-metric-upstream.ts`, or `../../packages/...`).
const fromLocalService = path => /^(?:apps|packages|scripts|docs)\//.test(path)
  ? path
  : 'apps/local-service/' + path.replace(/^\.\//, '').replace(/^\.\.\/\.\.\//, '');

const pins = new Map();
function record(declaredPath, expected, manifest) {
  const path = fromLocalService(declaredPath);
  const previous = pins.get(path);
  if (previous && previous.expected !== expected) throw new Error('Conflicting recorded hashes for ' + path);
  pins.set(path, { expected, manifests: [...(previous?.manifests ?? []), manifest] });
}

for (const manifestPath of manifests) {
  const manifest = JSON.parse(await readFile(join(project, manifestPath), 'utf8'));
  for (const file of manifest.files ?? []) {
    if (typeof file.output === 'string' && typeof file.outputSha256 === 'string') record(file.output, file.outputSha256, manifestPath);
    if (typeof file.path === 'string' && typeof file.adaptedSha256 === 'string') record(file.path, file.adaptedSha256, manifestPath);
  }
  for (const input of manifest.inputs ?? []) {
    if (typeof input.adaptedPath === 'string' && typeof input.adaptedSha256 === 'string') record(input.adaptedPath, input.adaptedSha256, manifestPath);
  }
}

// `.gitattributes` `-text` rules whose only purpose is to stop line-ending
// normalization of binaries; they are not provenance pins.
const ignoredTextRules = new Set(['*.zip', '*.png', '*.jpg', '*.jpeg', '*.webp', '*.exe', '*.tar.gz']);
const attributes = (await readFile(join(project, '.gitattributes'), 'utf8'))
  .split('\n')
  .map(line => line.trim())
  .filter(line => line && !line.startsWith('#'));
const textRules = [];
for (const line of attributes) {
  const [pattern, ...flags] = line.split(/\s+/);
  if (!flags.includes('-text') || ignoredTextRules.has(pattern)) continue;
  textRules.push({ pattern: pattern.replace(/^\/+/, '') });
}

// Walk the repository once, skipping generated and vendored trees. The walker
// skips by entry name, so it never descends into a vendored directory at all.
const skipped = new Set(['node_modules', '.cache', '.git', 'dist', 'release', 'output']);
const files = [];
async function walk(directory) {
  for (const entry of await readdir(join(project, directory), { withFileTypes: true })) {
    const child = directory ? directory + '/' + entry.name : entry.name;
    if (skipped.has(entry.name)) continue;
    if (entry.isDirectory()) await walk(child);
    else if (entry.isFile()) files.push(child);
  }
}
await walk('');

// Translate one `.gitattributes` glob (supporting `*`, `**` and `?`) into a
// regex over repository-relative POSIX paths.
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function matcher(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') {
      index += 1;
      if (pattern[index + 1] === '/') { index += 1; source += '(?:.*/)?'; } else source += '.*';
    } else if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else source += escape(character);
  }
  return new RegExp('^' + source + '$');
}

if (listOnly) {
  for (const [path, pin] of [...pins].sort()) console.log(path + '\t' + pin.expected + '\t' + pin.manifests.join(','));
  process.exit(0);
}

const problems = [];

// 1. Recorded hashes must match the bytes on disk.
for (const [path, pin] of [...pins].sort()) {
  try {
    const actual = await sha256(join(project, path));
    if (actual !== pin.expected) problems.push(path + ': bytes differ from ' + pin.manifests.join(', ') + ' (expected ' + pin.expected + ', found ' + actual + ')');
  } catch {
    problems.push(path + ': missing; declared by ' + pin.manifests.join(', '));
  }
}

// 2. Every `-text` rule must still cover at least one file. A rule that matches
// nothing means its pinned files were moved and are now plain `text=auto`.
const covered = new Set();
for (const rule of textRules) {
  const matched = files.filter(file => matcher(rule.pattern).test(file));
  if (!matched.length) problems.push('.gitattributes rule "' + rule.pattern + ' -text" matches no file; its pinned files moved away');
  else for (const file of matched) covered.add(file);
}

assert.deepEqual(problems, [], 'Byte-pinned provenance is broken:\n' + problems.join('\n'));
console.log('Provenance pins intact: ' + pins.size + ' hashed file(s), ' + textRules.length +
  ' -text rule(s) covering ' + covered.size + ' file(s).');
for (const path of [...pins.keys()].sort()) if (!covered.has(path)) console.log('note: hashed but not line-ending pinned: ' + path);
