import assert from 'node:assert/strict';

export async function verifyPluginMessageRendering(window, service, conversationId) {
  window.setSize(1280, 900);
  const stages = [];
  const evaluate = code => window.webContents.executeJavaScript(code);
  const read = async () => (await service.inject({ method: 'GET', url: '/api/conversations/' + conversationId })).json();
  const result = await evaluate(`(async () => {
    const core = await import('/script.js');
    window.fixtureOriginalRenderedMessage = structuredClone(core.chat[0]);
    core.chat[0].mes = '**Rendered Markdown**\\n\\n| a | b |\\n|---|---|\\n| 1 | 2 |\\n\\n' + '\x60\x60\x60html\\n<span>literal</span>\\n\x60\x60\x60';
    core.chat[0].extra ||= {}; delete core.chat[0].extra.display_text;
    await core.saveChatConditional();
    const body = document.querySelector('#chat > .mes[mesid="0"] .mes_text');
    return { same: body.innerHTML === core.messageFormatting(core.chat[0].mes, core.chat[0].name, core.chat[0].is_system, core.chat[0].is_user, 0),
      strong: body.querySelector('strong')?.textContent, cells: body.querySelectorAll('td').length,
      code: body.querySelector('code')?.textContent, unsafe: Boolean(body.querySelector('code span')) };
  })()`);
  assert.deepEqual(result, { same: true, strong: 'Rendered Markdown', cells: 2, code: '<span>literal</span>\n', unsafe: false });
  const rawText = (await read()).messages[0].content;
  assert(rawText.startsWith('**Rendered Markdown**'));
  stages.push('application-and-extension-share-real-markdown-rendering');

  const refreshed = await evaluate(`(async () => {
    const core = await import('/script.js');
    const message = { ...core.chat[0], extra: { display_text: '<em>Transient display</em><img src="data:," onerror="window.fixtureUnsafe = true">' } };
    core.updateMessageBlock(0, message);
    const body = document.querySelector('#chat > .mes[mesid="0"] .mes_text');
    window.fixtureRenderedBody = body;
    const before = body.innerHTML;
    core.updateMessageBlock(0, { ...message, mes: 'Should not replace' }, { rerenderMessage: false });
    return { text: body.querySelector('em')?.textContent, preserved: before === body.innerHTML, safe: !body.querySelector('[onerror]'), raw: core.chat[0].mes };
  })()`);
  assert.deepEqual(refreshed, { text: 'Transient display', preserved: true, safe: true, raw: rawText });
  assert.equal((await read()).messages[0].content, rawText);
  stages.push('updateMessageBlock-renders-display-text-without-saving-or-mutating-chat');

  await evaluate(`$('#send_textarea').val('Retained draft.').trigger('input')`);
  // A React input update must leave extension-owned DOM children in place.
  await new Promise(done => setTimeout(done, 30));
  assert(await evaluate(`fixtureRenderedBody === document.querySelector('#chat > .mes[mesid="0"] .mes_text') && fixtureRenderedBody.querySelector('em').textContent === 'Transient display' && !window.fixtureUnsafe`));
  stages.push('unrelated-react-commit-preserves-extension-rendered-content');

  await evaluate(`(async () => {
    const core = await import('/script.js'); core.chat[0].extra.display_text = '**Persisted display**';
    await core.saveChatConditional(); await core.reloadCurrentChat();
  })()`);
  const stored = (await read()).messages[0];
  assert.equal(stored.content, rawText);
  assert.equal(stored.extensionData.extra.display_text, '**Persisted display**');
  assert.equal(await evaluate(`document.querySelector('#chat > .mes[mesid="0"] .mes_text strong')?.textContent`), 'Persisted display');
  stages.push('display-text-persists-and-reloads-without-rewriting-model-text');

  const scrolled = await evaluate(`(async () => {
    const core = await import('/script.js');
    const block = document.createElement('div'); block.style.height = '4000px'; fixtureRenderedBody.append(block);
    await core.scrollChatToBottom({ waitForFrame: true });
    const chat = document.getElementById('chat');
    const result = { scroll: chat.scrollTop, max: chat.scrollHeight - chat.clientHeight,
      connected: fixtureRenderedBody.isConnected, current: fixtureRenderedBody === chat.querySelector('.mes_text'),
      height: chat.clientHeight, display: getComputedStyle(chat).display, blockHeight: block.getBoundingClientRect().height };
    block.remove();
    for (const key of Object.keys(core.chat[0])) delete core.chat[0][key];
    Object.assign(core.chat[0], fixtureOriginalRenderedMessage); await core.saveChatConditional();
    return result;
  })()`);
  assert(scrolled.max > 0, JSON.stringify(scrolled)); assert(Math.abs(scrolled.scroll - scrolled.max) <= 1, JSON.stringify(scrolled));
  stages.push('scroll-helper-controls-the-visible-conversation');

  window.setSize(800, 700);
  const compact = await evaluate(`(async () => {
    const core = await import('/script.js');
    const block = document.createElement('div'); block.style.height = '4000px';
    document.querySelector('#chat .mes_text').append(block);
    await core.scrollChatToBottom({ waitForFrame: true });
    const last = [...document.querySelectorAll('#chat > .mes')].at(-1).getBoundingClientRect();
    const result = { visible: last.bottom <= innerHeight + 1 && last.bottom > 0, moved: document.scrollingElement.scrollTop > 0 };
    block.remove(); return result;
  })()`);
  assert.deepEqual(compact, { visible: true, moved: true });
  window.setSize(1280, 900);
  stages.push('scroll-helper-handles-compact-window-document-scroll');
  return { stages };
}
