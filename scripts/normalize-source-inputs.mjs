// Development-only normalization from the exact source allowlist. Byte-pinned
// adaptations/oracle inputs and binaries follow .gitattributes and are skipped.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(project, '.cache/packaging/independent-source/source-manifest.json'), 'utf8'));
const paths = manifest.files.map(file => file.path);
const attributes = execFileSync('git', ['check-attr', '-z', '--stdin', 'text'], {
  cwd: project, input: paths.join('\0') + '\0', encoding: 'utf8', windowsHide: true,
}).split('\0');
const values = new Map();
for (let index = 0; index + 2 < attributes.length; index += 3) values.set(attributes[index], attributes[index + 2]);
const changed = [];
for (const relative of paths) {
  const path = resolve(project, relative);
  assert(path.startsWith(project + '/') || path.startsWith(project + '\\'), 'Source manifest escapes the project');
  if (values.get(relative) === 'unset') continue;
  const bytes = await readFile(path); if (bytes.includes(0)) continue;
  const source = bytes.toString('utf8');
  assert(Buffer.from(source, 'utf8').equals(bytes), 'Non-UTF8 source must have an explicit binary attribute: ' + relative);
  if (!source.includes('\r\n')) continue;
  changed.push(relative);
  if (!process.argv.includes('--check')) await writeFile(path, source.replaceAll('\r\n', '\n'));
}
console.log(JSON.stringify({ checkOnly: process.argv.includes('--check'), changed }, null, 2));
if (process.argv.includes('--check') && changed.length) process.exitCode = 1;
