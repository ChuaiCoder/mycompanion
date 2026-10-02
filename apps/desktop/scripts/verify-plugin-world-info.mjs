import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

async function browserWorldInfoChecks() {
  const stages = [], check = (ok, message) => { if (!ok) throw new Error(message); };
  const wait = async predicate => { const end = Date.now() + 6000; while (!await predicate()) { if (Date.now() > end) throw new Error('World info wait timed out'); await new Promise(resolve => setTimeout(resolve, 15)); } };
  const wi = await import('/scripts/world-info.js');
  const internal = await import('/plugin-runtime/world-info.js');
  const script = await import('/script.js');
  const { Popup } = await import('/scripts/popup.js');
  const originalFetch = window.fetch;
  const post = (path, body) => originalFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const read = name => post('/api/worldinfo/get', { name }).then(response => response.ok ? response.json() : null);
  const make = (content, extra = {}) => ({ entries: { 7: { ...structuredClone(wi.newWorldInfoEntryTemplate), uid: 7, key: ['star'], content, position: 1, ...extra } } });
  const names = wi.world_names, selected = wi.selected_world_info, state = wi.world_info;
  check((await import('/plugin-runtime/scripts/world-info.js')).world_names === names && internal.world_info === state, 'Aliases must share mutable world state');
  check(wi.world_info_position.atDepth === 4 && wi.world_info_logic.AND_ALL === 3 && wi.DEFAULT_DEPTH === 4 && wi.DEFAULT_WEIGHT === 100, 'World info constants');
  check(wi.parseRegexFromString('/a\\/b/i').test('A/B') && wi.parseRegexFromString('/bad/flags') === null && wi.parseRegexFromString('word') === null, 'Regex parser contract');
  const card = { entries: [{ keys: ['star'], content: 'Converted', enabled: true, insertion_order: 42, extensions: { ignore_budget: true, scan_depth: 3, outlet_name: 'custom', future: 9 } }] };
  const converted = wi.convertCharacterBook(card);
  check(card.entries[0].id === 0 && converted.entries[0].ignoreBudget && converted.entries[0].scanDepth === 3 && converted.entries[0].extensions.future === 9 && converted.originalData === card, 'Card conversion and original fields');
  stages.push('canonical-module-live-state-regex-and-card-conversion');
  try {
    check(await wi.createNewWorldInfo('fixture:world-a'), 'Create sanitized book');
    check(names.includes('fixtureworld-a') && names === wi.world_names && state === wi.world_info, 'Names must be hydrated in place');
    check(!await wi.createNewWorldInfo('FIXTUREWORLD-A'), 'Noninteractive duplicate must not overwrite');
    await wi.saveWorldInfo('fixtureworld-a', make('Original'), true);
    const declined = wi.createNewWorldInfo('fixtureworld-a', { interactive: true });
    await wait(() => Popup.util.isPopupOpen()); Popup.util.popups.at(-1).cancelButton.click();
    check(await declined === false && (await read('fixtureworld-a')).entries[7].content === 'Original', 'Actual cancel dialog preserves book');
    const confirmed = wi.createNewWorldInfo('fixtureworld-a', { interactive: true });
    await wait(() => Popup.util.isPopupOpen()); Popup.util.popups.at(-1).okButton.click();
    check(await confirmed && Object.keys((await read('fixtureworld-a')).entries).length === 0, 'Actual confirm overwrites');
    check(await wi.createNewWorldInfo('fixtureworld-b'), 'Create second book');
    stages.push('sanitized-create-duplicate-check-and-confirmed-overwrite');

    const first = make('Debounced A'); await wi.saveWorldInfo('fixtureworld-a', first);
    first.entries[7].content = 'Caller mutation';
    await wi.saveWorldInfo('fixtureworld-b', make('Debounced B'));
    const cached = await wi.loadWorldInfo('fixtureworld-a'); cached.entries[7].content = 'Unsaved mutation';
    check((await wi.loadWorldInfo('fixtureworld-a')).entries[7].content === 'Debounced A', 'Cache reads and input snapshots must be independent');
    await internal.flushWorldInfoWrites();
    check((await read('fixtureworld-a')).entries[7].content === 'Debounced A' && (await read('fixtureworld-b')).entries[7].content === 'Debounced B', 'Each book needs its own debounce slot');
    stages.push('multi-book-debounce-and-cloned-cache-read-write-snapshots');

    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    window.fetch = async (path, options) => {
      if (path === '/api/worldinfo/edit' && JSON.parse(options.body).data.entries[7]?.content === 'Held old') { entered(); await gate; }
      return originalFetch(path, options);
    };
    const old = wi.saveWorldInfo('fixtureworld-a', make('Held old'), true); await started;
    const newer = wi.saveWorldInfo('fixtureworld-a', make('Newer'), true);
    await wi.saveWorldInfo('fixtureworld-b', make('Independent'), true);
    check((await read('fixtureworld-b')).entries[7].content === 'Independent', 'Different book writes must not be blocked');
    check((await wi.loadWorldInfo('fixtureworld-a')).entries[7].content === 'Newer', 'Old save acknowledgement must not replace newer cache');
    release(); await Promise.all([old, newer]); window.fetch = originalFetch;
    check((await read('fixtureworld-a')).entries[7].content === 'Newer', 'Same-book writes must persist in call order');
    stages.push('same-book-write-order-and-independent-book-progress');

    wi.worldInfoCache.delete('fixtureworld-a');
    let releaseRead, enteredRead;
    const readGate = new Promise(resolve => { releaseRead = resolve; });
    const readStarted = new Promise(resolve => { enteredRead = resolve; });
    window.fetch = async (path, options) => {
      const response = await originalFetch(path, options);
      if (path === '/api/worldinfo/get') { enteredRead(); await readGate; }
      return response;
    };
    const stale = wi.loadWorldInfo('fixtureworld-a'); await readStarted;
    await wi.saveWorldInfo('fixtureworld-a', make('After stale read'), true);
    releaseRead(); check((await stale).entries[7].content === 'After stale read', 'Late read must not overwrite a newer cache edit'); window.fetch = originalFetch;
    stages.push('late-network-read-cannot-revert-newer-data');

    let failed = false;
    window.fetch = async (path, options) => {
      if (path === '/api/worldinfo/edit' && !failed) { failed = true; return new Response('fixture failure', { status: 503 }); }
      return originalFetch(path, options);
    };
    let rejected = false;
    try { await wi.saveWorldInfo('fixtureworld-a', make('Rejected'), true); } catch { rejected = true; }
    check(rejected && (await read('fixtureworld-a')).entries[7].content === 'After stale read', 'HTTP failure must reject and leave stored data intact');
    window.fetch = originalFetch; await wi.saveWorldInfo('fixtureworld-a', make('Recovered'), true);
    await internal.flushWorldInfoWrites();
    check((await read('fixtureworld-a')).entries[7].content === 'Recovered', 'Rejected writes must not poison later writes');
    stages.push('failed-save-rejects-and-queue-recovers');

    const reentrant = async (name, data) => { if (name === 'fixtureworld-a' && data.entries[7]?.content === 'Outer') await wi.saveWorldInfo(name, make('Inner'), true); };
    script.eventSource.on(script.event_types.WORLDINFO_UPDATED, reentrant);
    await wi.saveWorldInfo('fixtureworld-a', make('Outer'), true);
    script.eventSource.removeListener(script.event_types.WORLDINFO_UPDATED, reentrant);
    check((await read('fixtureworld-a')).entries[7].content === 'Inner', 'Update callback must be able to await another write');
    stages.push('save-listener-can-await-reentrant-save');

    await wi.saveWorldInfo('fixtureworld-b', make('Must not resurrect'));
    check(await wi.deleteWorldInfo('fixtureworld-b'), 'Delete pending book');
    await internal.flushWorldInfoWrites();
    check(await read('fixtureworld-b') === null && await wi.loadWorldInfo('fixtureworld-b') === null && !names.includes('fixtureworld-b'), 'Delete must cancel pending save and cache');
    stages.push('delete-cancels-debounce-and-removes-persisted-book');

    await wi.createNewWorldInfo('fixtureworld-b');
    let releaseWrite, enteredWrite;
    const writeGate = new Promise(resolve => { releaseWrite = resolve; });
    const writeStarted = new Promise(resolve => { enteredWrite = resolve; });
    window.fetch = async (path, options) => {
      if (path === '/api/worldinfo/edit' && JSON.parse(options.body).name === 'fixtureworld-b') { enteredWrite(); await writeGate; }
      return originalFetch(path, options);
    };
    const inFlight = wi.saveWorldInfo('fixtureworld-b', make('Already in flight'), true); await writeStarted;
    const deleting = wi.deleteWorldInfo('fixtureworld-b'); releaseWrite();
    await inFlight; check(await deleting && await read('fixtureworld-b') === null, 'Delete must follow an already-started write');
    window.fetch = originalFetch;
    await wi.createNewWorldInfo('fixtureworld-b'); await wi.saveWorldInfo('fixtureworld-b', make('Before delete'), true);
    let releaseDelete, enteredDelete, releaseLate, enteredLate;
    const deleteGate = new Promise(resolve => { releaseDelete = resolve; }), deleteStarted = new Promise(resolve => { enteredDelete = resolve; });
    const lateGate = new Promise(resolve => { releaseLate = resolve; }), lateStarted = new Promise(resolve => { enteredLate = resolve; });
    window.fetch = async (path, options) => {
      if (path === '/api/worldinfo/delete') { enteredDelete(); await deleteGate; }
      const response = await originalFetch(path, options);
      if (path === '/api/worldinfo/get') { enteredLate(); await lateGate; }
      return response;
    };
    const deletePending = wi.deleteWorldInfo('fixtureworld-b'); await deleteStarted;
    const lateRead = wi.loadWorldInfo('fixtureworld-b'); await lateStarted;
    releaseDelete(); check(await deletePending, 'Deletion must commit'); releaseLate();
    check(await lateRead === null && !wi.worldInfoCache.has('fixtureworld-b'), 'Read started during deletion must not repopulate the cache after commit');
    window.fetch = originalFetch;
    stages.push('delete-waits-in-flight-write-and-invalidates-late-read');

    selected.splice(0, selected.length, 'fixtureworld-a');
    $('#world_info_depth').val(3).trigger('input');
    $('#world_info_include_names').prop('checked', false).trigger('input');
    await script.saveSettings();
    const saved = await originalFetch('/api/worldinfo/settings').then(response => response.json());
    check(saved.world_info_depth === 3 && saved.world_info.globalSelect[0] === 'fixtureworld-a' && wi.world_info_include_names === false, 'Actual setting controls must update live state and database');
    check(wi.getWorldInfoSettings().world_info === state && state.globalSelect === selected, 'Settings object must retain imported identities');
    stages.push('real-settings-controls-live-bindings-and-persistence');

    const promptBook = { entries: Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7].map(position => [position, {
      ...structuredClone(wi.newWorldInfoEntryTemplate), uid: position, key: ['star'],
      content: position === 0 ? 'Position 0 {{maxPrompt}}/{{maxContext}}/{{maxResponse}} {{getglobalvar::budgetFixture}}' : 'Position ' + position,
      position, depth: 2, role: 2, outletName: '__proto__',
    }])) };
    await wi.saveWorldInfo('fixtureworld-a', promptBook, true);
    const { extension_settings } = await import('/plugin-runtime/settings.js');
    const globals = (extension_settings.variables ??= {}).global ??= {};
    globals.budgetFixture = 'live';
    let activated = null, events = 0;
    const listener = entries => { events++; activated = entries; };
    script.eventSource.on(script.event_types.WORLD_INFO_ACTIVATED, listener);
    const dry = await wi.getWorldInfoPrompt(['star'], 4096, true, {});
    const { oai_settings } = await import('/plugin-runtime/openai-settings.js');
    const budgetText = `Position 0 ${4096 - oai_settings.openai_max_tokens}/4096/${oai_settings.openai_max_tokens} live`;
    check(events === 0 && dry.worldInfoBefore === budgetText && dry.worldInfoAfter === 'Position 1', 'Dry run prompt positions and model budget macros');
    delete globals.budgetFixture;
    const sourceBefore = oai_settings.chat_completion_source;
    const openRouterBefore = oai_settings.openrouter_model;
    try {
      oai_settings.chat_completion_source = 'openrouter';
      oai_settings.openrouter_model = 'OR_Website';
      check((await wi.getWorldInfoPrompt(['star'], 4096, true, {})).worldInfoAfter === 'Position 1',
        'A provider with no concrete selected model must use the service model fallback');
    } finally {
      oai_settings.chat_completion_source = sourceBefore;
      oai_settings.openrouter_model = openRouterBefore;
    }
    check(dry.worldInfoDepth[0].depth === 2 && dry.worldInfoDepth[0].role === 2 && dry.worldInfoDepth[0].entries[0] === 'Position 4', 'Depth prompt shape');
    check(dry.anBefore[0] === 'Position 2' && dry.anAfter[0] === 'Position 3' && dry.worldInfoExamples[1].position === 1 && dry.outletEntries.__proto__[0] === 'Position 7', 'Example/AN/outlet return shapes');
    await wi.getWorldInfoPrompt(['star'], 4096, false, {});
    script.eventSource.removeListener(script.event_types.WORLD_INFO_ACTIVATED, listener);
    check(events === 1 && activated.length === 8 && activated[4].world === 'fixtureworld-a', 'Activation event must contain original entry identity and content');
    check((await wi.getWorldInfoPrompt(['unrelated'], 4096, true, {})).worldInfoString === '', 'No match must produce no prompt');
    stages.push('real-scanner-prompt-shapes-dry-run-and-activation-events');

    [...document.querySelectorAll('nav button')].find(button => button.querySelector('span')?.textContent === '角色库').click();
    await wait(() => document.getElementById('world_button'));
    document.getElementById('world_button').click();
    await wait(() => !document.querySelector('.world-info-dock').hidden);
    internal.selectWorldInfoEditor('fixtureworld-a');
    await wait(() => document.querySelectorAll('.world-info-dock fieldset').length === 8);
    const text = document.querySelector('.world-info-dock fieldset textarea[rows="4"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(text, 'Edited in the actual React worldbook editor');
    text.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(() => [...document.querySelectorAll('.world-info-dock button')].some(button => button.textContent === '保存世界书' && !button.disabled));
    [...document.querySelectorAll('.world-info-dock button')].find(button => button.textContent === '保存世界书').click();
    await wait(async () => (await read('fixtureworld-a')).entries[0].content === 'Edited in the actual React worldbook editor');
    check(document.getElementById('world_editor_select').selectedOptions[0].textContent === 'fixtureworld-a', 'User-facing editor selector uses shared list');
    document.querySelector('.world-info-dock header button').click();
    stages.push('actual-react-worldbook-editor-writes-to-shared-storage');
    await script.saveSettings(); await internal.flushWorldInfoWrites();
    return { passed: true, stages };
  } finally { window.fetch = originalFetch; }
}

export async function verifyPluginWorldInfo(window) {
  const report = await window.webContents.executeJavaScript('(' + browserWorldInfoChecks.toString() + ')().catch(error => { throw new Error(error.stack || String(error)); })');
  await window.webContents.executeJavaScript(`(async () => {
    document.getElementById('world_button').click();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
  await writeFile(fileURLToPath(new URL('../../../.cache/world-info-editor.png', import.meta.url)), (await window.capturePage()).toPNG());
  window.reload();
  const end = Date.now() + 10000;
  let reloaded;
  while (Date.now() < end) {
    try {
      reloaded = await window.webContents.executeJavaScript(`(async () => {
        const wi = await import('/scripts/world-info.js');
        return { selected: wi.selected_world_info, depth: wi.getWorldInfoSettings().world_info_depth,
          content: (await wi.loadWorldInfo('fixtureworld-a'))?.entries[0]?.content };
      })()`);
      if (reloaded?.content) break;
    } catch { /* Navigation briefly invalidates the old execution context. */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.deepEqual(reloaded, { selected: ['fixtureworld-a'], depth: 3, content: 'Edited in the actual React worldbook editor' });
  await window.webContents.executeJavaScript(`(async () => {
    const wi = await import('/scripts/world-info.js'); await wi.deleteWorldInfo('fixtureworld-a');
    wi.updateWorldInfoSettings({ world_info_depth: 2, world_info_include_names: true }, []);
    await (await import('/script.js')).saveSettings();
  })()`);
  report.stages.push('full-document-reload-preserves-worldbooks-and-settings');
  return report;
}
