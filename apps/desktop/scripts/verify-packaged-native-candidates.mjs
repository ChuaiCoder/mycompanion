import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function readSettings() {
  const { oai_settings: settings } = await import('/scripts/openai.js');
  return { n: settings.n, stream: settings.stream_openai, source: settings.chat_completion_source,
    openaiModel: settings.openai_model, customModel: settings.custom_model };
}
async function configure(settings) {
  const { oai_settings: current } = await import('/scripts/openai.js');
  current.n = settings.n; current.stream_openai = settings.stream; current.chat_completion_source = settings.source;
  current.openai_model = settings.openaiModel; current.custom_model = settings.customModel;
  await (await import('/plugin-runtime/settings.js')).saveSettings();
}
async function switchCandidate(expected, reasoning) {
  const { core, wait, check } = window.packagedFeatures;
  const message = core.getContext().chat.at(-1);
  const row = document.querySelector('[data-message-id="' + message.id + '"]');
  check(row?.querySelector('.swipe_right') && !row.querySelector('.swipe_right').disabled, 'Actual native candidate next button');
  row.querySelector('.swipe_right').click();
  await wait(() => core.getContext().chat.at(-1).mes === expected, 'Actual native candidate switched');
  // mes changes optimistically before awaited listeners and durable saving.
  // Wait for the actual button operation to finish; an external flush must not
  // turn a failed button save into an apparently successful UI acceptance.
  await wait(() => row.querySelector('.swipe_left') && !row.querySelector('.swipe_left').disabled,
    'Actual candidate button completes its awaited save');
  check(!row.querySelector('.panel-error[role="alert"]'), 'Candidate button did not report a failed save');
  await (await import('/plugin-runtime/chat.js')).flushChatSaves();
  check(core.getContext().chat.at(-1).generationMetadata.responseState.reasoning === reasoning, 'Actual native selected reasoning');
}

async function verifyCandidateDisplay(expected, reasoning, imageCount) {
  const { core, wait, check } = window.packagedFeatures;
  const id = core.getContext().chat.at(-1).id;
  const row = () => document.querySelector('[data-message-id="' + id + '"]');
  await wait(() => row()?.querySelector('.mes_text')?.textContent.includes(expected)
    && row()?.querySelector('.model-reasoning pre')?.textContent === reasoning,
  'Actual React candidate text and reasoning display');
  check(row().querySelectorAll('.generation-details .model-media img').length === imageCount,
    'Actual React candidate media belongs to the selected reply');
  if (imageCount) {
    await row().querySelector('.generation-details .model-media img').decode();
    check(row().querySelector('.generation-details .model-media img').naturalWidth === 1,
      'Actual candidate image decodes before selection');
  }
}

async function reloadCandidate() {
  await (await import('/plugin-runtime/chat.js')).reloadCurrentChat();
}

/** Actual candidate renderer controls, provider HTTP and SQLite-backed GET.
 * Uses public text/media only; no private card or helper data enters this stage. */
export async function verifyPackagedNativeCandidates({ view, send, requests, story, storyId, phase, record, snapshots }) {
  const browserCall = (fn, ...args) => view('return (' + fn.toString() + ')(' + args.map(value => JSON.stringify(value)).join(',') + ');');
  const original = await browserCall(readSettings);
  try {
    for (const [stream, mode, expected, alternate, reasoning] of [
      [false, 'native-n-json', 'PACKAGED_JSON_A', 'PACKAGED_JSON_B', 'PACKAGED_REASON_B'],
      [true, 'native-n-stream', 'PACKAGED_A1A2', 'PACKAGED_B1B2', 'STREAM_REASON_B'],
    ]) {
      await browserCall(configure, { ...original, n: 2, stream, source: 'openai', openaiModel: 'packaged-feature-model' });
      const before = requests.length;
      await send('Public native candidate probe ' + mode, mode);
      const actual = requests.slice(before).filter(item => item.body.n === 2);
      assert.equal(actual.length, 1, 'Native n makes one actual request'); assert.equal(actual[0].body.stream, stream);
      assert.equal(actual[0].url, '/v1/chat/completions'); assert.equal(actual[0].body.model, 'packaged-feature-model',
        'Candidate n must use the selected feature connection model');
      let message = (await story(storyId)).messages.at(-1);
      assert.equal(message.content, expected); assert.deepEqual(message.extensionData.swipes, [expected, alternate]);
      assert.equal(message.extensionData.swipe_id, 0); assert.equal(message.generationMetadata.usage.totalTokens, 18);
      if (!stream) assert.equal(message.generationMetadata.responseState.media.length, 1, 'First JSON candidate carries the actual public image');
      await browserCall(verifyCandidateDisplay, expected, stream ? 'STREAM_REASON_A' : 'PACKAGED_REASON_A', stream ? 0 : 1);
      await browserCall(switchCandidate, alternate, reasoning);
      await browserCall(verifyCandidateDisplay, alternate, reasoning, 0);
      await browserCall(reloadCandidate);
      await browserCall(verifyCandidateDisplay, alternate, reasoning, 0);
      message = (await story(storyId)).messages.at(-1);
      assert.equal(message.content, alternate); assert.equal(message.extensionData.swipe_id, 1);
      assert.equal(message.generationMetadata.responseState.reasoning, reasoning);
      assert.equal(message.generationMetadata.responseState.media.length, 0, 'Alternate candidate does not inherit the first image');
      assert.equal(message.generationMetadata.usage.totalTokens, 18, 'Selection does not duplicate request billing');
      for (const info of message.extensionData.swipe_info) assert(!Object.hasOwn(info.extra.__mycompanion_native_candidate, 'usage'));
      snapshots.push({ id: message.id, sha256: digest(message) });
      record(phase, mode === 'native-n-json'
        ? 'native-n-JSON-index-selection-real-swipe-isolates-reasoning-media-and-request-usage'
        : 'native-n-SSE-reordered-multiple-choices-and-usage-only-frame-persist-real-swipe',
      { candidates: 2, actualRequests: actual.length });
    }
  } finally { await browserCall(configure, original); }
}
