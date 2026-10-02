// Actual browser behavior checks, called from our owned plugin verification profile.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function browserChecks() {
  const stages = [];
  const check = (ok, stage) => { if (!ok) throw new Error(stage); stages.push(stage); };
  const utils = await import('/scripts/utils.js');
  const libs = await import('/lib.js');
  const { extractReasoningFromData } = await import('/scripts/reasoning.js');
  check(
    extractReasoningFromData({ choices: [{ message: { reasoning_content: 'compatible', reasoning: 'router', content: 'answer' } }] }, { chatCompletionSource: 'openrouter', ignoreShowThoughts: true }) === 'router'
    && extractReasoningFromData({ responseContent: { parts: [{ thought: true, text: 'thought' }, { text: 'answer' }] } }, { chatCompletionSource: 'makersuite' }) === 'thought'
    && extractReasoningFromData({ thinking: 'local' }, { mainApi: 'textgenerationwebui', textGenType: 'ollama' }) === 'local'
    && extractReasoningFromData(null) === '',
    'provider-reasoning-extraction-from-real-served-module',
  );
  check(libs.$ === $ && $.fn.jquery === '3.7.1' && libs.lodash === _, 'real-shared-library-instances');
  const root = $('<div>').appendTo('#plugin-root');
  const child = $('<button>').text('click').appendTo(root);
  let clicks = 0;
  root.on('click.fixture', 'button', () => clicks++);
  child.data('fixture', { value: 8 }).trigger('click');
  root.off('.fixture'); child.trigger('click');
  check(clicks === 1 && child.data('fixture').value === 8 && child.parent()[0] === root[0], 'jquery-delegation-namespaces-data-dom');
  root.remove();
  const html = libs.DOMPurify.sanitize('<b>safe</b><img src=x onerror="alert(1)"><script>alert(1)</script>');
  check(html.includes('<b>safe</b>') && !/onerror|script|alert/.test(html), 'real-html-sanitization');
  const notification = toastr.info('Fixture message', 'Fixture title', { timeOut: 0, extendedTimeOut: 0 });
  check(notification.find('.toast-message').text() === 'Fixture message', 'real-toast-dom');
  toastr.remove();
  const reference = document.createElement('button'), floating = document.createElement('div');
  document.body.append(reference, floating);
  const popper = libs.Popper.createPopper(reference, floating);
  await popper.update();
  check(popper.state.elements.popper === floating && !!floating.getAttribute('data-popper-placement'), 'real-popper-positioning');
  popper.destroy(); reference.remove(); floating.remove();
  check(_.template('Hello <%= name %>')({ name: 'fixture' }) === 'Hello fixture', 'template-eval-permission');
  const inline = document.createElement('script'); inline.textContent = 'window.fixtureInline = true'; document.body.append(inline);
  check(window.fixtureInline === true, 'inline-script-permission'); inline.remove(); delete window.fixtureInline;
  const blobUrl = URL.createObjectURL(new Blob(['export const value = 42'], { type: 'text/javascript' }));
  try { check((await import(blobUrl)).value === 42, 'blob-module-permission'); } finally { URL.revokeObjectURL(blobUrl); }
  check(typeof process === 'undefined' && typeof require === 'undefined', 'electron-node-isolation-retained');

  const base64 = await utils.getBase64Async(new Blob(['hello'], { type: 'text/plain' }));
  check(base64 === 'data:text/plain;base64,aGVsbG8=' && utils.isDataURL(base64) && !utils.isDataURL('https://example.com/a'), 'blob-base64-and-data-url');
  const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg" width="3" height="2"><path fill="red" d="M0 0h3v2H0z"/></svg>'], 'fixture.svg', { type: 'image/svg+xml', lastModified: 12345 });
  const converted = await utils.ensureImageFormatSupported(svg);
  const convertedUrl = await utils.getBase64Async(converted);
  const size = await utils.getImageSizeFromDataURL(convertedUrl);
  check(converted.type === 'image/png' && converted.name === 'fixture.svg' && converted.lastModified === 12345 && size.width === 3 && size.height === 2, 'svg-conversion-to-real-png');
  check(await utils.ensureImageFormatSupported(converted) === converted, 'supported-images-keep-original-bytes');
  let rejected = false;
  try { await utils.getImageSizeFromDataURL('data:image/png;base64,bm90LWFuLWltYWdl'); } catch { rejected = true; }
  check(rejected, 'invalid-image-rejects');
  check(await utils.getSanitizedFilename('bad<>:/\\|?*name.json') === 'badname.json' && await utils.getSanitizedFilename('CON') === '', 'filename-sanitization-via-own-api');
  check(new TextEncoder().encode(await utils.getSanitizedFilename('汉'.repeat(200) + '.json')).length <= 255, 'filename-utf8-byte-limit');
  const context = SillyTavern.getContext();
  const saved = { characters: context.characters, characterId: context.characterId };
  context.characters = [{ id: 'uuid', avatar: 'my.character.png' }]; context.characterId = 'uuid';
  try {
    check(utils.getCharaFilename(0) === 'my.character' && utils.getCharaFilename() === 'my.character' && utils.getCharaFilename(50) === null && utils.getCharaFilename(null, { manualAvatarKey: 'manual.png' }) === 'manual', 'character-avatar-filename-contract');
  } finally { Object.assign(context, saved); }
  check(utils.getStringHash('hello') === 4625896200565286 && utils.getStringHash(null) === 0 && utils.getStringHash('hello', 1) !== utils.getStringHash('hello'), 'compatible-cyrb53-hash');
  let debounced = [], throttled = [];
  const owner = { marker: 7, debounce: utils.debounce(function(value) { debounced.push([this.marker, value]); }, 5), throttle: utils.throttle(function(value) { throttled.push([this.marker, value]); }, 100) };
  owner.debounce(1); owner.debounce(2); owner.throttle(1); owner.throttle(2);
  await utils.delay(20);
  check(JSON.stringify(debounced) === '[[7,2]]' && JSON.stringify(throttled) === '[[7,1]]', 'debounce-and-throttle-have-distinct-semantics');
  const stopwatch = new utils.Stopwatch(10); let ticks = 0;
  stopwatch.lastAction = Date.now(); await stopwatch.tick(() => ticks++);
  stopwatch.lastAction -= 20; await stopwatch.tick(async () => { await utils.delay(1); ticks++; });
  check(ticks === 1 && Date.now() - stopwatch.lastAction < 10, 'stopwatch-awaits-rate-limited-action');

  const choice = utils.showFontAwesomePicker([['fa-star'], ['fa-heart']]);
  const picker = document.querySelector('.mc-icon-picker');
  const search = picker.querySelector('input'); search.value = 'heart'; search.dispatchEvent(new Event('input'));
  check(picker.querySelector('[aria-label="fa-star"]').hidden && !picker.querySelector('[aria-label="fa-heart"]').hidden, 'icon-picker-filter');
  picker.querySelector('[aria-label="fa-heart"]').click();
  check(await choice === 'fa-heart' && !picker.isConnected, 'icon-picker-select-and-cleanup');
  const cancelled = utils.showFontAwesomePicker([['fa-star']]);
  document.querySelector('.mc-icon-picker').dispatchEvent(new Event('cancel', { cancelable: true }));
  check(await cancelled === null, 'icon-picker-cancel');
  const defaultChoice = utils.showFontAwesomePicker();
  for (let i = 0; !document.querySelector('.mc-icon-picker') && i < 100; i++) await utils.delay(10);
  const defaultPicker = document.querySelector('.mc-icon-picker');
  check(defaultPicker && defaultPicker.querySelectorAll('[data-search]').length > 1000, 'bundled-free-icon-catalog');
  defaultPicker.querySelector('[aria-label="fa-star"]').click();
  check(await defaultChoice === 'fa-star', 'default-icon-picker-selection');

  const { getEventSourceStream } = await import('/scripts/sse-stream.js');
  // Every byte separately splits UTF-8, BOM, CRLF and field delimiters.
  const bytes = new TextEncoder().encode('\uFEFF: comment\r\nid: initial\r\n\r\nevent: delta\r\ndata: 你好\r\ndata: second\r\n\r\nid: bad\0id\ndata: final\n\nid:\n\ndata:\n\ndata: unterminated');
  const source = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
  const events = [];
  for await (const event of source.pipeThrough(getEventSourceStream())) events.push({ type: event.type, data: event.data, id: event.lastEventId });
  check(JSON.stringify(events) === JSON.stringify([
    { type: 'delta', data: '你好\nsecond', id: 'initial' },
    { type: 'message', data: 'final', id: 'initial' },
    { type: 'message', data: '', id: '' },
  ]), 'sse-byte-boundaries-unicode-id-empty-data-and-eof');
  let cancelledReason;
  const cancellable = new ReadableStream({ pull(controller) { controller.enqueue(new TextEncoder().encode('data: first\n\n')); }, cancel(reason) { cancelledReason = reason; } });
  const reader = cancellable.pipeThrough(getEventSourceStream()).getReader();
  await reader.read(); await reader.cancel('fixture-stop'); await utils.delay(0);
  check(cancelledReason === 'fixture-stop', 'sse-reader-cancel-propagates-to-source');
  let sourceError;
  const broken = new ReadableStream({ start(controller) { controller.error(new Error('fixture-error')); } });
  try { await broken.pipeThrough(getEventSourceStream()).getReader().read(); } catch (error) { sourceError = error.message; }
  check(sourceError === 'fixture-error', 'sse-source-errors-propagate');
  return { stages, events };
}

export async function verifyPluginPrimitives(window, profile) {
  const frame = window.webContents.mainFrame;
  const result = await frame.executeJavaScript(`(${browserChecks.toString()})()`);
  const peer = frame;
  await frame.executeJavaScript(`(async () => {
    const api = await import('/scripts/extensions.js');
    if (api.extensionTypes['third-party/success'] !== 'local' || api.extensionTypes['third-party/peer'] !== 'local') throw new Error('Installed extension registry is not hydrated');
    const script = await import('/script.js');
    window.fixtureSharedSettings = api.extension_settings;
    window.fixtureSettingsEvents = 0;
    script.eventSource.on(script.event_types.SETTINGS_UPDATED, () => window.fixtureSettingsEvents++);
    api.extension_settings.fixtureSequence = 1;
    window.fixtureSave = script.saveSettings();
  })()`);
  await peer.executeJavaScript(`(async () => {
    const { extension_settings } = await import('/scripts/extensions.js');
    if (window.fixtureSharedSettings !== extension_settings || window.fixturePeerSettings !== extension_settings) throw new Error('Extension settings must be the same object across extensions');
    extension_settings.fixtureSequence = 2;
    await (await import('/script.js')).saveSettings();
  })()`);
  const settingsState = await frame.executeJavaScript(`(async () => {
    await window.fixtureSave;
    return { persisted: (await fetch('/api/extensions/settings').then(response => response.json())).extensionSettings.fixtureSequence, events: window.fixtureSettingsEvents };
  })()`);
  assert.deepEqual(settingsState, { persisted: 2, events: 2 });
  result.stages.push('shared-settings-object-and-real-extension-registry', 'settings-saves-serialize-slow-and-fast-writes');
  await peer.executeJavaScript(`(async () => {
    const { extension_settings } = await import('/scripts/extensions.js');
    const { saveSettingsDebounced } = await import('/script.js');
    extension_settings.fixtureSequence = 3; saveSettingsDebounced();
    extension_settings.fixtureSequence = 4; saveSettingsDebounced();
    for (let i = 0; i < 100; i++) {
      if ((await fetch('/api/extensions/settings').then(response => response.json())).extensionSettings.fixtureSequence === 4) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Debounced settings were not persisted');
  })()`);
  result.stages.push('debounced-extension-settings-persist-latest-edit');
  const liveBindings = await frame.executeJavaScript(`(async () => {
    const runtime = await import('/plugin-runtime/compat-runtime.js');
    const script = await import('/script.js');
    const saved = { ...runtime.getContext(), chat: [...script.chat], characters: [...script.characters] };
    const chat = script.chat, characters = script.characters;
    let chatChanges = 0; const listener = () => chatChanges++;
    script.eventSource.on(script.event_types.CHAT_CHANGED, listener);
    try {
      await runtime.applyHostContext({ conversationId: 'fixture-chat', characterUuid: 'fixture-character', name1: 'Player', name2: 'Character', chat: [{ role: 'user', content: 'hello' }], characters: [{ id: 'fixture-character', name: 'Character' }] });
      await runtime.applyHostContext({ conversationId: 'fixture-chat', chat: [{ role: 'user', content: 'edited' }] });
      return { sameChat: chat === script.chat, sameCharacters: characters === script.characters, content: script.chat[0].content, name: script.name2, id: script.this_chid, chatChanges };
    } finally { script.eventSource.off(script.event_types.CHAT_CHANGED, listener); await runtime.applyHostContext(saved); }
  })()`);
  assert.deepEqual(liveBindings, { sameChat: true, sameCharacters: true, content: 'edited', name: 'Character', id: 0, chatChanges: 1 });
  result.stages.push('live-context-bindings-and-chat-change-event');
  const downloadPath = join(profile, 'extension-export.json');
  const downloaded = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Extension download did not finish')), 5000);
    window.webContents.session.once('will-download', (_event, item) => {
      assert.equal(item.getFilename(), 'extension-export.json');
      item.setSavePath(downloadPath);
      item.once('done', (_event, state) => {
        clearTimeout(timer);
        state === 'completed' ? resolve() : reject(new Error('Download failed: ' + state));
      });
    });
  });
  await frame.executeJavaScript(`import('/scripts/utils.js').then(utils => utils.download('{"fixture":true}', 'extension-export.json', 'application/json'))`);
  await downloaded;
  assert.equal(await readFile(downloadPath, 'utf8'), '{"fixture":true}');
  result.stages.push('actual-extension-download-to-owned-profile');
  // A whole document reload destroys module state, forcing a DB read.
  await window.loadURL(window.webContents.getURL());
  const restored = await window.webContents.executeJavaScript(`(async () => {
    const host = await import('/plugin-runtime/desktop-host.js');
    return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (host.getStatuses().success === '扩展已运行') {
        clearInterval(timer); resolve(SillyTavern.getContext().extensionSettings.fixtureSequence);
      } else if (Date.now() - start > 10000) { clearInterval(timer); reject(new Error('Extension reload timed out')); }
    }, 25);
    });
  })()`);
  assert.equal(restored, 4);
  result.stages.push('extension-settings-survive-full-document-reload');
  return result;
}
