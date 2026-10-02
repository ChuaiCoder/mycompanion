// SPDX-License-Identifier: AGPL-3.0-only
import { reportUrl, upstreamPublicUrl, writeFixtures } from './oracle-paths.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import vm from 'node:vm';

const base = upstreamPublicUrl;
const files = new Map();
function declarations(path, names) {
  const text = readFileSync(new URL(path, base), 'utf8');
  const nodes = names.map(name => {
    const pattern = new RegExp('^(?:export )?(?:async )?(?:function|class) ' + name + '(?:\\(|\\s)', 'm');
    const match = pattern.exec(text);
    assert(match, 'Missing exact top-level upstream declaration ' + name);
    const end = text.indexOf('\n}', match.index);
    assert(end > match.index, 'Missing unindented closing brace for ' + name);
    const body = text.slice(match.index, end + 2);
    // Compile individually as a syntax-boundary check. The body is unchanged.
    new vm.Script(body.replace(/^export\s+/, ''));
    return { name, line: text.slice(0, match.index).split('\n').length, body };
  });
  files.set(path, { sha256: createHash('sha256').update(text).digest('hex'), declarations: nodes.map(node => ({
    name: node.name, line: node.line,
    sha256: createHash('sha256').update(node.body).digest('hex'),
  })) });
  // Only remove ESM export syntax; function/class bodies are executed unchanged.
  return nodes.map(node => node.body.replace(/^export\s+/, '')).join('\n');
}
const source = [
  declarations('script.js', ['substituteParamsLegacy', 'substituteParams', 'baseChatReplace', 'createLazyFields', 'getCharacterCardFieldsLazy', 'getCharacterCardFields', 'parseMesExamples']),
  declarations('scripts/variables.js', ['getLocalVariable', 'setLocalVariable', 'getGlobalVariable', 'setGlobalVariable', 'addLocalVariable', 'addGlobalVariable', 'incrementLocalVariable', 'incrementGlobalVariable', 'decrementLocalVariable', 'decrementGlobalVariable', 'getVariableMacros']),
  declarations('scripts/macros.js', ['MacrosParser', 'evaluateMacros', 'getBannedWordsMacro', 'getRandomReplaceMacro', 'getPickReplaceMacro', 'getDiceRollMacro', 'getTimeDiffMacro', 'getChatIdHash']),
  declarations('scripts/utils.js', ['getStringHash', 'escapeRegex']),
].join('\n');
const field = (label, counter) => `${label}={{incvar::phase}}/{{incvar::${counter}}}{{addvar::trace::${label}>}}`;
const counters = ['systemRuns', 'exampleRuns', 'descriptionRuns', 'personalityRuns', 'personaRuns', 'scenarioRuns',
  'jailbreakRuns', 'depthRuns', 'notesRuns', 'firstRuns', 'alternateRuns'];
const card = {
  name: 'Character macro phases', description: field('D','descriptionRuns'), personality: field('P','personalityRuns'),
  scenario: field('SCENARIO','scenarioRuns'), mes_example: field('E','exampleRuns'), first_mes: field('FIRST','firstRuns'),
  data: { system_prompt: field('S','systemRuns'), post_history_instructions: field('PHI','jailbreakRuns'),
    creator_notes: field('NOTES','notesRuns'), alternate_greetings: [field('ALT','alternateRuns')],
    character_version: '{{incvar::versionRuns}}', extensions: { depth_prompt: { prompt: field('DEPTH','depthRuns') } } },
};
const reads = [], calls = [], warnings = [];
const context = vm.createContext({
  console: { warn: (...args) => warnings.push(args.map(String)), debug: () => {} },
  characters: [card], this_chid: 0, selected_group: null, groups: [], name1: 'User', name2: card.name, main_api: 'openai',
  power_user: { experimental_macro_engine: false, prefer_character_prompt: true, prefer_character_jailbreak: true,
    persona_description: field('PERSONA','personaRuns'), collapse_newlines: false, instruct: { enabled: false }, context: { example_separator: '' } },
  chat_metadata: { variables: {}, chat_id_hash: 1 }, extension_settings: { variables: { global: {} } }, chat: [],
  accountStorage: { getItem: () => 'true' }, getGeneratingModel: () => 'gpt-4o',
  getInstructMacros: () => [], uuidv4: randomUUID,
  saveMetadataDebounced: () => {}, saveSettingsDebounced: () => {},
  reads,
});
vm.runInContext(source, context, { filename: 'unmodified-selected-upstream-declarations.js' });
vm.runInContext(`
  const readOriginal = getCharacterCardFields;
  getCharacterCardFields = function (...args) {
    const before = structuredClone(chat_metadata.variables);
    const fields = readOriginal(...args);
    reads.push({ before, fields: structuredClone(fields), after: structuredClone(chat_metadata.variables) });
    return fields;
  };
`, context);
// vm's isolated realm has no structuredClone by default; expose Node's standard.
context.structuredClone = structuredClone;
function call(label, expression) {
  const before = structuredClone(context.chat_metadata.variables), readsBefore = reads.length;
  const output = vm.runInContext(expression, context);
  const after = structuredClone(context.chat_metadata.variables);
  calls.push({ label, expression, before, output: structuredClone(output), after, cardReads: reads.length - readsBefore });
  return output;
}
const worldSnapshot = 'WORLD={{getvar::phase}};' + counters.map(key => `${key}={{getvar::${key}}}`).join(';') + ';TRACE={{getvar::trace}}';
const snapshots = [];
for (const round of [1, 2]) {
  const firstCard = call(`round-${round}:native-first-card`, 'getCharacterCardFields()');
  const keyword = call(`round-${round}:WI-keyword`, "substituteParams('/D=\\\\d+\\\\/\\\\d+/')");
  const world = call(`round-${round}:WI-selected-WORLD`, `substituteParams(${JSON.stringify(worldSnapshot)})`);
  const matched = call(`round-${round}:WI-selected-matched-description`, "substituteParams('MATCHED_DESCRIPTION={{getvar::descriptionRuns}}')");
  const persona = call(`round-${round}:assembly-persona`, 'substituteParams(power_user.persona_description)');
  assert.equal(firstCard.system, `S=${(round - 1) * 56 + 1}/${(round - 1) * 5 + 1}`);
  assert(world.startsWith(`WORLD=${(round - 1) * 56 + 33};systemRuns=${(round - 1) * 5 + 3};`));
  assert.equal(matched, `MATCHED_DESCRIPTION=${(round - 1) * 5 + 4}`);
  assert.equal(persona, `PERSONA=${round * 56}/${round * 6}`);
  assert.equal(context.chat_metadata.variables.phase, round * 56);
  for (const counter of counters) assert.equal(context.chat_metadata.variables[counter], round * (counter === 'personaRuns' ? 6 : 5));
  assert.equal(context.chat_metadata.variables.versionRuns, undefined);
  snapshots.push({ round, firstCard, keyword, world, matched, persona, final: structuredClone(context.chat_metadata.variables) });
}
assert.equal(warnings.length, 0, 'Any swallowed upstream macro exception invalidates this oracle');
assert.equal(reads.length, 10);
const report = { passed: true, upstreamCommit: '7e8663cd9c184a550b37238218bdd32c6efc68e9',
  scope: 'Real pinned legacy macro and card functions executed on the same fixture and explicit native call sequence. This validates per-call eager effects, not full ST generation parity or PromptManager pass completeness.',
  bindings: { getInstructMacros: 'empty because instruct is disabled; no instruct macros in fixture', saveMetadataDebounced: 'disabled in isolated memory-only oracle', saveSettingsDebounced: 'disabled in isolated memory-only oracle',
    environment: 'single-character Chat Completion with no custom registered macros; deterministic UUID provider' },
  sources: Object.fromEntries(files), calls, reads, snapshots, warnings };
const target = reportUrl('native-legacy-upstream-oracle-20261002.json');
writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: true, target: target.pathname, calls: calls.length, eagerCardReads: reads.length, rounds: snapshots.map(snapshot => snapshot.final.phase) }));
export { declarations, source, files };
