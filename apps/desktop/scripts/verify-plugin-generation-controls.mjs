import assert from 'node:assert/strict';
import { createServer } from 'node:http';

export async function verifyPluginGenerationControls(window, service) {
  const stages = [], requests = [], closed = [];
  const model = createServer(async (request, response) => {
    let input = ''; for await (const part of request) input += part;
    const body = JSON.parse(input);
    if (!body.stream) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: '[]' } }] })); return; }
    requests.push(body); const index = requests.length;
    response.on('close', () => closed.push(index));
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (JSON.stringify(body.messages).includes('GENERATE_API_TURN')) {
      response.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Generate API reply' } }] }) + '\n\ndata: [DONE]\n\n');
      return;
    }
    response.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Partial cancellable reply' } }] }) + '\n\n');
    // Deliberately held until the real application cancels the provider request.
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const evaluate = async source => {
    const result = await window.webContents.executeJavaScript(`(async () => { try { return { value: await (0, eval)(${JSON.stringify(source)}) }; } catch (error) { return { error: error.stack || String(error) }; } })()`);
    if (result.error) throw new Error(result.error + '\nBrowser expression: ' + source);
    return result.value;
  };
  const wait = async predicate => { const end = Date.now() + 10000; while (!await predicate()) { if (Date.now() > end) throw new Error('Generation controls wait timed out'); await new Promise(resolve => setTimeout(resolve, 20)); } };
  try {
    const provider = await service.inject({ method: 'PUT', url: '/api/settings/provider', payload: { kind: 'ollama', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: 'controls-fixture', maxTokens: 200 } });
    assert.equal(provider.statusCode, 200);
    const story = await evaluate(`(async () => {
      const core = await import('/script.js'); window.controlCore = core;
      const response = await fetch('/api/characters/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ch_name: 'Generation control fixture', first_mes: 'Opening' }) });
      if (!response.ok) throw new Error('Create control fixture'); const avatar = await response.text();
      await core.getCharacters(); await core.selectCharacterById(core.characters.findIndex(item => item.avatar === avatar));
      window.controlEvents = []; window.controlStopped = (...args) => controlEvents.push(['stopped', ...args]); window.controlEnded = (...args) => controlEvents.push(['ended', ...args]);
      window.controlStates = []; window.stopControlTrace = (await import('/plugin-runtime/compat-runtime.js')).subscribeHostContext(c => controlStates.push({ native: c.nativeGenerating, busy: c.generationControlsBusy }));
      core.eventSource.on(core.event_types.GENERATION_STOPPED, controlStopped); core.eventSource.on(core.event_types.GENERATION_ENDED, controlEnded);
      return core.getCurrentChatId();
    })()`);
    const read = async () => (await service.inject({ method: 'GET', url: '/api/conversations/' + story })).json();
    const before = (await read()).messages;
    const blocked = await evaluate(`(() => { controlCore.deactivateSendButtons(); controlCore.setGenerationProgress(37.5); return {
      stop: getComputedStyle(document.querySelector('#mes_stop')).display !== 'none', send: getComputedStyle(document.querySelector('#send_but')).display !== 'none', disabled: document.querySelector('#send_textarea').disabled,
      busy: document.body.dataset.generating, native: controlCore.is_send_press, progress: document.querySelector('#send_textarea').style.background,
    }; })()`);
    assert.equal(blocked.stop, true); assert.equal(blocked.send, false); assert.equal(blocked.disabled, false, 'Extension busy state still permits composing a draft');
    assert.equal(blocked.busy, 'true'); assert.equal(blocked.native, false); assert.match(blocked.progress, /37.5%/);
    assert.deepEqual((await read()).messages, before);
    await evaluate(`(() => { $('#send_textarea').val('Draft during extension generation').trigger('input'); document.getElementById('send_form').requestSubmit(); })()`);
    assert.equal(await evaluate(`document.getElementById('send_textarea').value`), 'Draft during extension generation');
    assert.equal(requests.length, 0, 'Visible stop state does not submit a second generation');
    stages.push('extension-busy-and-progress-update-real-controls-without-faking-native-generation');

    await evaluate(`(() => {
      window.controlAbort = new AbortController();
      window.controlStopNode = document.getElementById('mes_stop');
      $(document).on('click.control-fixture', '#mes_stop', () => { controlCore.stopGeneration(); controlAbort.abort(); controlCore.showSwipeButtons(); controlCore.setGenerationProgress(0); });
      document.getElementById('mes_stop').click();
    })()`);
    await wait(() => evaluate(`getComputedStyle(document.querySelector('#send_but')).display !== 'none' && controlAbort.signal.aborted`));
    assert.equal(await evaluate(`controlStopNode === document.getElementById('mes_stop') && controlStopNode.type === 'button'`), true, 'Stop must remain a stable non-submit element during event dispatch');
    assert.equal(await evaluate(`document.body.dataset.generating ?? null`), null);
    assert.equal(await evaluate(`document.querySelector('#send_textarea').style.background`), '');
    assert.equal(await evaluate(`controlEvents.filter(item => item[0] === 'ended').length`), 1, JSON.stringify(await evaluate(`({ events: controlEvents, states: controlStates })`)));
    await evaluate(`controlCore.activateSendButtons(); void $(document).off('.control-fixture');`);
    assert.equal(await evaluate(`controlEvents.filter(item => item[0] === 'ended').length`), 1);
    assert.deepEqual((await read()).messages, before);
    assert.equal(requests.length, 0, 'Cancelling an extension must not submit the retained draft');
    stages.push('actual-stop-button-runs-delegated-extension-cancellation-and-ends-once');

    for (const mode of ['api', 'button']) {
      await evaluate(`(() => { $('#send_textarea').val('Cancel via ${mode}').trigger('input'); $('#send_but').trigger('click'); })()`);
      await wait(() => evaluate(`controlCore.is_send_press && controlCore.chat.at(-1)?.status === 'streaming' && controlCore.chat.at(-1)?.mes.includes('Partial cancellable reply')`));
      const count = requests.length;
      assert.equal(count, mode === 'api' ? 1 : 2);
      if (mode === 'api') {
        await evaluate(`controlCore.deactivateSendButtons(); controlCore.activateSendButtons();`);
        assert.equal(await evaluate(`getComputedStyle(document.getElementById('mes_stop')).display !== 'none' && controlCore.is_send_press`), true, 'Extension release cannot release a still-active native request');
        assert.equal(await evaluate(`controlCore.stopGeneration()`), true);
      } else await evaluate(`document.getElementById('mes_stop').click()`);
      await wait(() => closed.includes(count));
      await wait(async () => (await read()).messages.at(-1)?.status === 'stopped');
      await wait(() => evaluate(`!controlCore.is_send_press && getComputedStyle(document.getElementById('send_but')).display !== 'none' && controlCore.chat.at(-1)?.status === 'stopped'`));
      assert.equal((await read()).messages.at(-1).content, 'Partial cancellable reply');
      assert.equal(await evaluate(`controlCore.stopGeneration()`), false, 'Idle stop reports no native request');
      stages.push(mode === 'api' ? 'programmatic-stop-aborts-real-provider-and-preserves-partial-sqlite-message' : 'visible-stop-button-cancels-real-native-request-and-restores-send-controls');
    }
    const idle = await evaluate(`(() => { const count = controlEvents.filter(item => item[0] === 'stopped').length; const result = controlCore.stopGeneration(); return { result, delta: controlEvents.filter(item => item[0] === 'stopped').length - count }; })()`);
    assert.deepEqual(idle, { result: false, delta: 1 });
    stages.push('idle-stop-keeps-tavern-boolean-and-notifies-extension-listeners');
    const generated = await evaluate(`(async () => { $('#send_textarea').val('GENERATE_API_TURN').trigger('input'); return controlCore.Generate('normal'); })()`);
    assert.equal(generated, 'Generate API reply');
    assert.equal(await evaluate(`controlCore.main_api`), 'openai');
    assert.equal(await evaluate(`(async () => controlCore.online_status !== 'no_connection' && (await import('/scripts/extensions.js')).connectedToApi)()`), true);
    assert.equal((await read()).messages.at(-1).content, 'Generate API reply');
    assert.equal((await read()).messages.at(-1).status, 'complete');
    stages.push('tavern-generate-normal-uses-real-react-composer-and-saved-sse-turn');
    const regenerated = await evaluate(`controlCore.Generate('regenerate')`);
    assert.equal(regenerated, 'Generate API reply');
    assert.equal((await read()).messages.at(-1).status, 'complete');
    stages.push('tavern-generate-regenerate-uses-real-branch-generation');
    window.reload();
    await wait(async () => {
      try { return await evaluate(`(async () => {
        const core = await import('/script.js');
        return core.getCurrentChatId() === ${JSON.stringify(story)} && core.chat.at(-1)?.status === 'complete'
          && !core.is_send_press && !document.body.dataset.generating && document.getElementById('send_but')
          && getComputedStyle(document.getElementById('send_but')).display !== 'none' && document.getElementById('send_textarea').style.background === '';
      })()`); } catch { return false; }
    });
    stages.push('document-reload-restores-idle-controls-and-persisted-generated-messages');
    return { stages, story, requests: requests.length, providerConnectionsClosed: closed.length };
  } finally {
    await evaluate(`(() => { window.stopControlTrace?.(); $(document).off('.control-fixture'); if (window.controlCore) { controlCore.eventSource.removeListener(controlCore.event_types.GENERATION_STOPPED, window.controlStopped); controlCore.eventSource.removeListener(controlCore.event_types.GENERATION_ENDED, window.controlEnded); controlCore.activateSendButtons(); controlCore.setGenerationProgress(0); } })()`).catch(() => {});
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  }
}
