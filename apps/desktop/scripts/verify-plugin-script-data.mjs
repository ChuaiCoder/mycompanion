import assert from 'node:assert/strict';

async function browserChecks() {
  const core = await import('/script.js');
  const openai = await import('/scripts/openai.js');
  const { power_user } = await import('/scripts/power-user.js');
  const persona = await import('/scripts/personas.js');
  const navigation = await import('/scripts/RossAscends-mods.js');
  const groups = await import('/scripts/group-chats.js');
  const { MacroRegistry } = await import('/scripts/macros/engine/MacroRegistry.js');
  const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const created = await post('/api/characters/create', { ch_name: 'Data Bridge', fav: true,
    description: 'Description {{char}} / {{user}}', personality: 'Patient',
    scenario: 'Library', mes_example: '<START>\n{{user}}: Hello', first_mes: 'Welcome {{user}}' });
  if (!created.ok) throw new Error('Character create failed: ' + await created.text());
  const avatar = await created.text();
  await core.getCharacters();
  await core.selectCharacterById(core.characters.findIndex(item => item.avatar === avatar));
  navigation.favsToHotswap();
  const favorite = document.querySelector('#right-nav-panel .favorite-character');
  const favoriteState = { name: favorite?.textContent, avatar: favorite?.dataset.avatar,
    visible: !document.getElementById('right-nav-panel').hidden, mobile: navigation.isMobile(), groups: groups.getGroupNames() };
  const macroCatalog = MacroRegistry.getAllMacros({ excludeAliases: true });
  MacroRegistry.registerMacro('fixtureMacro', { description: 'Fixture value', handler: () => 'REGISTRY_OK' });
  MacroRegistry.registerMacroAlias('fixtureMacro', 'fixtureAlias');
  const macroState = { builtin: macroCatalog.some(item => item.name === 'char'),
    listed: MacroRegistry.getAllMacros({ excludeAliases: true }).some(item => item.name === 'fixtureMacro'),
    value: core.substituteParams('{{fixtureMacro}}'), alias: core.substituteParams('{{fixtureAlias}}') };
  MacroRegistry.unregisterMacro('fixtureMacro');
  const fields = core.getCharacterCardFields();
  const story = core.getCurrentChatId();
  const preview = await post('/api/conversations/' + story + '/prompt-preview', { draft: 'Hello' });
  if (!preview.ok) throw new Error('Prompt preview failed: ' + await preview.text());
  const provider = await fetch('/api/settings/provider').then(response => response.json());
  const selectedModel = openai.oai_settings.custom_model;
  openai.oai_settings.custom_model = 'conversion-test-model';
  let converted, exampleBlocks;
  try {
    converted = openai.setOpenAIMessages([
      { is_user: true, name: 'User', mes: 'First\r\nline', extra: {} },
      { is_user: false, name: 'Data Bridge', mes: 'Second', extra: { api: 'custom', model: 'conversion-test-model',
        media: [{ url: 'one.png' }, { url: 'two.png' }], media_display: 'gallery', media_index: 1,
        reasoning: 'thought', reasoning_signature: 'signed', tool_invocations: [{ id: 'same', signature: 'tool-signature' }] } },
      { is_user: false, name: 'Data Bridge', mes: 'Ignored', extra: { [Symbol.for('ignore')]: true } },
      { is_user: false, name: 'Narrator', mes: 'Stage', extra: { type: 'narrator' } },
      { is_user: false, name: 'Data Bridge', mes: 'Old', extra: { api: 'other', model: 'other',
        reasoning: 'stale', reasoning_signature: 'stale', tool_invocations: [{ id: 'old', signature: 'stale' }] } },
    ]);
    exampleBlocks = openai.setOpenAIMessageExamples(['<START>\nUser: Hello\nagain\nData Bridge: Reply']);
  } finally { openai.oai_settings.custom_model = selectedModel; }
  const cleanupKeys = ['allow_name1_display', 'allow_name2_display', 'collapse_newlines', 'trim_spaces', 'custom_stopping_strings'];
  const cleanupBefore = cleanupKeys.map(key => [key, Object.hasOwn(power_user, key), power_user[key]]);
  let cleaned, wrongSpeaker, endMarker, configuredStop;
  try {
    Object.assign(power_user, { allow_name1_display: false, allow_name2_display: false,
      collapse_newlines: true, trim_spaces: true, custom_stopping_strings: '["<END>"]' });
    cleaned = core.cleanUpMessage('Data Bridge: Hello\n\n\nworld<ST', false, false, true, ['<STOP>']);
    wrongSpeaker = core.cleanUpMessage('User: Wrong speaker', false, false, false, []);
    endMarker = core.cleanUpMessage({ getMessage: 'Response<|endoftext|>junk', stoppingStrings: [] });
    configuredStop = core.cleanUpMessage('Done<END>', false, false, false);
  } finally {
    for (const [key, existed, value] of cleanupBefore) if (existed) power_user[key] = value; else delete power_user[key];
  }
  const second = await post('/api/characters/create', { ch_name: 'Navigation Other', first_mes: 'Another opening' });
  if (!second.ok) throw new Error('Second character create failed: ' + await second.text());
  const secondAvatar = await second.text();
  await core.getCharacters();
  await core.selectCharacterById(core.characters.findIndex(item => item.avatar === secondAvatar));
  document.querySelector('#right-nav-panel .favorite-character')?.click();
  const selectionDeadline = Date.now() + 5000;
  while (core.name2 !== 'Data Bridge' && Date.now() < selectionDeadline) await new Promise(resolve => setTimeout(resolve, 20));
  const favoriteSelected = core.name2 === 'Data Bridge' && core.characters[core.this_chid]?.avatar === avatar;
  return {
    fields, story, preview: (await preview.json()).messages,
    replaced: core.baseChatReplace('Hi {{user}} to {{char}}\r'),
    examples: core.parseMesExamples('<START>\nOne<START>\nTwo'),
    budget: core.getMaxContextSize(), provider,
    bias: core.getBiasStrings('{{bias "leans left"}}', 'normal'),
    count: core.countOccurrences('a**b**', '**'), odd: core.isOdd(3),
    narrator: core.system_message_types.NARRATOR,
    avatars: [core.default_avatar, core.system_avatar].map(value => value.startsWith('data:image/svg+xml,')),
    collections: typeof openai.MessageCollection === 'function',
    converted, exampleBlocks,
    cleaned, wrongSpeaker, endMarker, configuredStop, avatarIsLive: core.user_avatar === persona.user_avatar,
    mainApi: core.main_api,
    favoriteState, macroState, avatar, favoriteSelected,
  };
}

export async function verifyPluginScriptData(window) {
  const report = await window.webContents.executeJavaScript(`(${browserChecks.toString()})()`);
  assert.equal(report.fields.description, 'Description Data Bridge / User');
  assert.equal(report.fields.firstMessage, 'Welcome User');
  assert.equal(report.fields.mesExamples, '<START>\nUser: Hello');
  assert.match(JSON.stringify(report.preview), /Description Data Bridge \/ User/);
  assert.equal(report.replaced, 'Hi User to Data Bridge');
  assert.deepEqual(report.examples, ['<START>\nOne\n', '<START>\nTwo\n']);
  assert.equal(report.budget, report.provider.contextLimitTokens - Math.min(report.provider.maxTokens, report.provider.contextLimitTokens) - 512);
  assert.equal(report.bias.promptBias, ' leans left');
  assert.equal(report.count, 2); assert.equal(report.odd, true);
  assert.equal(report.narrator, 'narrator');
  assert.deepEqual(report.avatars, [true, true]); assert.equal(report.collections, true);
  assert.deepEqual(report.converted.map(message => message.content), ['Old', 'Stage', 'Second', 'First\nline']);
  assert.equal(report.converted[0].signature, null);
  assert.equal(report.converted[0].invocations[0].signature, undefined);
  assert.equal(report.converted[1].role, 'system');
  assert.equal(report.converted[2].signature, 'signed');
  assert.equal(report.converted[2].invocations[0].signature, 'tool-signature');
  assert.equal(report.converted[2].reasoning, 'thought');
  assert.equal(report.converted[2].mediaDisplay, 'gallery');
  assert.equal(report.converted[2].mediaIndex, 1);
  assert.equal(report.converted[0].mediaIndex, 0);
  assert.deepEqual(report.exampleBlocks, [[
    { role: 'system', content: 'Hello\nagain', name: 'example_user' },
    { role: 'system', content: 'Reply', name: 'example_assistant' },
  ]]);
  assert.equal(report.cleaned, 'Hello\n\nworld');
  assert.equal(report.wrongSpeaker, '');
  assert.equal(report.endMarker, 'Response');
  assert.equal(report.configuredStop, 'Done');
  assert.equal(report.avatarIsLive, true);
  assert.equal(report.mainApi, 'openai');
  assert.equal(report.favoriteState.name, '★ Data Bridge');
  assert.equal(report.favoriteState.avatar, report.avatar);
  assert.equal(report.favoriteState.visible, true);
  assert.equal(report.favoriteSelected, true);
  assert.equal(typeof report.favoriteState.mobile, 'boolean');
  assert.deepEqual(report.favoriteState.groups, []);
  assert.deepEqual(report.macroState, { builtin: true, listed: true, value: 'REGISTRY_OK', alias: 'REGISTRY_OK' });
  return { passed: true, stages: ['live-character-fields-and-macros-match-native-preview', 'examples-bias-and-system-message-contract', 'helper-context-limit-matches-native-reserve', 'helper-chat-and-example-conversion-preserves-order-and-model-bound-thoughts', 'helper-output-cleanup-and-live-persona-binding', 'live-favorite-navigation-solo-group-contract-and-macro-catalog'] };
}
