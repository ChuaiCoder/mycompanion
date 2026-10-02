import assert from 'node:assert/strict';

async function browserChecks() {
  const core = await import('/script.js');
  const personas = await import('/scripts/personas.js');
  const { power_user } = await import('/scripts/power-user.js');
  const { saveSettings } = await import('/plugin-runtime/settings.js');
  const id = 'mc-persona-fixture.png';
  const bytes = Uint8Array.from(atob(core.default_user_avatar.split(',')[1]), value => value.charCodeAt(0));
  const form = new FormData();
  form.append('avatar', new File([bytes], id, { type: 'image/png' }));
  form.append('overwrite_name', id);
  const upload = await fetch('/api/avatars/upload', { method: 'POST', body: form });
  if (!upload.ok) throw new Error('Persona upload failed: ' + await upload.text());
  power_user.personas[id] = 'Fixture Reader';
  power_user.persona_descriptions[id] = { description: 'Fixture persona {{user}}', position: 0, depth: 2, role: 0, title: '' };
  await saveSettings();
  await personas.setUserAvatar(id);
  const story = core.getCurrentChatId();
  const preview = await fetch('/api/conversations/' + story + '/prompt-preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: 'hello' }) });
  if (!preview.ok) throw new Error('Persona preview failed: ' + await preview.text());
  const messages = (await preview.json()).messages;
  return { id, story, list: await personas.getUserAvatars(false), selected: personas.user_avatar,
    name: core.name1, description: power_user.persona_description, prompt: JSON.stringify(messages),
    imageOk: (await fetch(personas.getUserAvatar(id))).ok };
}

export async function verifyPluginPersonas(window) {
  const first = await window.webContents.executeJavaScript(`(${browserChecks.toString()})()`);
  assert(first.list.includes(first.id));
  assert.equal(first.selected, first.id);
  assert.equal(first.name, 'Fixture Reader');
  assert.equal(first.description, 'Fixture persona {{user}}');
  assert.match(first.prompt, /Fixture persona Fixture Reader/);
  assert.equal(first.imageOk, true);
  window.reload();
  let restored;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      restored = await window.webContents.executeJavaScript(`(async () => {
        const p = await import('/scripts/personas.js'); const s = await import('/script.js');
        return { id: p.user_avatar, name: s.name1, imageOk: (await fetch(p.getUserAvatar('mc-persona-fixture.png'))).ok };
      })()`);
      if (restored.id === first.id && restored.name === 'Fixture Reader') break;
    } catch { /* Navigation is still in progress. */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.deepEqual(restored, { id: first.id, name: 'Fixture Reader', imageOk: true });
  const removed = await window.webContents.executeJavaScript(`(async () => {
    const personas = await import('/scripts/personas.js');
    const core = await import('/script.js');
    const { power_user } = await import('/scripts/power-user.js');
    const response = await fetch('/api/avatars/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ avatar: 'mc-persona-fixture.png' }) });
    delete power_user.personas['mc-persona-fixture.png'];
    delete power_user.persona_descriptions['mc-persona-fixture.png'];
    await personas.getUserAvatars(true);
    return { deleted: response.ok, selected: personas.user_avatar, name: core.name1,
      stored: (await fetch('/api/extensions/settings').then(result => result.json())).extensionSettings.__mycompanion_power_user.__selected_persona };
  })()`);
  assert.deepEqual(removed, { deleted: true, selected: '', name: 'User', stored: '' });
  return { passed: true, stages: ['upload-select-name-description-and-native-prompt', 'selected-persona-and-avatar-survive-document-reload', 'deleted-last-persona-clears-selected-name-and-description'] };
}
