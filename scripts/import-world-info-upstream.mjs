// Imports native scanning components from the reviewed AGPL-3.0-only checkout.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'acorn';

const commit = '7e8663cd9c184a550b37238218bdd32c6efc68e9';
const root = resolve(process.argv[2] ?? `.cache/research/SillyTavern-${commit}`);
const worldPath = 'public/scripts/world-info.js', utilsPath = 'public/scripts/utils.js';
const world = readFileSync(join(root, worldPath), 'utf8'), utils = readFileSync(join(root, utilsPath), 'utf8');
const ast = source => parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const unwrap = node => node.type === 'ExportNamedDeclaration' ? node.declaration : node;
function extract(source, name) {
  const node = ast(source).body.map(unwrap).find(node => node?.id?.name === name
    || node?.type === 'VariableDeclaration' && node.declarations.some(value => value.id?.name === name));
  if (!node) throw new Error(`Missing fixed-upstream component ${name}`);
  return source.slice(node.start, node.end);
}
const components = ['WorldInfoBuffer', 'WorldInfoTimedEffects', 'filterGroupsByScoring',
  'filterGroupsByTimedEffects', 'filterByInclusionGroups', 'parseDecorators'];
let bodies = components.map(name => {
  const body = extract(world, name);
  if (name !== 'WorldInfoTimedEffects') return body;
  return body.slice(0, body.lastIndexOf('}')) + `
    __snapshotForBridge() { return { chat: this.#chat, entries: this.#entries, isDryRun: this.#isDryRun, buffer: this.#buffer }; }
    __restoreForBridge(state) { this.#chat = state.chat; this.#entries = state.entries; this.#isDryRun = state.isDryRun; this.#buffer = state.buffer; }
}`;
}).join('\n\n');
// Keep groups independent of any extension/application singleton. The upstream
// removeEntry could splice(-1,1) for overlapping groups; removal is idempotent.
bodies = bodies.replace('const removeEntry = (entry) => newEntries.splice(newEntries.indexOf(entry), 1);',
  'const removeEntry = (entry) => { const index = newEntries.indexOf(entry); if (index >= 0) { newEntries.splice(index, 1); deps.onGroupRemoved?.(entry); } };');
bodies = bodies.replaceAll('Math.random()', 'deps.random()');
// A zero chat depth excludes chat history, not an explicitly enabled extension
// scan source. Preserve that native contract without scanning character fields
// or recursive text behind the caller's zero-depth boundary.
bodies = bodies.replace("if (depth <= this.#startDepth) {\n            return '';\n        }",
  "if (depth <= this.#startDepth) {\n            return depth === this.#startDepth && this.#injectBuffer.length > 0\n                ? '\\x01' + this.#injectBuffer.join('\\n\\x01') : '';\n        }");
const scanNode = ast(world).body.map(unwrap).find(node => node?.id?.name === 'checkWorldInfo');
const buildIndex = scanNode.body.body.findIndex(node => world.slice(node.start, node.end).includes("--- BUILDING PROMPT ---"));
if (buildIndex < 0) throw new Error('Missing scanner/presentation boundary');
let scan = world.slice(scanNode.start, scanNode.body.body[buildIndex].start)
  .replace('async function checkWorldInfo', 'function checkWorldInfo')
  .replaceAll('await ', '')
  .replace('const context = getContext();', 'const context = deps.context;')
  .replaceAll('getExtensionPromptByName(key)', 'context.extensionPrompts[key].value')
  .replace('const sortedEntries = getSortedEntries();', 'const sortedEntries = deps.entries;')
  .replace('const timedEffects = new WorldInfoTimedEffects(chat, sortedEntries, isDryRun);',
    'const timedEffects = new WorldInfoTimedEffects(deps.timedChat ?? chat, sortedEntries, isDryRun);\n    const budgetDropped = new Set();')
  .replace("return { worldInfoBefore: '', worldInfoAfter: '', WIDepthEntries: [], EMEntries: [], ANBeforeEntries: [], ANAfterEntries: [], outletEntries: {}, allActivatedEntries: new Set() };",
    'return { activated: allActivatedEntries, failedProbabilityChecks, budgetDropped, budgetOverflowed: false };')
  .replace('let budget = Math.round(world_info_budget * maxContext / 100) || 1;', 'let budget = deps.budget;')
  .replaceAll('getTokenCountAsync(', 'deps.countTokens(')
  .replaceAll('substituteParams(', 'deps.substitute(')
  .replaceAll('getCharaFilename()', 'deps.characterFilename')
  .replaceAll('getTagKeyForEntity(this_chid)', 'deps.characterTagKey')
  .replaceAll('Math.random()', 'deps.random()')
  .replace('function log(...args) {', 'function log(...args) {\n                deps.onDecision?.(entry, args[0]);')
  .replace('eventSource.emit(event_types.WORLDINFO_SCAN_DONE, args);', 'deps.onScan?.(args);')
  .replace('if (!primaryKeyMatch) {', 'if (primaryKeyMatch) deps.onMatched?.(entry, primaryKeyMatch);\n            if (!primaryKeyMatch) {')
  .replace('if (token_budget_overflowed && !entry.ignoreBudget) {',
    'if (token_budget_overflowed && !entry.ignoreBudget) {\n                for (const remaining of newEntries.slice(newEntries.indexOf(entry))) if (!remaining.ignoreBudget) budgetDropped.add(remaining);')
  .replace('if (!entry.ignoreBudget && (textToScanTokens + (deps.countTokens(newContent))) >= budget) {',
    'if (!entry.ignoreBudget && (textToScanTokens + (deps.countTokens(newContent))) >= budget) {\n                budgetDropped.add(entry);');
scan += `\n    timedEffects.setTimedEffects(Array.from(allActivatedEntries.values()));
    buffer.resetExternalEffects();
    timedEffects.cleanUp();
    return { activated: allActivatedEntries, failedProbabilityChecks, budgetDropped, budgetOverflowed: token_budget_overflowed };
}`;
const settings = ['world_info_depth','world_info_case_sensitive','world_info_match_whole_words','world_info_recursive',
  'world_info_max_recursion_steps','world_info_min_activations','world_info_min_activations_depth_max',
  'world_info_use_group_scoring','world_info_budget','world_info_budget_cap','world_info_overflow_alert'];
const source = `// @ts-nocheck -- readable fixed-upstream JavaScript, compiled by the native service.
/*! Adapted from SillyTavern 1.19.0, ${commit}. AGPL-3.0-only.
 * See world-info-upstream.json and THIRD_PARTY_NOTICES.md. */
import { parseRegexFromString } from '@mycompanion/shared';
export function createWorldInfoRuntime(deps: any): any {
  const { ${settings.join(', ')} } = deps.settings;
  const chat_metadata = deps.metadata;
  const console = deps.console ?? { debug() {}, log() {}, warn() {}, error() {} };
  const toastr = { warning: (message) => deps.onWarning?.(message) };
  ${['sortFn','DEFAULT_WEIGHT','MAX_SCAN_DEPTH','KNOWN_DECORATORS','scan_state','world_info_logic','defaultGlobalScanData'].map(name => extract(world,name)).join('\n  ')}
  // cyrb53 (c) 2018 bryc. Public domain (or MIT).
  // https://github.com/bryc/code/blob/master/jshash/experimental/cyrb53.js
  ${extract(utils,'getStringHash')}
  ${extract(utils,'escapeRegex')}
  ${bodies}
  ${scan}
  return { scan: checkWorldInfo, parseDecorators, getStringHash, WorldInfoBuffer, WorldInfoTimedEffects, filterByInclusionGroups, scan_state };
}
`;
const sha256 = source => createHash('sha256').update(source).digest('hex');
// The macro-engine outlet extraction was removed with the compatibility layer.
// It wrote `packages/macro-engine/src/definitions/world-info-macros.js` and edited
// `packages/macro-engine/upstream.json`, neither of which exists any more, so
// running this importer would fail after the runtime source had already been
// rewritten. Only the native scanner runtime is regenerated here.
writeFileSync(resolve('apps/local-service/src/world-info-upstream-runtime.ts'), source);
writeFileSync(resolve('apps/local-service/world-info-upstream.json'), JSON.stringify({
  repository: 'https://github.com/SillyTavern/SillyTavern', commit, license: 'AGPL-3.0-only',
  files: [{ path: 'src/world-info-upstream-runtime.ts', upstreamPath: worldPath,
    upstreamSha256: sha256(world), adaptedSha256: sha256(source), components: [...components, 'checkWorldInfo (scan phase only)'],
    adaptation: 'Invocation-local dependencies and metadata; synchronous native tokenizer/macro traversal yields through an awaited browser effect RPC at each original scan event. Ordinal replay caches listener results and graph transport preserves shared entry/array/Map/Set identities across loops. Two state snapshot/restore methods bridge private TimedEffects fields to the identical extracted class in the extension realm. Injection text is already prepared; presentation/regex stays a separate native stage. Weighted/probability draws use the request session. An idempotent removeEntry repairs splice(-1) deletion for overlapping groups. At zero chat depth, explicit extension scan injections remain eligible while chat/character/recursive text stay excluded. Scanner selection/state transitions/timer algorithms otherwise retained.' },
  { upstreamPath: utilsPath, upstreamSha256: sha256(utils), components: ['getStringHash','escapeRegex'],
    attribution: 'cyrb53, bryc 2018, Public domain (or MIT); attribution preserved in the generated source. escapeRegex remains under the upstream AGPL-3.0-only license.' }],
}, null, 2) + '\n');
console.log(JSON.stringify({ path: 'src/world-info-upstream-runtime.ts', bytes: Buffer.byteLength(source), sha256: sha256(source) }));
