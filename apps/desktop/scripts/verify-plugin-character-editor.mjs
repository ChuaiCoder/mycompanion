import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Exercises the mounted React editor and SQLite through public browser contracts.
async function browserEditorChecks() {
  const core = await import('/script.js'), editor = await import('/plugin-runtime/character-editor.js');
  const world = await import('/scripts/world-info.js');
  const stages = [], check = (ok, message) => { if (!ok) throw new Error(message); };
  const wait = async predicate => { const end = Date.now() + 6500; while (!await predicate()) { if (Date.now() > end) throw new Error('Character editor wait timed out'); await new Promise(resolve => setTimeout(resolve, 15)); } };
  const originalFetch = window.fetch;
  const post = (path, body) => originalFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const read = avatar => post('/api/characters/get', { avatar_url: avatar }).then(response => response.json());
  const create = async name => {
    const data = new FormData(); data.set('ch_name', name); data.set('first_mes', 'Hello {{user}}');
    data.set('extensions', JSON.stringify({ tavern_helper: { variables: { keep: 1, remove: 2 }, scripts: [] }, unrelated: { keep: true } }));
    const response = await originalFetch('/api/characters/create', { method: 'POST', body: data });
    check(response.ok, 'Create editor fixture'); return response.text();
  };
  const avatar = await create('Editor fixture A'), other = await create('Editor fixture B');
  await core.getCharacters();
  const index = name => core.characters.findIndex(character => character.avatar === name);
  const change = (name, value) => $('#form_create [name="' + name + '"]').val(value).trigger('input');
  const form = document.querySelector('#form_create'), field = name => form.elements.namedItem(name);
  const selected = () => core.characters[core.this_chid]?.avatar;
  const select = async name => { await core.selectCharacterById(index(name)); await wait(() => selected() === name && field('avatar_url').value === name); };
  await wait(() => [...document.querySelectorAll('.character-row')].some(button => button.textContent.includes('Editor fixture A')));
  [...document.querySelectorAll('.character-row')].find(button => button.textContent.includes('Editor fixture A')).click();
  await wait(() => document.querySelector('#character-detail-title')?.textContent === 'Editor fixture A');
  [...document.querySelectorAll('button')].find(button => button.textContent === '编辑角色').click();
  await wait(() => !form.closest('aside').hidden && field('avatar_url').value === avatar);
  check(new FormData(form).get('ch_name') === 'Editor fixture A' && !form.querySelector('fieldset').disabled, 'Real editor fields are enabled');
  check($('.open_alternate_greetings').data('chid') === String(index(avatar)), 'Helper alternate greeting identity');
  const id = core.characters[index(avatar)].id, conversationId = core.getCurrentChatId();
  check(conversationId, 'Selecting actual editor opens a persisted story');
  stages.push('library-edit-button-opens-real-shared-form-and-story');

  const editedEvents = [];
  const listener = event => editedEvents.push({ id: event.detail.id, avatar: event.detail.character.avatar });
  core.eventSource.on(core.event_types.CHARACTER_EDITED, listener);
  try {
    change('ch_name', 'Editor fixture renamed'); change('description', 'EDITOR_REAL_PROMPT_SETTING'); change('tags', 'one, two');
    $('#create_button').trigger('click'); await editor.flushCharacterSaves();
    await wait(() => editedEvents.length === 1);
    const stored = await read(avatar);
    check(stored.name === 'Editor fixture renamed' && stored.description === 'EDITOR_REAL_PROMPT_SETTING' && stored.data.tags.join('|') === 'one|two', 'Form save updates actual card and split tags');
    check(editedEvents[0].avatar === avatar && core.name2 === stored.name, 'Edited event and active name use saved character');
    const exported = await originalFetch('/api/characters/' + id + '/export?format=json').then(response => response.json());
    check(exported.data.description === stored.description, 'Actual exported card reflects editor changes');
    const prompt = await post('/api/conversations/' + conversationId + '/prompt-preview', { draft: 'Hello' }).then(response => response.json());
    check(JSON.stringify(prompt).includes('EDITOR_REAL_PROMPT_SETTING'), 'Generation prompt uses edited character');
    stages.push('jquery-submit-persists-name-tags-prompt-export-and-edited-event');

    form.querySelector('[data-add-greeting]').click(); change('alternate_greetings', 'Alternate A');
    await editor.saveCharacter();
    check((await read(avatar)).data.alternate_greetings.join('|') === 'Alternate A', 'Visible alternate greeting is saved');
    form.querySelector('#alternate-greetings-list button').click(); await editor.saveCharacter();
    check((await read(avatar)).data.alternate_greetings.length === 0, 'Removing last greeting preserves an explicit empty list');
    core.characters[core.this_chid].data.alternate_greetings = ['Changed through shared character'];
    change('personality', 'An unrelated form field');
    core.saveCharacterDebounced(); await core.saveCharacterDebounced.flush();
    check((await read(avatar)).data.alternate_greetings[0] === 'Changed through shared character', 'Debounced save uses the shared greeting array without reverting it on unrelated input');
    core.characters[core.this_chid].data.alternate_greetings = []; await editor.saveCharacter();
    check((await read(avatar)).data.alternate_greetings.length === 0, 'Shared-array clearing overrides a stale raw JSON snapshot');
    stages.push('visible-alternate-greeting-add-remove-and-empty-array');

    await world.createNewWorldInfo('editor-bound-book');
    await world.saveWorldInfo('editor-bound-book', { entries: { 1: { uid: 1, key: ['star'], content: 'EDITOR_BOUND_WORLD', constant: true, position: 1 } } }, true);
    $('.character_world_info_selector').val(String(world.world_names.indexOf('editor-bound-book'))).trigger('change');
    // Same form/DOM sequence used by the helper, independently written fixture.
    const helperSave = async () => {
      $('#rm_info_avatar').html('');
      const data = new FormData(form); data.delete('alternate_greetings');
      const chid = $('.open_alternate_greetings').data('chid');
      for (const text of core.characters[chid].data.alternate_greetings) data.append('alternate_greetings', text);
      const response = await originalFetch('/api/characters/edit', { method: 'POST', body: data });
      check(response.ok, 'Helper FormData save'); await core.getOneCharacter(data.get('avatar_url'));
      $('#add_avatar_button').replaceWith($('#add_avatar_button').val('').clone(true));
    };
    await helperSave();
    check((await read(avatar)).data.character_book.entries[0].content === 'EDITOR_BOUND_WORLD' && document.querySelector('#avatar_load_preview'), 'Binding and helper DOM clearing preserve preview');
    $('.character_world_info_selector').val('').trigger('change'); await helperSave();
    check(!(await read(avatar)).data.character_book && field('world').value === '', 'Helper unbind removes previous embedded snapshot');
    stages.push('helper-formdata-world-binding-unbinding-and-avatar-dom-sequence');

    let release, enter;
    let gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { enter = resolve; });
    let intercepted = false;
    window.fetch = async (path, options) => {
      if (path === '/api/characters/edit' && !intercepted) { intercepted = true; enter(); await gate; }
      return originalFetch(path, options);
    };
    change('description', 'Queued first'); const first = editor.saveCharacter(); await started;
    change('description', 'Queued second'); const second = editor.saveCharacter();
    change('scenario', 'Unsubmitted while saving'); release(); await Promise.all([first, second]);
    check((await read(avatar)).description === 'Queued second', 'Same-avatar saves preserve call order');
    check(field('scenario').value === 'Unsubmitted while saving' && (await read(avatar)).data.scenario === '', 'Refresh preserves new draft without silently persisting it');
    window.fetch = originalFetch; await editor.saveCharacter();
    stages.push('ordered-save-snapshots-preserve-edits-made-during-network-write');

    let nested = false;
    core.eventSource.once(core.event_types.CHARACTER_EDITED, async () => {
      await editor.flushCharacterSaves(); change('personality', 'Reentrant save'); await editor.saveCharacter(); nested = true;
    });
    await editor.saveCharacter();
    check(nested && (await read(avatar)).data.personality === 'Reentrant save', 'Event listeners can await flush and another save');
    stages.push('character-edited-listener-can-await-reentrant-save-without-deadlock');

    window.fetch = (path, options) => path === '/api/characters/edit' ? Promise.resolve(new Response('fixture-save-error', { status: 503 })) : originalFetch(path, options);
    change('description', 'Retry me'); $('#create_button').trigger('click');
    await wait(() => form.querySelector('[data-character-error]').textContent.includes('503'));
    check(field('description').value === 'Retry me' && (await read(avatar)).description === 'Queued second', 'Failure exposes error and preserves draft');
    let rejected = false; try { await editor.flushCharacterSaves(); } catch { rejected = true; }
    check(rejected, 'Failed write must not be reported as flushed');
    window.fetch = originalFetch; await editor.saveCharacter();
    check((await read(avatar)).description === 'Retry me' && !form.querySelector('[data-character-error]').textContent, 'Successful retry clears visible error');
    stages.push('503-error-visible-draft-retained-and-explicit-retry-succeeds');

    window.fetch = (path, options) => path === '/api/characters/edit' ? Promise.resolve(new Response('temporary role failure', { status: 503 })) : originalFetch(path, options);
    change('description', 'Retried before switching');
    await editor.saveCharacter().then(() => { throw new Error('Expected failed write'); }, () => {});
    window.fetch = originalFetch;
    await select(other);
    check((await read(avatar)).description === 'Retried before switching', 'Recovered service allows selection to retry failed source role');
    await select(avatar);

    gate = new Promise(resolve => { release = resolve; }); started = new Promise(resolve => { enter = resolve; });
    let writes = 0;
    window.fetch = async (path, options) => {
      if (path === '/api/characters/edit') {
        if (++writes === 1) return new Response('superseded failure', { status: 503 });
        if (writes === 2) { enter(); await gate; }
      }
      return originalFetch(path, options);
    };
    change('description', 'Obsolete failed snapshot'); const obsolete = editor.saveCharacter().catch(() => {});
    change('description', 'Newer queued snapshot'); const newer = editor.saveCharacter();
    await obsolete; await started;
    const switching = core.selectCharacterById(index(other)); release(); await Promise.all([newer, switching]);
    window.fetch = originalFetch;
    check(writes === 2 && (await read(avatar)).description === 'Newer queued snapshot', 'Selection must not retry an obsolete failed snapshot after a newer queued save');
    await select(avatar);
    stages.push('selection-retries-failed-source-role-without-stranding-editor');

    change('description', 'Debounced original role'); core.saveCharacterDebounced();
    await select(other);
    check((await read(avatar)).description === 'Debounced original role' && (await read(other)).description === '', 'Switch flushes debounce into captured avatar');
    stages.push('debounced-save-followed-by-selection-keeps-original-avatar');

    change('description', 'Unsaved role B draft');
    const data = new DataTransfer(), png = await originalFetch('/characters/' + encodeURIComponent(other)).then(response => response.blob());
    data.items.add(new File([png], 'fixture.png', { type: 'image/png' })); field('avatar').files = data.files;
    $(field('avatar')).trigger('change');
    await select(avatar); await select(other);
    check(field('description').value === 'Unsaved role B draft' && field('avatar').files[0]?.name === 'fixture.png', 'Per-role drafts include PNG upload after selection');
    await editor.saveCharacter();
    check((await read(other)).description === 'Unsaved role B draft' && field('avatar').files.length === 0, 'Saved upload is cleared');
    stages.push('unsaved-per-role-text-and-png-upload-survive-roundtrip-selection');

    // Same-role calls must not reset the menu or replace ongoing chat changes.
    form.closest('aside').querySelector('header button').click();
    const input = document.querySelector('#send_textarea');
    if (input) { $(input).val('selection draft').trigger('input'); }
    const story = core.getCurrentChatId();
    await core.selectCharacterById(index(other), { switchMenu: false });
    check(form.closest('aside').hidden && story === core.getCurrentChatId(), 'switchMenu false keeps editor closed and same story');
    await core.selectCharacterById(-1);
    check(selected() === other, 'Invalid selection is ignored');
    stages.push('same-role-selection-preserves-menu-story-and-ignores-invalid-index');

    const otherId = core.characters[index(other)].id;
    gate = new Promise(resolve => { release = resolve; }); started = new Promise(resolve => { enter = resolve; }); intercepted = false;
    window.fetch = async (path, options) => {
      const response = await originalFetch(path, options);
      if (path === '/api/characters/' + otherId && !intercepted) { intercepted = true; enter(); await gate; }
      return response;
    };
    const refresh = core.selectCharacterById(index(other), { switchMenu: false }); await started;
    core.chat[0].mes = 'Chat edited while selecting'; await core.saveChatConditional();
    release(); await refresh; window.fetch = originalFetch;
    check(core.chat[0].mes === 'Chat edited while selecting' && document.querySelector('#chat .mes_text').textContent.includes('Chat edited while selecting'), 'Slow same-role selection must not revert chat edit');
    stages.push('delayed-same-role-selection-preserves-newer-chat-and-dom');

    gate = new Promise(resolve => { release = resolve; }); started = new Promise(resolve => { enter = resolve; }); intercepted = false;
    window.fetch = async (path, options) => {
      const response = await originalFetch(path, options);
      if (path === '/api/characters/' + id && !intercepted) { intercepted = true; enter(); await gate; }
      return response;
    };
    const olderSelection = core.selectCharacterById(index(avatar)); await started;
    [...document.querySelectorAll('.character-row')].find(button => button.textContent.includes('Editor fixture B')).click();
    await wait(() => document.querySelector('#character-detail-title')?.textContent === 'Editor fixture B');
    release(); await olderSelection; window.fetch = originalFetch;
    check(document.querySelector('#character-detail-title')?.textContent === 'Editor fixture B' && selected() === other, 'Newer actual library choice supersedes delayed extension navigation');
    stages.push('actual-user-navigation-supersedes-delayed-extension-selection');
    await select(avatar); change('description', 'Editor persisted after reload'); await editor.saveCharacter();
  } finally { window.fetch = originalFetch; core.eventSource.removeListener(core.event_types.CHARACTER_EDITED, listener); }
  return { stages, avatar, id, conversationId };
}

export async function verifyPluginCharacterEditor(window) {
  const report = await window.webContents.executeJavaScript(`(${browserEditorChecks.toString()})()`);
  window.setSize(1280, 900);
  window.webContents.invalidate();
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await writeFile(fileURLToPath(new URL('../../../.cache/character-editor.png', import.meta.url)), (await window.capturePage()).toPNG());
  window.reload();
  const end = Date.now() + 10000;
  let restored;
  while (Date.now() < end) {
    try {
      restored = await window.webContents.executeJavaScript(`(async () => {
        const core = await import('/script.js'); const form = document.querySelector('#form_create');
        return { avatar: core.characters[core.this_chid]?.avatar, field: form?.elements.namedItem('description')?.value,
          description: core.characters[core.this_chid]?.data.description, story: core.getCurrentChatId() };
      })()`);
      if (restored?.avatar === report.avatar && restored.field === 'Editor persisted after reload') break;
    } catch { /* Navigation is still loading. */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.deepEqual(restored, { avatar: report.avatar, field: 'Editor persisted after reload', description: 'Editor persisted after reload', story: report.conversationId });
  report.stages.push('document-reload-hydrates-real-editor-and-preserves-original-story');
  return report;
}
