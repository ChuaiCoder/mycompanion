import assert from 'node:assert/strict';

async function checks() {
  const core = await import('/script.js'), editor = await import('/plugin-runtime/character-editor.js');
  const stages = [], events = [], check = (ok, text) => { if (!ok) throw new Error(text); };
  const originalFetch = window.fetch;
  const post = (path, body) => originalFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const created = await post('/api/characters/create', { ch_name: 'Greeting fixture', first_mes: 'Original greeting' });
  check(created.ok, 'Create greeting fixture'); const avatar = await created.text();
  await core.getCharacters(); await core.selectCharacterById(core.characters.findIndex(item => item.avatar === avatar));
  const story = core.getCurrentChatId(), chat = core.chat;
  const read = () => originalFetch('/api/conversations/' + story).then(response => response.json());
  const change = value => $('#form_create [name="first_mes"]').val(value).trigger('input');
  const handlers = ['CHARACTER_EDITED', 'MESSAGE_RECEIVED', 'CHARACTER_MESSAGE_RENDERED'].map(name => {
    const listener = (...args) => events.push({ name, args, visible: document.querySelector('#chat .mes_text')?.textContent });
    core.eventSource.on(core.event_types[name], listener); return [name, listener];
  });
  const reset = async messages => {
    core.chat.splice(0, core.chat.length, ...messages); core.chat_metadata.tainted = false;
    await core.saveChatConditional(); events.length = 0;
  };
  const ordinary = mes => ({ id: crypto.randomUUID(), mes, is_user: false, is_system: false, name: 'Greeting fixture', extra: {} });
  try {
    change('Updated **{{char}}**'); await editor.saveCharacter();
    check(core.chat === chat && chat.length === 1 && chat[0].mes === 'Updated **{{char}}**', 'Rebuild retains canonical array and source macros');
    check(events.map(item => item.name).join('|') === 'CHARACTER_EDITED|MESSAGE_RECEIVED|CHARACTER_MESSAGE_RENDERED', 'First-message event order: ' + JSON.stringify(events));
    check(events[1].args.join('|') === '0|first_message' && events[1].visible.includes('Original greeting') && events[2].visible.includes('Updated Greeting fixture'), 'Received precedes redraw and rendered follows real Markdown/macro display');
    check((await read()).messages[0].content === chat[0].mes, 'Rebuild persists in actual SQLite');
    stages.push('saved-character-rebuilds-pristine-greeting-with-real-events-dom-and-storage');

    change(''); core.characters[core.this_chid].data.alternate_greetings = ['First alternate', 'Second alternate'];
    await editor.saveCharacter();
    check(chat[0].mes === 'First alternate' && chat[0].swipe_id === 0 && chat[0].swipes.join('|') === 'First alternate|Second alternate' && chat[0].swipe_info.length === 2, 'Empty main greeting selects first alternate and stores swipe data');
    const persisted = (await read()).messages[0];
    check(persisted.extensionData.swipes[1] === 'Second alternate', 'Alternate swipe metadata reaches SQLite');
    change(''); core.characters[core.this_chid].data.alternate_greetings = []; const previous = JSON.stringify(chat);
    await editor.saveCharacter(); check(JSON.stringify(chat) === previous, 'Empty greeting must not replace existing content');
    stages.push('alternate-first-fallback-swipe-metadata-and-empty-greeting-noop');

    for (const mode of ['tainted', 'user', 'system', 'multiple']) {
      const message = ordinary('Protected ' + mode);
      if (mode === 'user') message.is_user = true;
      if (mode === 'system') message.is_system = true;
      await reset(mode === 'multiple' ? [message, ordinary('Another')] : [message]);
      if (mode === 'tainted') { core.chat_metadata.tainted = true; await core.saveChatConditional(); }
      const saved = JSON.stringify(chat); change('Must not replace ' + mode); await editor.saveCharacter();
      check(JSON.stringify(chat) === saved && events.every(item => item.name === 'CHARACTER_EDITED'), 'Protect ' + mode + ' history and avoid fabricated first-message events');
    }
    stages.push('tainted-user-system-and-multiple-message-histories-are-preserved');

    await reset([ordinary('Before native edit')]);
    const edit = await originalFetch('/api/conversations/' + story + '/messages/' + chat[0].id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Native user edit' }) });
    check(edit.ok, 'Native edit succeeds');
    change('Must not overwrite native edit'); await editor.saveCharacter();
    check((await read()).messages[0].content === 'Native user edit' && (await read()).chatMetadata.tainted === true, 'Server taint protects native edits even when browser metadata is stale');
    await core.reloadCurrentChat();
    stages.push('native-message-edit-taint-prevents-overwrite-with-stale-browser-metadata');

    await reset([ordinary('Before delayed preview')]);
    let release, enter; const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { enter = resolve; });
    window.fetch = async (path, options) => {
      const response = await originalFetch(path, options);
      if (path === '/api/conversations/' + story + '/greeting') { enter(); await gate; }
      return response;
    };
    change('Delayed replacement'); const saving = editor.saveCharacter(); await started;
    chat[0].mes = 'Newer extension edit'; release(); await saving; window.fetch = originalFetch;
    check(chat[0].mes === 'Newer extension edit', 'Late preview cannot overwrite newer local message content');
    await core.saveChatConditional();
    stages.push('late-greeting-preview-preserves-newer-unsaved-extension-edits');

    const otherResponse = await post('/api/characters/create', { ch_name: 'Greeting navigation target', first_mes: 'Other story greeting' });
    check(otherResponse.ok, 'Create navigation target'); const otherAvatar = await otherResponse.text(); await core.getCharacters();
    let releaseNavigation, enterNavigation;
    const navigationGate = new Promise(resolve => { releaseNavigation = resolve; }), navigationStarted = new Promise(resolve => { enterNavigation = resolve; });
    window.fetch = async (path, options) => {
      const response = await originalFetch(path, options);
      if (path === '/api/conversations/' + story + '/greeting') { enterNavigation(); await navigationGate; }
      return response;
    };
    change('Old story delayed result'); const olderSave = editor.saveCharacter(); await navigationStarted;
    await core.selectCharacterById(core.characters.findIndex(item => item.avatar === otherAvatar));
    const otherStory = core.getCurrentChatId(); releaseNavigation(); await olderSave; window.fetch = originalFetch;
    check(otherStory !== story && core.getCurrentChatId() === otherStory && chat[0].mes === 'Other story greeting', 'Late rebuild must not modify or reopen newly selected story');
    check((await read()).messages[0].content === 'Newer extension edit', 'Old story is not overwritten after selection');
    await core.selectCharacterById(core.characters.findIndex(item => item.avatar === avatar));
    stages.push('late-greeting-preview-cannot-overwrite-or-reopen-another-story');

    await reset([]);
    window.fetch = (path, options) => path === '/api/conversations/' + story + '/greeting' ? Promise.resolve(new Response('greeting unavailable', { status: 503 })) : originalFetch(path, options);
    change('Retry greeting'); let rejected = false;
    try { await editor.saveCharacter(); } catch (error) { rejected = /503/.test(String(error)); }
    check(rejected && !chat.length, 'Greeting failures reject without inventing a successful rebuild');
    window.fetch = originalFetch; await editor.saveCharacter();
    check(chat.length === 1 && chat[0].mes === 'Retry greeting' && (await read()).messages[0].content === 'Retry greeting', 'Next save rebuilds empty pristine chat after failure');
    stages.push('preview-503-rejects-and-next-save-recovers-empty-pristine-chat');
  } finally {
    window.fetch = originalFetch;
    for (const [name, listener] of handlers) core.eventSource.removeListener(core.event_types[name], listener);
  }
  return { stages, story };
}
export async function verifyPluginGreeting(window) {
  const report = await window.webContents.executeJavaScript(`(${checks.toString()})()`);
  window.reload(); const end = Date.now() + 10000; let restored;
  while (Date.now() < end) {
    try { restored = await window.webContents.executeJavaScript(`(async () => { const c = await import('/script.js'); return { story: c.getCurrentChatId(), text: c.chat[0]?.mes, visible: document.querySelector('#chat .mes_text')?.textContent }; })()`);
      if (restored?.story === report.story && restored?.text === 'Retry greeting') break;
    } catch { /* Reload. */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(restored?.story, report.story); assert.equal(restored?.text, 'Retry greeting'); assert.match(restored?.visible ?? '', /Retry greeting/);
  report.stages.push('rebuilt-first-message-survives-complete-document-reload');
  return report;
}
