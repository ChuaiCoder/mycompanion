import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, writeFile, copyFile, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.includes('--reference-tavern')) throw new Error('The embedded Tavern source packaging path has been removed.');
const destination = join(project, '.cache/packaging/independent-source');
const files = [];
async function include(path) {
    const entries = await readdir(join(project, path), { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isSymbolicLink()) throw new Error('Source archive cannot contain symlinks: ' + path);
        const child = path + '/' + entry.name;
        if (entry.isDirectory()) await include(child);
        else if (entry.isFile()) files.push(child);
    }
}
for (const path of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'SECURITY.md', 'CONTRIBUTING.md', '.gitignore', '.editorconfig', 'spec.md', 'test.md', 'package.json', 'package-lock.json', 'tsconfig.base.json', 'examples/plugins/scene-director.mycompanion-plugin.json']) files.push(path);
for (const path of ['scripts', 'docs', '.github']) await include(path);
for (const workspace of ['apps/desktop', 'apps/local-service', 'apps/renderer', 'packages/character-card', 'packages/shared', 'packages/macro-engine']) {
    for (const entry of await readdir(join(project, workspace), { withFileTypes: true })) {
        if (entry.isFile() && (/^(?:package(?:-lock)?\.json|tsconfig.*\.json|vite.*|vitest.*|index\.html|README\.md|LICENSE|(?:(?:slash|prompt-manager|character-assets|world-info|byaf)-)?upstream\.json)$/.test(entry.name))) files.push(workspace + '/' + entry.name);
        if (entry.isDirectory() && ['src', 'scripts', 'public', ...(workspace === 'apps/local-service' ? ['upstream-slash'] : [])].includes(entry.name)) await include(workspace + '/' + entry.name);
    }
}
// These small, project-authored regression inputs are required by included tests.
// This is an exact allowlist, never an inclusion of user cards or installed extensions.
const ownFixtures = ['packages/character-card/fixtures/ccv2-full.json',
  'apps/local-service/fixtures/extensions/generate.py',
  ...['root', 'wrapper', 'missing-root', 'invalid-entry', 'duplicate', 'symlink',
    'oversized-file', 'oversized-total', 'too-many-entries'].map(name => `apps/local-service/fixtures/extensions/${name}.zip`)];
files.push(...ownFixtures);
// Fixed-upstream execution outputs are public regression references, not user
// content. Keep their provenance distinct from our authored fixture inputs.
const upstreamReferences = [
  'prompt-population', 'prompt-remaining', 'prompt-persona-examples', 'prompt-lifecycle', 'character-import',
].map(name => `apps/local-service/src/fixtures/${name}-upstream-reference.json`);
const allowedFixtures = new Set([...ownFixtures, ...upstreamReferences]);
if (files.some(file => !allowedFixtures.has(file) && (/\.(sqlite\w*|db|exe|zip|png)$/i.test(file) || /(?:^|\/)(node_modules|fixtures|data|js-slash-runner)(?:\/|$)/i.test(file)))) throw new Error('Unexpected data or third-party extension in source inputs');
await mkdir(destination, { recursive: true });
await mkdir(join(project, '.cache/packaging'), { recursive: true });
const staging = await mkdtemp(join(project, '.cache/packaging/source-snapshot-'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const inputs = await Promise.all(files.sort().map(async path => {
    const bytes = await readFile(join(project, path));
    await mkdir(join(staging, path, '..'), { recursive: true });
    await writeFile(join(staging, path), bytes);
    return { path, sha256: sha256(bytes), ...(ownFixtures.includes(path) ? { origin: 'MyCompanion project-authored regression fixture' }
      : upstreamReferences.includes(path) ? { origin: 'Fixed SillyTavern execution output; AGPL-3.0-only; see the fixture meta and corresponding upstream manifest', upstreamCommit: '7e8663cd9c184a550b37238218bdd32c6efc68e9' } : {}) };
}));
for (const file of inputs) {
    if (sha256(await readFile(join(project, file.path))) !== file.sha256) throw new Error('Source changed during archive snapshot: ' + file.path);
}
const listPath = join(project, '.cache/packaging/source-files.txt');
await writeFile(listPath, files.sort().join('\n') + '\n');
await new Promise((resolveDone, reject) => {
    const child = spawn('tar', ['-czf', join(destination, 'MyCompanion-source.tmp.tar.gz'), '-T', listPath], { cwd: staging, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveDone() : reject(new Error('Source archiving failed: ' + code)));
});
await rename(join(destination, 'MyCompanion-source.tmp.tar.gz'), join(destination, 'MyCompanion-source.tar.gz'));
const manifest = { formatVersion: 1, license: 'AGPL-3.0-only',
  archiveSha256: sha256(await readFile(join(destination, 'MyCompanion-source.tar.gz'))),
  files: inputs };
await writeFile(join(destination, 'source-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await copyFile(join(project, 'LICENSE'), join(destination, 'LICENSE.txt'));
await copyFile(join(project, 'THIRD_PARTY_NOTICES.md'), join(destination, 'THIRD_PARTY_NOTICES.md'));
console.log('Prepared corresponding source archive: ' + files.length + ' source/configuration files.');
