import assert from 'node:assert/strict';

async function browserSurfaceChecks() {
  const core = await import('/script.js'), persistence = await import('/plugin-runtime/chat.js');
  const host = await import('/plugin-runtime/desktop-host.js');
  const runtime = await import('/plugin-runtime/compat-runtime.js');
  const stages = [], events = [], check = (ok, message) => { if (!ok) throw new Error(message); };
  const response = await fetch('/api/characters/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ch_name: 'Message surface fixture', first_mes: 'Surface **greeting**' }) });
  const avatar = await response.text(); check(response.ok, 'Create surface fixture'); await core.getCharacters();
  await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar));
  const story = core.getCurrentChatId(), chat = core.chat;
  core.chat.push({ id: crypto.randomUUID(), mes: 'Second message', is_user: true, name: 'User', extra: {} });
  await core.saveChatConditional();
  const read = () => fetch('/api/conversations/' + story).then(response => response.json());
  const preview = async () => {
    const response = await fetch('/api/conversations/' + story + '/prompt-preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: 'Surface preview', extensionPrompts: await host.prepareExtensionPrompts() }) });
    check(response.ok, 'Prompt preview succeeds'); return JSON.stringify(await response.json());
  };
  runtime.setOwnedPrompt('success', 'surface-clear', 'surface-clear-prompt-unique-marker');
  await host.flush();
  check((await preview()).includes('surface-clear-prompt-unique-marker'), 'Dynamic prompt reaches actual prompt builder before clear');
  const listener = (...args) => events.push(args);
  for (const name of ['CHAT_CHANGED', 'MESSAGE_RECEIVED', 'MESSAGE_SENT', 'USER_MESSAGE_RENDERED', 'CHARACTER_MESSAGE_RENDERED']) core.eventSource.on(core.event_types[name], listener);
  try {
    core.chat_metadata.unsavedSurfaceMetadata = true; persistence.saveMetadataDebounced();
    const original = JSON.stringify(chat), snapshot = await read();
    await core.clearChat(); await persistence.flushChatSaves();
    check(core.chat === chat && JSON.stringify(chat) === original && document.getElementById('chat').children.length === 0, 'Default clear removes visible nodes but retains canonical chat');
    check((await read()).chatMetadata.unsavedSurfaceMetadata === undefined, 'Clear cancels pending metadata writes');
    check(events.length === 0, 'Display clear must not emit received/rendered/change events');
    await host.flush();
    check(!(await preview()).includes('surface-clear-prompt-unique-marker'), 'Clear removes dynamic prompts from actual model input');
    stages.push('clear-only-removes-real-dom-keeps-chat-and-cancels-debounced-write');
    await core.printMessages();
    check(document.querySelectorAll('#chat > .mes').length === 2 && document.querySelector('#chat .mes_text strong').textContent === 'greeting', 'Print recreates actual formatted message rows');
    const old = document.querySelector('#chat > .mes'); await core.printMessages();
    check(!old.isConnected && document.querySelectorAll('#chat > .mes').length === 2 && events.length === 0, 'Repeated print replaces rows without duplicating messages or events');
    check(JSON.stringify((await read()).messages) === JSON.stringify(snapshot.messages), 'Pure redraw must not change SQLite');
    stages.push('print-rebuilds-visible-markdown-without-duplicates-events-or-database-write');

    const temporary = core.addOneMessage({ mes: '**Transient**', name: 'Transient author', is_user: false, is_system: true, extra: {} }, { scroll: false, forceId: 50 });
    check(temporary.jquery && temporary.length === 1 && temporary[0].parentNode === document.getElementById('chat'), 'Add returns jQuery around the real displayed row');
    check(temporary.attr('mesid') === '50' && temporary.attr('is_system') === 'true' && temporary.find('.name_text').text() === 'Transient author' && temporary.find('strong').last().text() === 'Transient', 'Message identity, role, name and Markdown');
    check(core.chat.length === 2 && (await read()).messages.length === 2 && events.length === 0, 'Add does not push/save/emit on behalf of its caller');
    await core.printMessages();
    stages.push('addOneMessage-returns-real-jquery-row-without-implicit-chat-mutation');

    const inserted = { mes: 'Inserted middle', is_user: false, name: 'Middle', extra: {} };
    chat.splice(1, 0, inserted);
    const middle = core.addOneMessage(inserted, { insertBefore: 1, forceId: 1, scroll: false });
    $('#chat > .mes[mesid="1"]').last().attr('mesid', '2');
    check([...document.querySelectorAll('#chat > .mes .mes_text')].map(node => node.textContent).join('|').includes('greeting|Inserted middle|Second message'), 'insertBefore preserves explicit DOM order');
    let clicks = 0; middle.on('surface-fixture', () => clicks++); middle.data('fixture', 17);
    inserted.mes = 'Swiped middle';
    const swiped = core.addOneMessage(inserted, { type: 'swipe', forceId: 1, scroll: false });
    swiped.trigger('surface-fixture');
    check(swiped[0] === middle[0] && swiped.data('fixture') === 17 && clicks === 1 && swiped.find('.mes_text').text() === 'Swiped middle', 'Swipe redraw keeps wrapper and listeners');
    check(inserted.swipe_id === 0 && inserted.swipes[0] === 'Swiped middle', 'Swipe defaults are stored in caller-owned message');
    await core.saveChatConditional();
    check((await read()).messages[1].content === 'Swiped middle' && document.querySelectorAll('#chat > .mes').length === 3, 'Explicit save persists caller splice and reconciles existing display rows');
    stages.push('helper-style-middle-insertion-and-swipe-redraw-preserve-dom-listeners');

    events.length = 0;
    $('#chat > .mes').first().remove(); chat.shift(); await core.saveChatConditional();
    check(document.querySelectorAll('#chat > .mes').length === 2 && document.querySelector('#chat > .mes .mes_text').textContent === 'Swiped middle', 'Direct extension removal and save must not corrupt React reconciliation');
    chat.reverse(); await core.saveChatConditional();
    check([...document.querySelectorAll('#chat > .mes .mes_text')].map(node => node.textContent).join('|') === 'Second message|Swiped middle', 'Persisted reordering reuses actual message nodes in new order');
    $('#chat').empty(); await core.printMessages();
    check(document.querySelectorAll('#chat > .mes').length === 2, 'Direct jQuery empty can be followed by normal redraw');
    stages.push('external-remove-empty-and-persisted-reorder-remain-react-compatible');

    const afterMessage = { mes: 'After zero', is_user: true, extra: {} };
    const after = core.addOneMessage(afterMessage, { insertAfter: 0, scroll: false });
    check(after.attr('mesid') === '1' && after[0].previousElementSibling.getAttribute('mesid') === '0', 'insertAfter computes default index');
    check(document.querySelectorAll('#chat > .last_mes').length === 1, 'Exactly one visible last message marker');
    await core.printMessages();
    const detached = core.addOneMessage({ mes: 'Missing anchor', is_user: false, extra: {} }, { insertBefore: 999, scroll: false });
    check(!detached[0].isConnected && detached.attr('mesid') === '998', 'Missing insertion anchor returns detached row, matching Tavern');
    await core.printMessages();
    stages.push('insertion-index-fallbacks-last-message-marker-and-missing-anchor');

    const beforeClear = await read(); events.length = 0;
    await core.clearChat({ clearData: true });
    check(chat.length === 0 && core.chat === chat && core.chat_metadata.unsavedSurfaceMetadata === true, 'clearData empties existing array but retains chat metadata');
    check((await read()).messages.length === beforeClear.messages.length && events.length === 0, 'clearData remains unsaved until caller saves');
    await core.printMessages(); await core.saveChatConditional();
    check((await read()).messages.length === 0 && !document.querySelector('#chat > .mes'), 'Explicit save persists data clear and actual DOM stays empty');
    stages.push('clearData-retains-array-identity-metadata-and-requires-explicit-save');
  } finally {
    for (const name of ['CHAT_CHANGED', 'MESSAGE_RECEIVED', 'MESSAGE_SENT', 'USER_MESSAGE_RENDERED', 'CHARACTER_MESSAGE_RENDERED']) core.eventSource.removeListener(core.event_types[name], listener);
  }
  return { stages, story, avatar };
}

export async function verifyPluginMessageSurface(window) {
  const report = await window.webContents.executeJavaScript(`(${browserSurfaceChecks.toString()})()`);
  window.reload(); const end = Date.now() + 10000;
  let result;
  while (Date.now() < end) {
    try {
      result = await window.webContents.executeJavaScript(`(async () => { const core = await import('/script.js'); return { story: core.getCurrentChatId(), messages: core.chat.length, visible: document.querySelectorAll('#chat > .mes').length, metadata: core.chat_metadata.unsavedSurfaceMetadata }; })()`);
      if (result?.story === report.story && result.metadata === true) break;
    } catch { /* Navigation. */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.deepEqual(result, { story: report.story, messages: 0, visible: 0, metadata: true });
  report.stages.push('whole-document-reload-preserves-explicitly-cleared-chat-and-metadata');
  return report;
}
