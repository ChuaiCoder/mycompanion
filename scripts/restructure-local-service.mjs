// One-shot structural split of apps/local-service/src into domain directories.
//
// Correctness matters more than brevity here. Two rules make the rewrite safe:
//
//  1. The complete path plan is computed *before* anything moves, and every
//     specifier is resolved against the ORIGINAL tree. Resolving against a
//     half-moved tree (the first attempt at this script did that) silently
//     invents paths such as `../../chat/prompt/foo.js`.
//  2. `./x.js` is rewritten to `./x.js`-style specifiers but the on-disk file is
//     `x.ts`, so resolution must try `x.ts` as well as `x`.
//
// Known limits of the rewrite pass, each of which needed a manual follow-up:
//   * `vi.mock("./x.js")` is left alone, because a module specifier inside a call
//     expression cannot be distinguished from an ordinary string safely.
//   * A test file named `x-upstream.test.ts` whose module is `x-upstream.ts` is
//     moved explicitly rather than by naming convention.
//   * `scripts/**` imports of `apps/local-service/dist/<name>.js` are not touched;
//     they must be repointed at the new subdirectory by hand.
//
// Byte-pinned files (internal/docs/byte-pinned-files.md) are never moved, and neither are
// `bounded-zip.ts` / `character-byaf-utils.ts`, which the pinned
// `character-byaf-upstream.ts` imports by relative path.
//
// Usage: node scripts/restructure-local-service.mjs [--dry-run]
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { project } from './lib/project-root.mjs';

const dryRun = process.argv.includes('--dry-run');
const root = join(project, 'apps/local-service/src');
const absoluteOf = path => join(project, 'apps/local-service', path);
const toPosix = value => value.split(sep).join('/');

// Files that must stay in src/ itself: the package entry point, shared HTTP
// plumbing, the byte-pinned provenance files and their transitively locked
// dependencies. The pinned image-header/ directory is untouched as well.
const stayAtRoot = new Set([
  'app.ts',
  'browser-port.ts',
  'http-shutdown.ts',
  'http-errors.ts',
  'route-types.ts',
  'health-routes.ts',
  // byte-pinned: sha256 recorded in an upstream manifest, anchored by a
  // `.gitattributes` `-text` path glob
  'character-byaf-upstream.ts',
  'character-byaf-schemas.ts',
  'provider-converters-upstream.ts',
  'vector-metric-upstream.ts',
  'world-info-upstream-runtime.ts',
  'world-info-vector-upstream.ts',
  // transitively locked: imported by the pinned character-byaf-upstream.ts
  'bounded-zip.ts',
  'character-byaf-utils.ts',
]);

const moves = {
  chat: ['generation-pipeline.ts', 'generation-routes.ts', 'conversation-routes.ts',
    'retained-character-chats.ts', 'structured-output.ts'],
  providers: ['provider-transport.ts', 'provider-repository.ts', 'provider-probe.ts',
    'provider-usage.ts', 'provider-errors.ts', 'provider-error-stream.ts', 'provider-response.ts',
    'provider-profile-routes.ts', 'provider-credential-scope.ts', 'model-client.ts',
    'model-request-error.ts', 'model-prompt-image.ts', 'chat-completion-request.ts',
    'chat-completion-budget.ts', 'embedding-client.ts', 'vector-store.ts', 'vector-collections.ts'],
  memory: ['memory-engine.ts', 'memory-extractor.ts', 'memory-conflict-core.ts', 'semantic-memory.ts'],
  'world-info': ['world-info-repository.ts', 'world-info-service.ts', 'world-info-routes.ts',
    'world-info-activation.ts', 'world-info-effects.ts', 'world-info-event-graph.ts',
    'world-info-vectors.ts', 'worldbook-engine.ts', 'character-lorebook-routes.ts'],
  character: ['character-repository.ts', 'character-routes.ts', 'character-archive.ts',
    'character-assets.ts', 'character-inline-assets.ts', 'character-greeting.ts',
    'character-world-info-editor.ts', 'character-regex-routes.ts', 'character-macros.ts',
    'character-yaml.ts', 'character-byaf.ts', 'persona-avatars.ts', 'export-compatibility.ts'],
  prompt: ['prompt-manager-core.ts', 'prompt-budget.ts', 'prompt-assembly-routes.ts',
    'prompt-macros.ts', 'managed-prompt-assembly.ts', 'macro-variables.ts',
    'macro-variable-conflict.ts', 'tavern-regex-core.ts', 'tavern-regex-service.ts',
    'tavern-random-core.ts', 'tavern-time-core.ts', 'regex-engine.ts', 'author-note-core.ts',
    'power-user-core.ts'],
  tokens: ['token-accounting.ts', 'tokenizer-service.ts', 'content-token-cost.ts', 'image-token-cost.ts'],
  persistence: ['runtime-repository.ts'],
  storage: ['backup.ts', 'backup-routes.ts', 'story-export.ts', 'chat-jsonl-import.ts',
    'settings-routes.ts', 'preset-routes.ts', 'plugin-routes.ts'],
  // Renamed because `package-source.mjs` rejects any source path matching
  // `(?:^|/)fixtures(?:/|$)`, and because these are test infrastructure rather
  // than user data.
  testing: [['test-helpers.ts', 'helpers.ts'], ['native-fixtures.ts', 'native-character.ts']],
};

// Check that every non-test source file is accounted for.
const placed = new Set(Object.values(moves).flat().map(entry => Array.isArray(entry) ? entry[0] : entry));
const unplaced = (await readdir(root, { withFileTypes: true }))
  .filter(entry => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
  .map(entry => entry.name)
  .filter(name => !stayAtRoot.has(name) && !placed.has(name));
if (unplaced.length) throw new Error('Unclassified source files: ' + unplaced.join(', '));

// PHASE 1 — the complete plan, built without touching the filesystem.
const plan = new Map();
for (const [directory, entries] of Object.entries(moves)) {
  for (const entry of entries) {
    const [from, to] = Array.isArray(entry) ? entry : [entry, entry];
    plan.set('src/' + from, 'src/' + directory + '/' + to);
    // Co-located tests move with their module. `x-upstream.ts` is the adapted
    // module while its test is `x-upstream.test.ts`, so polling for the sibling
    // explicitly is more reliable than deriving the name.
    for (const test of [from.replace(/\.ts$/, '.test.ts'), from.replace(/\.ts$/, '-upstream.test.ts')]) {
      if (existsSync(join(root, test))) plan.set('src/' + test, 'src/' + directory + '/' + test);
    }
  }
}
// Every remaining file at src/ root — the shared HTTP plumbing, the byte-pinned
// files, the runtime helpers and each root-level test — stays where it is but
// still needs its specifiers rewritten, because the modules it imports moved.
// It must be in the plan for that to happen. This runs *after* the move plan
// above, so only files that really stay at root are inspected.
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
  const path = 'src/' + entry.name;
  if (plan.has(path)) continue;
  if (!entry.name.endsWith('.test.ts') && !stayAtRoot.has(entry.name)) {
    throw new Error('Root source file is neither pinned nor planned: ' + entry.name);
  }
  plan.set(path, path);
}

// Package-relative paths in, posix specifier out. Both sides are made absolute
// before relativizing: `path.relative('src', 'src/fixtures/x')` returns
// `fixtures/x` with no traversal segments, because a relative base is resolved
// against the process working directory.
const relativeSpecifier = (fromPath, toPath) => {
  const from = absoluteOf(fromPath);
  const to = toPath.startsWith('apps/') ? join(project, toPath) : absoluteOf(toPath);
  const segments = toPosix(relative(dirname(from), to)).split('/');
  return segments[0] === '..' || segments[0] === '.' ? segments.join('/') : './' + segments.join('/');
};

// PHASE 2 — rewrite every specifier against the ORIGINAL tree, then map the
// resolved target through `plan` to its final location.
let rewrittenFiles = 0;
let rewrittenSpecifiers = 0;
const pending = [];
for (const [from, to] of plan) {
  const source = await readFile(absoluteOf(from), 'utf8');
  let count = 0;
  // `specifier` is the form to resolve on disk; `emit` is the form to write
  // back, so a dynamic `import("./x")` stays extensionless instead of gaining a
  // `.js` that would break browser-style resolution.
  const resolve = (specifier, emit) => {
    // A relative specifier may start with `./` or with `../`; both must be
    // resolved, otherwise a `new URL("../../../packages/...")` reference is
    // silently left pointing at the wrong directory.
    if (!emit.startsWith('./') && !emit.startsWith('../')) return null;
    const base = dirname(absoluteOf(from));
    const candidates = [specifier, specifier.endsWith('.js') ? specifier.slice(0, -3) + '.ts' : specifier, specifier + '.ts']
      .map(candidate => join(base, candidate));
    // A `new URL("./x", import.meta.url)` reference resolves against the file at
    // runtime, so its literal path is only correct for the ORIGINAL directory.
    // Directory-relative references get extra traversal until they resolve.
    const withTraversal = [];
    for (const prefix of ['./', '../', '../../', '../../../']) {
      for (const candidate of candidates) withTraversal.push(join(base, prefix, relative(base, candidate)));
    }
    const resolved = [...candidates, ...withTraversal].find(candidate => existsSync(candidate));
    if (!resolved) return null;
    const found = 'src/' + toPosix(relative(root, resolved));
    const target = plan.get(found) ?? found;
    // NodeNext specifiers carry `.js` and JSON imports carry `.json`, while the
    // file on disk is `.ts`. Relativize without an extension and re-append the
    // original extension.
    const withoutExtension = relativeSpecifier(to, target.replace(/\.(ts|json)$/, ''));
    return emit.endsWith('.js') ? withoutExtension + '.js'
      : emit.endsWith('.json') ? withoutExtension + '.json'
        : withoutExtension;
  };
  const substitute = (specifier, prefix, suffix, emit = specifier) => {
    const relocated = resolve(specifier, emit);
    if (!relocated) return prefix + specifier + suffix;
    count += 1;
    return prefix + relocated + suffix;
  };
  // The quote capture spans newlines, covering multi-line import lists.
  let rewritten = source
    .replace(/(\bfrom\s+)(["'])([^"']+)\2/g, (_, lead, quote, specifier) => substitute(specifier, lead + quote, quote))
    .replace(/(\bimport\s*)(["'])([^"']+)\2/g, (_, lead, quote, specifier) => substitute(specifier, lead + quote, quote))
    .replace(/(\bimport\(\s*)(["'])([^"']+)\2(\s*\))/g, (_, lead, quote, specifier, tail) =>
      substitute(specifier.replace(/\.js$/, ''), lead + quote, quote + tail, specifier))
    // `new URL("./fixtures/x.json", import.meta.url)` resolves against the module
    // file at runtime, so it needs the same treatment as an import.
    .replace(/(new URL\(\s*)(["'])([^"']+)\2(\s*,\s*import\.meta\.url\s*\))/g,
      (_, lead, quote, specifier, tail) => substitute(specifier, lead + quote, quote + tail));
  if (count) { rewrittenFiles += 1; rewrittenSpecifiers += count; }
  pending.push({ from, to, source, rewritten });
}

if (dryRun) {
  for (const [from, to] of [...plan].sort()) console.log((from === to ? '    keep ' : '    move ') + from + ' -> ' + to);
  console.log(JSON.stringify({ files: plan.size, moved: [...plan].filter(([a, b]) => a !== b).length, rewrittenFiles, rewrittenSpecifiers }, null, 2));
  process.exit(0);
}

// PHASE 3 — move, then write. Moves happen before writes so a failure leaves the
// tree recoverable with `git checkout -- apps/local-service/src`.
for (const [from, to] of plan) {
  if (from === to) continue;
  const absoluteFrom = absoluteOf(from);
  const absoluteTo = absoluteOf(to);
  if (!existsSync(absoluteFrom)) {
    if (existsSync(absoluteTo)) continue;
    throw new Error('Missing source for move: ' + from);
  }
  await mkdir(dirname(absoluteTo), { recursive: true });
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', toPosix(relative(project, absoluteFrom))], { cwd: project, stdio: 'ignore' }).status === 0;
  if (tracked) {
    const result = spawnSync('git', ['mv', toPosix(relative(project, absoluteFrom)), toPosix(relative(project, absoluteTo))], { cwd: project, encoding: 'utf8' });
    if (result.status !== 0) throw new Error('git mv failed: ' + result.stderr);
  } else {
    await rename(absoluteFrom, absoluteTo);
  }
}
for (const { from, to, source, rewritten } of pending) {
  if (rewritten !== source) await writeFile(absoluteOf(to), rewritten);
}

console.log(JSON.stringify({ files: plan.size, moved: [...plan].filter(([a, b]) => a !== b).length,
  rewrittenFiles, rewrittenSpecifiers }, null, 2));
