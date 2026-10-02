import assert from 'node:assert/strict';
import { createServer } from 'node:http';

async function browserChecks() {
  const core = await import('/script.js'), runtime = await import('/plugin-runtime/compat-runtime.js'), host = await import('/plugin-runtime/desktop-host.js');
  const check = (value, message) => { if (!value) throw new Error(message); }, stages = [];
  const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const created = await post('/api/characters/create', { ch_name: 'Injection browser', first_mes: 'Greeting' });
  check(created.ok, 'Create injection fixture'); const avatar = await created.text();
  await core.getCharacters(); await core.selectCharacterById(core.characters.findIndex(item => item.avatar === avatar));
  const story = core.getCurrentChatId(), object = core.extension_prompts;
  check(object === runtime.getContext().extensionPrompts && core.MAX_INJECTION_DEPTH === 10000, 'Shared prompt object and maximum depth');
  check(['system', 'user', 'assistant', 2, 'bad', '__proto__'].map(core.getExtensionPromptRoleByName).join('|') === '0|1|2|2|0|0', 'Role names and fallback');
  let enabled = false, calls = 0;
  core.setExtensionPrompt('test-filter', 'FILTERED_OUT', 0, 0, false, 0, async () => { calls++; return enabled; });
  core.setExtensionPrompt('test-tail-z', 'TAIL_Z', 1, 0, false, 2);
  core.setExtensionPrompt('test-tail-a', 'TAIL_A {{char}}', 1, 0, false, 2);
  core.setExtensionPrompt('test-before', 'BEFORE_NATIVE', 2, 0, false, 1);
  const snapshot = await host.prepareExtensionPrompts();
  check(calls === 1 && !snapshot.some(prompt => prompt.key === 'test-filter'), 'Async false filters excluded');
  check(object['test-tail-a'].value === 'TAIL_A {{char}}' && snapshot.find(prompt => prompt.key === 'test-tail-a').value === 'TAIL_A Injection browser', 'Source remains raw while snapshot resolves macros');
  enabled = true; check((await host.prepareExtensionPrompts()).some(prompt => prompt.key === 'test-filter') && calls === 2, 'Filter reevaluates for the next request');
  delete object['test-filter'];
  object['test-tail-z'].value = 'TAIL_Z_EDITED';
  const preview = async () => {
    const response = await post('/api/conversations/' + story + '/prompt-preview', { draft: 'Preview input', extensionPrompts: await host.prepareExtensionPrompts() });
    check(response.ok, 'Preview succeeds'); return response.json();
  };
  const result = await preview();
  check(result.messages[0].role === 'user' && result.messages[0].content === 'BEFORE_NATIVE' && result.messages.at(-1).role === 'assistant' && result.messages.at(-1).content === 'TAIL_A Injection browser\nTAIL_Z_EDITED', 'Real preview honors direct mutations, key order, roles and depth');
  stages.push('shared-live-prompts-async-filters-macros-and-direct-mutation-reach-real-preview');

  core.chat_metadata.variables ??= {};
  core.chat_metadata.variables.outer = '{{getvar::inner}}';
  core.chat_metadata.variables.inner = 'SECOND';
  await core.saveMetadata();
  core.setExtensionPrompt('test-once', '{{getvar::outer}}', 0, 0, true, 0);
  const once = (await host.prepareExtensionPrompts()).find(prompt => prompt.key === 'test-once');
  check(once?.value === '{{getvar::inner}}' && once.macrosResolved === true,
    'Browser snapshot must mark the remaining nested macro as already evaluated');
  check((await preview()).messages.some(message => message.content === '{{getvar::inner}}'),
    'Native preview must not run a second macro pass on the browser snapshot');
  delete object['test-once'];
  delete core.chat_metadata.variables.outer; delete core.chat_metadata.variables.inner;
  await core.saveMetadata();
  stages.push('browser-snapshot-and-native-preview-share-one-macro-pass');

  const note = await import('/scripts/authors-note.js');
  const power = await import('/scripts/power-user.js');
  const localUser = await import('/scripts/user.js');
  check(localUser.isAdmin() === true, 'The single-user desktop profile has owner permissions');
  power.addEphemeralStoppingString('STOP_ONCE'); power.addEphemeralStoppingString('STOP_ONCE');
  check(power.getEphemeralStoppingStrings().join('|') === 'STOP_ONCE', 'Ephemeral stop strings deduplicate');
  power.flushEphemeralStoppingStrings();
  check(power.getEphemeralStoppingStrings().length === 0, 'Ephemeral stop strings clear after generation');
  core.chat_metadata.note_prompt = 'AUTHOR_NOTE_NATIVE';
  core.chat_metadata.note_interval = 1;
  core.chat_metadata.note_position = 1;
  core.chat_metadata.note_depth = 0;
  check(note.syncAuthorNote(1).active && note.shouldWIAddPrompt, 'Author note eligibility follows current chat metadata');
  await core.saveMetadata();
  const noted = await preview();
  check(noted.messages.some(message => message.content.includes('AUTHOR_NOTE_NATIVE')), 'Persisted author note reaches the real prompt preview');
  core.chat_metadata.note_interval = 0;
  check(!note.syncAuthorNote(1).active && !note.shouldWIAddPrompt, 'Disabling the interval updates the live export');
  await core.saveMetadata();
  const disabledNote = await preview();
  check(!disabledNote.messages.some(message => message.content.includes('AUTHOR_NOTE_NATIVE')), 'Disabled author note stays out of the prompt');
  delete core.chat_metadata.note_prompt; delete core.chat_metadata.note_interval;
  delete core.chat_metadata.note_position; delete core.chat_metadata.note_depth;
  await core.saveMetadata();
  stages.push('author-note-module-shares-live-metadata-and-native-preview-placement');
  stages.push('single-user-desktop-owner-permission-is-exposed-to-extensions');
  stages.push('power-user-ephemeral-stopping-strings-have-a-real-lifecycle');

  let release; const gate = new Promise(resolve => { release = resolve; });
  core.setExtensionPrompt('test-scope', 'SCOPE {{char}}', 0, 0, false, 0, () => gate);
  const pending = runtime.snapshotExtensionPrompts(), oldName = runtime.getContext().name2;
  runtime.getContext().name2 = 'Later name'; object['test-scope'].value = 'LATER_VALUE'; release(true);
  const captured = await pending; runtime.getContext().name2 = oldName; delete object['test-scope'];
  check(captured.find(prompt => prompt.key === 'test-scope').value === 'SCOPE Injection browser', 'Snapshot captures text and macro context before awaiting filters');
  stages.push('async-filter-wait-keeps-captured-prompt-text-and-character-name');

  core.setExtensionPrompt('test-none', 'SCAN_ONLY_TRIGGER', -1, 0, true);
  const world = await import('/scripts/world-info.js');
  await world.createNewWorldInfo('injection-scan-book');
  await world.saveWorldInfo('injection-scan-book', { entries: { 1: { uid: 1, key: ['SCAN_ONLY_TRIGGER'], keysecondary: [], content: 'SCAN_ACTIVATED', position: 1, disable: false, scanDepth: 0 } } }, true);
  const settings = world.getWorldInfoSettings();
  await world.updateWorldInfoSettings(settings, ['injection-scan-book']);
  const scanned = await preview();
  check(JSON.stringify(scanned.messages).includes('SCAN_ACTIVATED') && !JSON.stringify(scanned.messages).includes('SCAN_ONLY_TRIGGER'), 'Scan-only input triggers world info without directly entering model messages');
  const worldResult = await world.getWorldInfoPrompt(['No keyword in chat'], 4096, true);
  check(JSON.stringify(worldResult).includes('SCAN_ACTIVATED'), 'World-info module sees the same live scan injections');
  delete object['test-none']; check(!JSON.stringify((await preview()).messages).includes('SCAN_ACTIVATED'), 'Deleting scan injection removes its world trigger');
  stages.push('scan-only-prompts-feed-native-and-world-module-scanning-without-leaking-text');

  core.setExtensionPrompt('test-failure', 'SHOULD_NOT_SEND', 0, 0, false, 0, () => { throw new Error('Prompt filter fixture failure'); });
  let rejected = false;
  try { await host.prepareExtensionPrompts(); } catch (error) { rejected = String(error).includes('Prompt filter fixture failure'); }
  check(rejected, 'Filter errors reject rather than silently skip');
  window.injectionCore = core;
  stages.push('filter-exceptions-propagate-before-request-assembly');
  return { stages, story, avatar };
}

export async function verifyPluginPromptInjection(window, service) {
  const requests = [];
  const model = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (!body.stream) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: '[]' } }] })); return; }
    requests.push(body);
    response.setHeader('Content-Type', 'text/event-stream');
    response.end('data: {"choices":[{"delta":{"content":"Injected reply"}}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const evaluate = code => window.webContents.executeJavaScript(code);
  const wait = async predicate => { const end = Date.now() + 10000; while (!await predicate()) { if (Date.now() > end) throw new Error('Injection fixture wait timed out'); await new Promise(resolve => setTimeout(resolve, 25)); } };
  try {
    const report = await evaluate(`(${browserChecks.toString()})()`);
    const provider = await service.inject({ method: 'PUT', url: '/api/settings/provider', payload: { kind: 'ollama', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: 'injection-fixture', maxTokens: 200 } });
    assert.equal(provider.statusCode, 200);
    await evaluate(`(() => { $('#send_textarea').val('Filter failure draft').trigger('input'); $('#send_but').trigger('click'); })()`);
    await wait(() => evaluate(`document.body.textContent.includes('Prompt filter fixture failure') && !injectionCore.is_send_press`));
    assert.equal(await evaluate(`document.getElementById('send_textarea').value`), 'Filter failure draft');
    assert.equal(requests.length, 0);
    assert.equal((await service.inject({ method: 'GET', url: '/api/conversations/' + report.story })).json().messages.length, 1);
    report.stages.push('native-filter-failure-keeps-draft-without-model-request-or-chat-write');
    await evaluate(`(() => { delete injectionCore.extension_prompts['test-failure']; $('#send_textarea').val('Native injection input').trigger('input'); $('#send_but').trigger('click'); })()`);
    await wait(() => evaluate(`!injectionCore.is_send_press && injectionCore.chat.at(-1)?.mes === 'Injected reply'`));
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].messages[0], { role: 'user', content: 'BEFORE_NATIVE' });
    assert.deepEqual(requests[0].messages.at(-1), { role: 'assistant', content: 'TAIL_A Injection browser\nTAIL_Z_EDITED' });
    const stored = (await service.inject({ method: 'GET', url: '/api/conversations/' + report.story })).json();
    assert.equal(stored.messages.length, 3); assert(!JSON.stringify(stored).includes('TAIL_Z_EDITED'));
    const noSnapshot = (await service.inject({ method: 'POST', url: '/api/conversations/' + report.story + '/prompt-preview', payload: { draft: 'Without browser snapshot' } })).json();
    assert(!JSON.stringify(noSnapshot.messages).includes('TAIL_Z_EDITED'));
    assert(!JSON.stringify(noSnapshot.messages).includes('Fixture prompt from actual extension.'), 'Legacy flattened contributions must not duplicate dynamic prompts');
    report.stages.push('actual-send-uses-current-role-depth-snapshot-without-saving-injected-messages');

    await evaluate(`(async () => {
      const {power_user,persona_description_positions} = await import('/scripts/power-user.js');
      power_user.persona_description = 'PERSONA_PERSISTED';
      power_user.persona_description_position = persona_description_positions.IN_PROMPT;
      await injectionCore.saveSettings();
    })()`);
    const personaPreview = (await service.inject({ method: 'POST', url: '/api/conversations/' + report.story + '/prompt-preview', payload: { draft: 'Persona draft' } })).json();
    assert(personaPreview.messages.some(message => message.content === 'PERSONA_PERSISTED'));
    report.stages.push('power-user-persona-settings-reach-native-budgeted-preview');

    const switched = await evaluate(`(async () => {
      const core = injectionCore;
      const r = await fetch('/api/characters/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ch_name: 'Injection next story', first_mes: 'Next opening' }) });
      const avatar = await r.text(); await core.getCharacters(); const old = core.extension_prompts;
      await core.selectCharacterById(core.characters.findIndex(item => item.avatar === avatar));
      return old !== core.extension_prompts && !(await (await import('/plugin-runtime/desktop-host.js')).prepareExtensionPrompts()).some(prompt => prompt.key.startsWith('test-'));
    })()`);
    assert.equal(switched, true);
    report.stages.push('story-switch-replaces-live-binding-and-clears-temporary-injections');
    window.reload();
    await wait(async () => { try { return await evaluate(`(async () => { const core = await import('/script.js'); const host = await import('/plugin-runtime/desktop-host.js'); return host.getStatuses().success === '扩展已运行' && !(await host.prepareExtensionPrompts()).some(prompt => prompt.key.startsWith('test-')); })()`); } catch { return false; } });
    report.stages.push('full-reload-restores-extension-registrations-without-old-temporary-prompts');
    const personaAfterReload = await evaluate(`(async () => (await import('/scripts/power-user.js')).power_user.persona_description)()`);
    assert.equal(personaAfterReload, 'PERSONA_PERSISTED');
    report.stages.push('power-user-persona-state-survives-document-reload');
    return report;
  } finally { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); }
}
