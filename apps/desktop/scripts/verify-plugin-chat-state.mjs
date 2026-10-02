import assert from 'node:assert/strict';

export async function verifyPluginChatState(window, service, conversationId) {
  const stages = [];
  const evaluate = code => window.webContents.executeJavaScript(code);
  const wait = async expression => {
    const end = Date.now() + 10000;
    while (!await evaluate(expression)) {
      if (Date.now() > end) throw new Error('Chat persistence wait timed out: ' + expression);
      await new Promise(done => setTimeout(done, 20));
    }
  };
  const read = async id => (await service.inject({ method: 'GET', url: '/api/conversations/' + id })).json();
  const initial = await read(conversationId);
  const firstMessageId = initial.messages[0].id;
  await evaluate(`(async () => {
    const core = await import('/script.js'); window.fixtureChatIdentity = core.chat; window.fixtureMetadataIdentity = core.chat_metadata;
    core.chat[0].mes = 'Extension persisted text.';
    core.chat[0].name = 'Extension speaker';
    core.chat[0].variables = [{ score: 11, nested: [false, null] }, { alternate: true }];
    core.chat[0].swipes = ['Extension persisted text.', 'Alternative text']; core.chat[0].swipe_id = 0;
    core.chat[0].extra = { future: { kept: true } };
    core.chat_metadata.variables = { score: 42 };
    await core.saveMetadata();
  })()`);
  let persisted = await read(conversationId);
  assert.equal(persisted.messages[0].content, 'Extension persisted text.');
  assert.deepEqual(persisted.chatMetadata, { ...initial.chatMetadata, variables: { score: 42 } });
  assert.deepEqual(persisted.messages[0].extensionData.variables, [{ score: 11, nested: [false, null] }, { alternate: true }]);
  assert.equal(await evaluate(`document.querySelector('#chat .mes_text').textContent`), 'Extension persisted text.');
  assert.equal(await evaluate(`document.querySelector('#chat .ch_name').textContent`), 'Extension speaker');
  assert(await evaluate(`SillyTavern.getContext().chat === fixtureChatIdentity && SillyTavern.getContext().chatMetadata === fixtureMetadataIdentity`));
  stages.push('saveMetadata-persists-real-message-fields-metadata-and-rendered-text');

  const sequences = await evaluate(`(async () => {
    const core = await import('/script.js');
    core.chat_metadata.fixtureSaveSequence = 1;
    const first = core.saveChatConditional();
    if (!core.isChatSaving) throw new Error('isChatSaving did not reflect the queued write');
    core.chat_metadata.fixtureSaveSequence = 2;
    core.chat[0].variables[0].score = 12;
    await first;
    const afterFirst = { local: core.chat_metadata.fixtureSaveSequence, score: core.chat[0].variables[0].score,
      stored: (await fetch('/api/conversations/' + SillyTavern.getContext().conversationId).then(r => r.json())).chatMetadata.fixtureSaveSequence };
    await core.saveChatConditional();
    return { afterFirst, busy: core.isChatSaving };
  })()`);
  assert.deepEqual(sequences, { afterFirst: { local: 2, score: 12, stored: 1 }, busy: false });
  persisted = await read(conversationId);
  assert.equal(persisted.chatMetadata.fixtureSaveSequence, 2);
  assert.equal(persisted.messages[0].extensionData.variables[0].score, 12);
  stages.push('slow-save-response-preserves-newer-unsaved-mutations-and-next-save');

  const failure = await evaluate(`(async () => {
    const core = await import('/script.js'); core.chat_metadata.fixtureFailure = true;
    try { await core.saveChatConditional(); return { rejected: false }; }
    catch (error) { return { rejected: true, message: error.message, busy: core.isChatSaving }; }
  })()`);
  assert.deepEqual(failure, { rejected: true, message: 'fixture-chat-save-failure', busy: false });
  assert.equal((await read(conversationId)).chatMetadata.fixtureFailure, undefined);
  await evaluate(`(async () => { const core = await import('/script.js'); delete core.chat_metadata.fixtureFailure; core.chat_metadata.recovered = true; await core.saveChatConditional(); })()`);
  assert.equal((await read(conversationId)).chatMetadata.recovered, true);
  stages.push('failed-save-rejects-without-writing-and-queue-recovers');

  await evaluate(`(async () => {
    const core = await import('/script.js');
    core.chat.push({ mes: 'Added through extension context.', is_user: true, name: 'Extension user', variables: [{ added: true }] });
    await core.saveChatConditional();
  })()`);
  persisted = await read(conversationId);
  const addedId = persisted.messages.at(-1).id;
  assert.equal(persisted.messages.at(-1).content, 'Added through extension context.');
  assert(await evaluate(`document.querySelector('[data-message-id="${addedId}"] .mes_text').textContent === 'Added through extension context.'`));
  await evaluate(`(async () => {
    const core = await import('/script.js'); core.chat.reverse();
    await core.saveChatConditional();
    core.chat.splice(core.chat.findIndex(message => message.id === ${JSON.stringify(addedId)}), 1);
    await core.saveChatConditional();
  })()`);
  persisted = await read(conversationId);
  assert.equal(persisted.messages.length, initial.messages.length);
  assert(!persisted.messages.some(message => message.id === addedId));
  assert.equal(persisted.messages.at(-1).id, firstMessageId);
  stages.push('context-append-reorder-delete-reaches-real-dom-and-database');

  const other = (await service.inject({ method: 'POST', url: '/api/conversations', payload: { characterId: initial.characterId } })).json();
  await evaluate(`(async () => { const extensions = await import('/scripts/extensions.js'); SillyTavern.getContext().chatMetadata.switchMarker = 'belongs-to-first'; extensions.saveMetadataDebounced(); })()`);
  await evaluate(`[...document.querySelectorAll('nav button')].find(button => button.querySelector('span')?.textContent === '插件').click()`);
  await evaluate(`[...document.querySelectorAll('nav button')].find(button => button.querySelector('span')?.textContent === '故事').click()`);
  await wait(`Boolean(document.querySelector('[data-conversation-id="${other.id}"]'))`);
  await evaluate(`document.querySelector('[data-conversation-id="${other.id}"]').click()`);
  await wait(`SillyTavern.getContext().conversationId === ${JSON.stringify(other.id)}`);
  await evaluate(`import('/plugin-runtime/chat.js').then(api => api.flushChatSaves())`);
  assert.equal((await read(conversationId)).chatMetadata.switchMarker, 'belongs-to-first');
  assert.deepEqual((await read(other.id)).chatMetadata, {});
  assert(await evaluate(`SillyTavern.getContext().chatMetadata === fixtureMetadataIdentity && Object.keys(fixtureMetadataIdentity).length === 0`));
  stages.push('debounced-save-keeps-original-story-target-after-navigation');

  await evaluate(`document.querySelector('[data-conversation-id="${conversationId}"]').click()`);
  await wait(`SillyTavern.getContext().conversationId === ${JSON.stringify(conversationId)}`);
  const reloaded = await evaluate(`(async () => {
    const core = await import('/script.js');
    core.chat[0].mes = 'Discard unsaved mutation'; core.chat_metadata.unsaved = true;
    let changed = 0; const listener = () => changed++;
    core.eventSource.on(core.event_types.CHAT_CHANGED, listener);
    await core.reloadCurrentChat(); core.eventSource.off(core.event_types.CHAT_CHANGED, listener);
    return { changed, text: core.chat[0].mes, metadata: core.chat_metadata, rendered: document.querySelector('#chat .mes_text').textContent };
  })()`);
  assert.equal(reloaded.changed, 1); assert.equal(reloaded.metadata.unsaved, undefined);
  assert.equal(reloaded.text, (await read(conversationId)).messages[0].content);
  assert.equal(reloaded.rendered, reloaded.text);
  stages.push('reloadCurrentChat-reads-database-and-notifies-after-render');
  return { stages };
}
