import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { verifyPluginChatState } from './verify-plugin-chat-state.mjs';
import { verifyPluginMessageRendering } from './verify-plugin-message-rendering.mjs';

// Exercise project-authored extensions against the actual React chat and
// persisted model results, not a detached fixture tree or context mock.
export async function verifyPluginDom(window, service) {
  const stages = [], requests = [];
  const evaluate = code => window.webContents.executeJavaScript(code);
  const wait = async expression => {
    const end = Date.now() + 10000;
    while (!await evaluate(expression)) {
      if (Date.now() > end) throw new Error('Timed out: ' + expression);
      await new Promise(done => setTimeout(done, 25));
    }
  };
  const navigate = label => evaluate(`[...document.querySelectorAll('nav button')].find(button => button.querySelector('span')?.textContent === ${JSON.stringify(label)}).click()`);
  const clickPlugin = (id, label) => evaluate(`[...document.querySelectorAll('.code-plugin-list li')].find(item => item.querySelector('strong')?.textContent === ${JSON.stringify(id)}).querySelectorAll('button').forEach(button => { if (button.textContent === ${JSON.stringify(label)}) button.click(); })`);
  const hostReady = () => wait(`import('/plugin-runtime/desktop-host.js').then(host => host.getStatuses().success === '扩展已运行' && host.getStatuses().peer === '扩展已运行')`);
  let finishModel;
  const model = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    if (!body.stream) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: '[]' } }] })); return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders();
    finishModel = () => response.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Real model reply.' } }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(done => model.listen(0, '127.0.0.1', done));
  try {
    const character = (await service.inject({ method: 'POST', url: '/api/characters/import/commit', payload: {
      filename: 'fixture.json', card: { spec: 'chara_card_v2', spec_version: '2.0', data: {
        name: 'Fixture character', description: 'Fixture description', first_mes: 'Real opening.',
        personality: '', scenario: '', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: 'MyCompanion', character_version: '1', extensions: {},
      } },
    } })).json();
    assert(character.id, JSON.stringify(character));
    const conversation = (await service.inject({ method: 'POST', url: '/api/conversations', payload: { characterId: character.id } })).json();
    assert(conversation.id);
    const provider = await service.inject({ method: 'PUT', url: '/api/settings/provider', payload: { kind: 'ollama', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: 'fixture', maxTokens: 200 } });
    assert.equal(provider.statusCode, 200);
    await navigate('插件'); await navigate('故事');
    await wait(`Boolean(document.querySelector('[data-conversation-id="${conversation.id}"]'))`);
    await evaluate(`document.querySelector('[data-conversation-id="${conversation.id}"]').click()`);
    await wait(`document.querySelector('#chat .mes_text')?.textContent === 'Real opening.'`);
    await evaluate(`window.fixtureChat = document.getElementById('chat'); window.fixtureOpening = document.querySelector('#chat .mes_text'); $('<button id="fixture-opening">Extension opening</button>').appendTo(fixtureOpening);`);
    await navigate('插件'); await wait(`Boolean(document.querySelector('.plugin-center'))`);
    await clickPlugin('success', '设置');
    await wait(`document.querySelector('.plugin-host-dock--visible #fixture-setting') !== null`);
    await evaluate(`document.querySelector('[aria-label="关闭扩展设置"]').click()`);
    await navigate('故事');
    assert(await evaluate(`fixtureChat === document.getElementById('chat') && fixtureOpening === document.querySelector('#chat .mes_text') && document.getElementById('fixture-opening').isConnected`));
    stages.push('actual-chat-and-extension-settings-persist-across-navigation');
    await evaluate(`$('#send_textarea').val('Immediate jQuery message.').trigger('input'); $('#send_but').trigger('click');`);
    await wait(`SillyTavern.getContext().chat.some(message => message.status === 'streaming')`);
    assert.equal(await evaluate(`fixtureEvents.filter(event => event.name === 'MESSAGE_RECEIVED').length`), 0);
    assert.equal(await evaluate(`fixtureEvents.filter(event => event.name === 'MESSAGE_SENT').length`), 1);
    assert.equal(await evaluate(`document.getElementById('send_textarea').value`), '');
    await evaluate(`(async () => {
      const core = await import('/script.js');
      core.chat_metadata.savedDuringGeneration = true;
      core.chat.at(-1).variables = [{ persistedDuringGeneration: true }];
      await core.saveChatConditional();
    })()`);
    // The model response is deliberately held until the placeholder assertion.
    const modelDeadline = Date.now() + 5000;
    while (!finishModel && Date.now() < modelDeadline) await new Promise(done => setTimeout(done, 10));
    assert(finishModel);
    assert(requests.some(body => body.stream && body.messages.some(message => message.content === 'Immediate jQuery message.')));
    assert(requests.some(body => body.stream && JSON.stringify(body.messages).includes('Fixture prompt from actual extension.')));
    finishModel(); finishModel = undefined;
    await wait(`document.querySelector('.fixture-message-button') !== null && !SillyTavern.getContext().isGenerating`);
    const events = await evaluate(`fixtureEvents`);
    assert.deepEqual(events.filter(event => event.name === 'MESSAGE_RECEIVED').map(event => [event.index, event.text, event.content]), [[2, 'Real model reply.', 'Real model reply.']]);
    const afterGeneration = (await service.inject({ method: 'GET', url: '/api/conversations/' + conversation.id })).json();
    assert.equal(afterGeneration.messages.at(-1).status, 'complete');
    assert.equal(afterGeneration.chatMetadata.tainted, true, 'Real generation marks the chat as used, including during extension saves');
    assert.deepEqual(afterGeneration.messages.at(-1).extensionData.variables, [{ persistedDuringGeneration: true }]);
    assert(await evaluate(`SillyTavern.getContext().chat.at(-1).variables[0].persistedDuringGeneration === true`));
    stages.push('saving-during-generation-retains-extension-data-at-finalization');
    await evaluate(`window.fixtureRenderedButton = document.querySelector('.fixture-message-button'); $('#send_textarea').val('Retained draft.').trigger('input');`);
    await wait(`document.querySelector('#send_textarea').value === 'Retained draft.'`);
    await navigate('插件'); await navigate('故事');
    assert(await evaluate(`fixtureRenderedButton.isConnected && document.querySelector('.fixture-message-button') === fixtureRenderedButton`));
    stages.push('jquery-immediate-send-real-model-prompt-and-post-render-events', 'stream-placeholder-does-not-fire-received-or-duplicate-user-event');
    await evaluate(`document.querySelector('#chat .mes[mesid="2"] .mes_edit').click()`);
    await wait(`Boolean(document.querySelector('.edit_textarea'))`);
    await evaluate(`(() => { const editor = document.querySelector('.edit_textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(editor, 'Edited reply.'); editor.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await evaluate(`document.querySelector('.mes_edit_done').click()`);
    await wait(`fixtureEvents.some(event => event.name === 'MESSAGE_UPDATED' && event.text === 'Edited reply.')`);
    let stored = (await service.inject({ method: 'GET', url: '/api/conversations/' + conversation.id })).json();
    assert.equal(stored.messages[2].content, 'Edited reply.');
    await evaluate(`document.querySelector('#chat .mes[mesid="2"] .mes_delete').click()`);
    await wait(`fixtureEvents.some(event => event.name === 'MESSAGE_DELETED' && event.index === 2)`);
    stored = (await service.inject({ method: 'GET', url: '/api/conversations/' + conversation.id })).json();
    assert.equal(stored.messages.length, 2);
    stages.push('real-edit-delete-controls-update-dom-events-and-sqlite');
    const persistence = await verifyPluginChatState(window, service, conversation.id);
    const rendering = await verifyPluginMessageRendering(window, service, conversation.id);
    await navigate('插件'); await wait(`Boolean(document.querySelector('.plugin-center'))`);
    await evaluate(`window.fixtureDocumentToken = crypto.randomUUID()`);
    await clickPlugin('success', '停用');
    await wait(`typeof fixtureDocumentToken === 'undefined' && document.querySelector('.service-state--online') !== null`);
    await wait(`import('/plugin-runtime/desktop-host.js').then(host => host.getStatuses().peer === '扩展已运行')`);
    const disabled = await evaluate(`({ removed: !document.getElementById('fixture-setting') && !document.body.dataset.pluginSmoke && !document.querySelector('link[data-extension-id="success"]'), hook: SillyTavern.getContext().extensionSettings.disableHook, draft: document.getElementById('send_textarea').value })`);
    assert.deepEqual(disabled, { removed: true, hook: true, draft: 'Retained draft.' });
    await wait(`SillyTavern.getContext().conversationId === ${JSON.stringify(conversation.id)}`);
    assert(await evaluate(`SillyTavern.getContext().chatMetadata.variables.score === 42 && SillyTavern.getContext().chat.find(message => message.name === 'Extension speaker').variables[0].score === 12`));
    stages.push('message-variables-and-chat-metadata-survive-full-document-reload');
    stages.push('disable-hook-flush-full-reload-cleans-css-dom-and-restores-story-draft');
    await clickPlugin('success', '启用'); await wait(`Boolean(document.body.dataset.pluginSmoke)`); await hostReady();
    await wait(`Boolean(document.querySelector('.plugin-center'))`);
    await clickPlugin('dormant', '启用');
    // Wait for the new document, not the enable hook's import in the old one.
    await wait(`import('/plugin-runtime/desktop-host.js').then(host => host.getStatuses().dormant === '扩展已运行')`);
    await hostReady();
    assert(await evaluate(`SillyTavern.getContext().extensionSettings.enableHook === true`));
    assert.equal((await service.inject({ method: 'GET', url: '/api/code-plugins' })).json().items.find(item => item.id === 'dormant').enabled, true);
    stages.push('disabled-enable-hook-imports-original-module-and-persists-settings');
    await wait(`Boolean(document.querySelector('.plugin-center'))`);
    await clickPlugin('success', '卸载');
    await wait(`!document.getElementById('fixture-setting') && typeof SillyTavern !== 'undefined' && SillyTavern.getContext().extensionSettings.deleteHook === true`);
    assert.equal((await service.inject({ method: 'GET', url: '/scripts/extensions/third-party/success/dist/index.js' })).statusCode, 404);
    stages.push('delete-hook-persists-before-uninstall-and-reload');
    return { stages, persistence, rendering, receivedEvents: events, modelRequestCount: requests.length };
  } catch (error) {
    console.error(await evaluate(`({ text: document.body.innerText, events: window.fixtureEvents })`).catch(() => null));
    throw error;
  } finally { finishModel?.(); model.closeAllConnections(); await new Promise(done => model.close(done)); }
}
