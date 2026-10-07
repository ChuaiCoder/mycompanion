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
for (const path of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'SECURITY.md', 'CONTRIBUTING.md', '.gitignore', '.gitattributes', '.editorconfig', 'spec.md', 'test.md', 'package.json', 'package-lock.json', 'tsconfig.base.json', 'examples/plugins/scene-director.mycompanion-plugin.json']) files.push(path);
for (const path of ['scripts', 'docs', '.github']) await include(path);
for (const workspace of ['apps/desktop', 'apps/local-service', 'apps/renderer', 'packages/character-card', 'packages/shared']) {
    for (const entry of await readdir(join(project, workspace), { withFileTypes: true })) {
        if (entry.isFile() && (/^(?:package(?:-lock)?\.json|tsconfig.*\.json|vite.*|vitest.*|index\.html|README\.md|LICENSE|(?:(?:prompt-manager|character-assets|world-info|world-info-vector|provider-converters|byaf|vector|image-headers)-)?upstream\.json)$/.test(entry.name))) files.push(workspace + '/' + entry.name);
        if (entry.isDirectory() && ['src', 'scripts', 'public'].includes(entry.name)) await include(workspace + '/' + entry.name);
    }
}
// These small, project-authored regression inputs are required by included tests.
// This is an exact allowlist, never an inclusion of user cards or installed extensions.
const ownFixtures = ['packages/character-card/fixtures/ccv2-full.json'];
files.push(...ownFixtures);
// Fixed-upstream execution outputs are public regression references, not user
// content. Keep their provenance distinct from our authored fixture inputs.
const upstreamReferences = [
  'prompt-population', 'prompt-persona-examples', 'prompt-lifecycle', 'character-import',
].map(name => `apps/local-service/src/fixtures/${name}-upstream-reference.json`);
const allowedFixtures = new Set([...ownFixtures, ...upstreamReferences]);
// A card's interface and its runtime modules are third-party content fetched from the
// CDN a card declares, and they must never enter the installer or this source archive.
// (They differ per card, carry their own licences, and one observed runtime ships with
// no licence at all.) `src`/`scripts`/`public` are copied wholesale, so the guard has to
// name the shapes such a file would take, not just the directories.
const forbiddenFileType = /\.(sqlite\w*|db|exe|zip|png|webp|jpe?g|gif|mp4|min\.js)$/i;
const forbiddenDirectory = /(?:^|\/)(node_modules|fixtures|data|js-slash-runner)(?:\/|$)/i;
const cardRuntimeName = /(?:^|\/)(?:mvu|sillytavern|tavern[-_]?helper|daoyuan|js[-_]?slash)[^/]*$/i;
if (files.some(file => !allowedFixtures.has(file)
  && (forbiddenFileType.test(file) || forbiddenDirectory.test(file) || cardRuntimeName.test(file)))) {
    throw new Error('Unexpected data or third-party extension in source inputs');
}
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
await copyFile(listPath, join(staging, 'source-files.txt'));
// Run tar inside the staging directory and give it a relative output path:
// absolute "E:\..." arguments break GNU tar (drive letter reads as a remote
// host) while bsdtar accepts them; relative paths work under both.
await new Promise((resolveDone, reject) => {
    const child = spawn('tar', ['-czf', '../independent-source/MyCompanion-source.tmp.tar.gz', '-T', 'source-files.txt'], { cwd: staging, windowsHide: true, stdio: 'inherit' });
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
