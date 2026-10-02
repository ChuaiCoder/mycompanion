import assert from 'node:assert/strict';

async function browserCharacterChecks() {
  const core = await import('/script.js');
  const stages = [], check = (value, message) => { if (!value) throw new Error(message); };
  const wait = async predicate => { const end = Date.now() + 6000; while (!await predicate()) { if (Date.now() > end) throw new Error('Character UI wait timed out'); await new Promise(done => setTimeout(done, 15)); } };
  const originalFetch = window.fetch;
  const post = (path, fields) => originalFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) });
  const form = async (action, fields) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.append(key, value);
    const response = await originalFetch('/api/characters/' + action, { method: 'POST', body: data });
    check(response.ok, 'Character ' + action + ': ' + await response.clone().text());
    return response.text();
  };
  const avatar = await form('create', { ch_name: 'Character API fixture', description: 'Original setting', first_mes: 'Character fixture opening', extensions: JSON.stringify({ tavern_helper: { scripts: [], variables: { stored: 1 } }, other: { keep: true } }) });
  const otherAvatar = await form('create', { ch_name: 'Other character fixture', description: 'Another setting' });
  await core.getCharacters();
  const array = core.characters, character = array.find(item => item.avatar === avatar), id = character.id;
  check(character.data.description === 'Original setting' && character.data.extensions.tavern_helper.variables.stored === 1, 'Original card data must be hydrated before helper access');
  check(SillyTavern.getContext().characters === array && (await import('/plugin-runtime/script.js')).characters === array, 'Canonical array shared by all aliases');
  await core.unshallowCharacter(String(array.indexOf(character)));
  check(array.find(item => item.avatar === avatar) === character, 'Full record identity survives reads');
  stages.push('real-multipart-create-and-canonical-full-character-state');

  await wait(() => [...document.querySelectorAll('.character-row')].some(button => button.textContent.includes('Character API fixture')));
  [...document.querySelectorAll('.character-row')].find(button => button.textContent.includes('Character API fixture')).click();
  await wait(() => document.querySelector('#character-detail-title')?.textContent === 'Character API fixture');
  document.querySelector('.start-chat-button').click();
  await wait(() => document.querySelector('#chat .mes_text')?.textContent === 'Character fixture opening');
  await wait(() => core.characters[core.this_chid]?.id === id);
  check(typeof core.this_chid === 'number' && SillyTavern.getContext().characterId === core.this_chid && SillyTavern.getContext().characterUuid === id, 'Tavern numeric index must resolve the selected SQL UUID');
  stages.push('actual-library-selection-chat-and-numeric-current-index');

  const chats = await core.getPastCharacterChats(core.this_chid);
  check(chats.length === 1 && chats[0].file_name === core.getCurrentChatId() + '.jsonl', 'Real story must be listed');
  const rows = await post('/api/chats/get', { avatar_url: avatar, file_name: core.getCurrentChatId() }).then(response => response.json());
  check(rows[1].mes === 'Character fixture opening' && rows[0].character_name === 'Character API fixture', 'Read actual saved chat and header');
  const image = await originalFetch(core.getThumbnailUrl('avatar', avatar));
  check(image.ok && image.headers.get('Content-Type').includes('image/png'), 'Avatar must serve an actual image');
  check((await post('/api/chats/get', { avatar_url: otherAvatar, file_name: core.getCurrentChatId() })).status === 404, 'Character-scoped chat read');
  stages.push('persisted-chat-history-header-and-real-avatar-endpoint');

  character.data.extensions.tavern_helper.variables.unsaved = 7;
  const storedExtensions = (await post('/api/characters/get', { avatar_url: avatar }).then(response => response.json())).data.extensions;
  storedExtensions.tavern_helper.variables = { stored: 9, remote: true };
  await form('edit', { avatar_url: avatar, ch_name: 'Renamed character fixture', description: 'Persisted new setting', extensions: JSON.stringify(storedExtensions) });
  await core.getOneCharacter(avatar);
  check(core.characters === array && array.find(item => item.avatar === avatar) === character, 'Refresh must retain array and record identity');
  check(character.data.extensions.tavern_helper.variables.unsaved === 7 && character.data.extensions.tavern_helper.variables.stored === 9 && character.data.extensions.tavern_helper.variables.remote, 'Field merge must preserve local unsaved changes while accepting stored changes');
  check(character.data.extensions.other.keep && core.name2 === 'Renamed character fixture', 'Unrelated extensions and live name');
  await wait(() => [...document.querySelectorAll('.character-row')].some(button => button.textContent.includes('Renamed character fixture')));
  const persisted = await post('/api/characters/get', { avatar_url: avatar }).then(response => response.json());
  check(persisted.data.extensions.tavern_helper.variables.unsaved === undefined, 'Refresh must not silently persist local edits');
  stages.push('refresh-preserves-unsaved-fields-and-updates-real-sidebar-and-name');

  try {
    let release, enter, intercepted = false;
    const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { enter = resolve; });
    window.fetch = async (path, options) => {
      const response = await originalFetch(path, options);
      if (path === '/api/characters/all' && !intercepted) { intercepted = true; enter(); await gate; }
      return response;
    };
    const olderList = core.getCharacters(); await started;
    await form('edit', { avatar_url: avatar, description: 'Newer single read' });
    await core.getOneCharacter(avatar); release(); await olderList;
    check(character.data.description === 'Newer single read', 'Delayed old list must not overwrite a newer single read');
    window.fetch = originalFetch;
    stages.push('delayed-list-response-cannot-revert-newer-character');

    intercepted = false;
    const singleGate = new Promise(resolve => { release = resolve; }), singleStarted = new Promise(resolve => { enter = resolve; });
    window.fetch = async (path, options) => {
      const response = await originalFetch(path, options);
      if (path === '/api/characters/get' && !intercepted) { intercepted = true; enter(); await singleGate; }
      return response;
    };
    const older = core.getOneCharacter(avatar); await singleStarted;
    await form('edit', { avatar_url: avatar, description: 'Final persisted setting' });
    await core.getOneCharacter(avatar); release(); await older;
    check(character.data.description === 'Final persisted setting', 'Old single read must not overwrite newer response');
    window.fetch = originalFetch;
    stages.push('out-of-order-single-character-reads-preserve-newest-result');

    intercepted = false;
    const beforeListGate = new Promise(resolve => { release = resolve; }), beforeListStarted = new Promise(resolve => { enter = resolve; });
    window.fetch = async (path, options) => {
      const response = await originalFetch(path, options);
      if (path === '/api/characters/get' && !intercepted) { intercepted = true; enter(); await beforeListGate; }
      return response;
    };
    const beforeList = core.getOneCharacter(avatar); await beforeListStarted;
    await form('edit', { avatar_url: avatar, description: 'Newest list setting' });
    await core.getCharacters(); release(); await beforeList;
    check(character.data.description === 'Newest list setting', 'An older single read must not revert the newer list');
    window.fetch = originalFetch;
    stages.push('newer-list-also-invalidates-older-single-character-response');

    window.fetch = (path, options) => path === '/api/characters/get' ? Promise.resolve(new Response('fixture failure', { status: 503 })) : originalFetch(path, options);
    let rejected = false; try { await core.getOneCharacter(avatar); } catch (error) { rejected = /503/.test(error.message); }
    check(rejected && character.data.description === 'Newest list setting', 'Failed refresh must reject without erasing state');
    window.fetch = originalFetch; await core.getOneCharacter(avatar);
    await core.printCharacters(true);
    stages.push('failed-refresh-rejects-preserves-state-and-recovers');
  } finally { window.fetch = originalFetch; }
  return { stages, avatar, id };
}

export async function verifyPluginCharacters(window) {
  const report = await window.webContents.executeJavaScript(`(${browserCharacterChecks.toString()})()`);
  window.reload();
  const end = Date.now() + 10000;
  let restored;
  while (Date.now() < end) {
    try {
      restored = await window.webContents.executeJavaScript(`(async () => {
        const script = await import('/script.js');
        const character = script.characters.find(item => item.avatar === ${JSON.stringify(report.avatar)});
        return character && { id: character.id, description: character.data.description, variables: character.data.extensions.tavern_helper.variables,
          selected: script.characters[script.this_chid]?.avatar };
      })()`);
      if (restored?.selected === report.avatar) break;
    } catch { /* The main document is navigating. */ }
    await new Promise(done => setTimeout(done, 25));
  }
  assert.deepEqual(restored, { id: report.id, description: 'Newest list setting', variables: { stored: 9, remote: true }, selected: report.avatar });
  report.stages.push('document-reload-rehydrates-persisted-character-and-selection');
  return report;
}
