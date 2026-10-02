import assert from 'node:assert/strict';

async function browserDeleteChecks() {
  const core = await import('/script.js'), editor = await import('/plugin-runtime/character-editor.js');
  const stages = [], check = (ok, message) => { if (!ok) throw new Error(message); };
  const originalFetch = window.fetch;
  const post = (path, body) => originalFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const create = async name => { const response = await post('/api/characters/create', { ch_name: name, first_mes: 'Deletion fixture greeting' }); check(response.ok, 'Create deletion fixture'); return response.text(); };
  const readBackup = () => originalFetch('/api/backup').then(response => response.json());
  const avatars = await Promise.all(['Delete kept', 'Delete failure', 'Delete delayed', 'Delete survivor'].map(create));
  await core.getCharacters();
  const index = avatar => core.characters.findIndex(character => character.avatar === avatar);
  const select = avatar => core.selectCharacterById(index(avatar));
  const events = [], deleted = event => events.push({ type: 'character', id: event.id, avatar: event.character.avatar }), chatDeleted = id => events.push({ type: 'chat', id });
  core.eventSource.on(core.event_types.CHARACTER_DELETED, deleted); core.eventSource.on(core.event_types.CHAT_DELETED, chatDeleted);
  const array = core.characters;
  let retainedStory, originalId, defaultStory;
  try {
    await select(avatars[0]); retainedStory = core.getCurrentChatId(); originalId = core.characters[core.this_chid].id;
    core.chat[0].mes = 'Retained visible history'; core.chat[0].variables = { score: 7 }; core.chat_metadata.variables = { chapter: 4 };
    await core.saveChatConditional();
    $('#form_create [name="description"]').val('Flush before removal').trigger('input'); core.saveCharacterDebounced();
    const oldIndex = index(avatars[0]);
    check(await core.deleteCharacter(avatars[0], { deleteChats: false }), 'Keep-chat deletion should succeed');
    check(core.characters === array && index(avatars[0]) < 0 && core.this_chid === undefined && !core.getCurrentChatId(), 'Deletion updates canonical list and current story');
    check(document.querySelectorAll('#chat .mes').length === 0 && document.querySelector('#form_create fieldset').disabled, 'Deletion clears actual chat/editor');
    check(![...document.querySelectorAll('.character-row')].some(button => button.textContent.includes('Delete kept')), 'Actual sidebar removes role');
    check(events.length === 1 && events[0].id === oldIndex && events[0].avatar === avatars[0], 'Kept chats emit only correct character deletion payload');
    const archive = (await readBackup()).retainedCharacterChats.find(item => item.avatar === avatars[0]);
    check(archive.conversations[0].id === retainedStory && archive.conversations[0].chatMetadata.variables.chapter === 4, 'Retained state reaches backup storage');
    await editor.flushCharacterSaves();
    check((await post('/api/characters/get', { avatar_url: avatars[0] })).status === 404, 'Flushed debounce cannot resurrect deleted role');
    stages.push('keep-chat-deletion-flushes-saves-clears-real-ui-and-emits-character-event');

    await select(avatars[2]); defaultStory = core.getCurrentChatId();
    let release, enter, intercepted = false;
    const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { enter = resolve; });
    window.fetch = async (path, options) => {
      const response = await originalFetch(path, options);
      if (path === '/api/characters/get' && JSON.parse(options.body).avatar_url === avatars[2] && !intercepted) { intercepted = true; enter(); await gate; }
      return response;
    };
    const older = core.getOneCharacter(avatars[2]); await started;
    check(await core.deleteCharacter(avatars[2]), 'Default deletion removes chats');
    release(); await older; window.fetch = originalFetch;
    check(index(avatars[2]) < 0 && (await originalFetch('/api/conversations/' + defaultStory)).status === 404, 'Delayed read cannot restore permanently deleted character');
    check(events.some(event => event.type === 'chat' && event.id === defaultStory), 'Default deletion emits actual chat file ID');
    check(!(await readBackup()).retainedCharacterChats.some(item => item.avatar === avatars[2]), 'Default delete leaves no retained archive');
    stages.push('default-delete-removes-chat-and-invalidates-older-single-read');

    await select(avatars[1]);
    window.fetch = (path, options) => path === '/api/characters/delete' ? Promise.resolve(new Response('fixture delete failure', { status: 503 })) : originalFetch(path, options);
    check(!await core.deleteCharacter(avatars[1]), 'Failed deletion returns false');
    check(core.characters[core.this_chid].avatar === avatars[1] && (await post('/api/characters/get', { avatar_url: avatars[1] })).ok, 'Failed deletion preserves card and current chat');
    check(!events.some(event => event.avatar === avatars[1]) && document.querySelector('.toast-error')?.textContent.includes('503'), 'Failure is visible and does not emit false deletion');
    window.fetch = originalFetch;
    stages.push('http-failure-preserves-role-chat-and-surfaces-error-without-false-event');

    const batchAvatar = await create('Delete batch success'); await core.getCharacters();
    let listRelease, listEnter, listIntercepted = false;
    const listGate = new Promise(resolve => { listRelease = resolve; }), listStarted = new Promise(resolve => { listEnter = resolve; });
    window.fetch = async (path, options) => {
      if (path === '/api/characters/delete' && JSON.parse(options.body).avatar_url === avatars[1]) return new Response('batch failure', { status: 503 });
      const response = await originalFetch(path, options);
      if (path === '/api/characters/all' && !listIntercepted) { listIntercepted = true; listEnter(); await listGate; }
      return response;
    };
    const olderList = core.getCharacters(); await listStarted;
    check(await core.deleteCharacter(['missing-fixture.png', avatars[1], batchAvatar]), 'Batch reports at least one deletion');
    listRelease(); await olderList; window.fetch = originalFetch;
    check(index(avatars[1]) >= 0 && index(batchAvatar) < 0 && !events.some(event => event.avatar === avatars[1]), 'Batch retains failed role and late list cannot revive success');
    stages.push('mixed-batch-skips-missing-preserves-failed-and-invalidates-old-list');

    let selectedFromListener = false;
    core.eventSource.once(core.event_types.CHARACTER_DELETED, async () => { await select(avatars[3]); selectedFromListener = true; });
    check(await core.deleteCharacter(avatars[1]), 'Retry deletion');
    check(selectedFromListener && core.characters[core.this_chid].avatar === avatars[3], 'Deletion listener can await actual selection without deadlock');
    check(!await core.deleteCharacter('missing-fixture.png'), 'Missing character returns false');
    stages.push('deletion-event-listener-can-select-survivor-and-retry-clears-failure');
    const direct = await create('Delete direct API'); await core.getCharacters(); await select(direct);
    check((await post('/api/characters/delete', { avatar_url: direct, delete_chats: true })).ok, 'Direct API deletion succeeds');
    await core.getCharacters();
    check(!core.getCurrentChatId() && !document.querySelector('#chat .mes'), 'Refreshing after direct API deletion clears the deleted active story');
    await select(avatars[3]);
    stages.push('direct-api-delete-and-refresh-clear-dangling-active-conversation');
    return { stages, keptAvatar: avatars[0], removedAvatars: [avatars[1], avatars[2], batchAvatar], survivor: avatars[3], retainedStory, originalId, defaultStory };
  } finally { window.fetch = originalFetch; core.eventSource.removeListener(core.event_types.CHARACTER_DELETED, deleted); core.eventSource.removeListener(core.event_types.CHAT_DELETED, chatDeleted); }
}

async function browserRecreateChecks(report) {
  const core = await import('/script.js');
  const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (report.removedAvatars.some(avatar => core.characters.some(character => character.avatar === avatar))) throw new Error('Deleted characters reappeared after reload');
  const response = await post('/api/characters/create', { ch_name: 'Recreated kept role', file_name: report.keptAvatar, first_mes: 'New role greeting' });
  const avatar = await response.text();
  if (!response.ok || avatar !== report.keptAvatar) throw new Error('Deleted avatar was not released for recreation');
  await core.getCharacters();
  await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar));
  const backup = await fetch('/api/backup').then(response => response.json());
  return { avatar, id: core.characters[core.this_chid].id, story: core.getCurrentChatId(), message: core.chat[0].mes,
    variables: core.chat[0].variables, metadata: core.chat_metadata.variables,
    visible: document.querySelector('#chat .mes_text').textContent, archived: backup.retainedCharacterChats.some(item => item.avatar === avatar) };
}

export async function verifyPluginCharacterDeletion(window) {
  const report = await window.webContents.executeJavaScript(`(${browserDeleteChecks.toString()})()`);
  window.reload();
  const end = Date.now() + 10000;
  let ready = false;
  while (!ready && Date.now() < end) {
    try { ready = await window.webContents.executeJavaScript(`(async () => {
      const core = await import('/script.js'); return core.characters[core.this_chid]?.avatar === ${JSON.stringify(report.survivor)} && !document.querySelector('#form_create fieldset').disabled;
    })()`); } catch { /* Navigation is still loading. */ }
    if (!ready) await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert(ready, 'Survivor selection did not reload');
  const recreated = await window.webContents.executeJavaScript(`(${browserRecreateChecks.toString()})(${JSON.stringify(report)})`);
  assert.notEqual(recreated.id, report.originalId);
  assert.deepEqual({ ...recreated, id: undefined }, { id: undefined, avatar: report.keptAvatar, story: report.retainedStory, message: 'Retained visible history', variables: { score: 7 }, metadata: { chapter: 4 }, visible: 'Retained visible history', archived: false });
  report.stages.push('reload-and-same-avatar-recreation-reattach-retained-chat-to-new-real-role');
  return report;
}
