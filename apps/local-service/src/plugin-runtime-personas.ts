// Browser persona state uses the same saved power_user object as native prompt
// assembly. Avatar files are served from the project's SQLite database.
export const personasRuntimeSource = String.raw`
import { power_user, loadPowerUser, persona_description_positions } from '/scripts/power-user.js';
import { saveSettings, saveSettingsDebounced } from '/plugin-runtime/settings.js';
import { saveMetadata } from '/plugin-runtime/chat.js';
import { getContext, subscribeHostContext, eventSource, event_types, setUserName } from '/plugin-runtime/compat-runtime.js';

await loadPowerUser();
export let user_avatar = '';
const selectedKey = '__selected_persona';
const validId = value => typeof value === 'string' && /^[\p{L}\p{N}._-]+\.png$/u.test(value) && !value.includes('..');
const currentName = id => power_user.personas?.[id];
function applySelection(id, { clearDescription = false } = {}) {
  user_avatar = id || '';
  // A manual persona description is valid without an avatar. Loading the
  // compatibility module must not erase it before the first prompt is built.
  if (user_avatar || clearDescription) {
    const descriptor = power_user.persona_descriptions?.[user_avatar] || {};
    power_user.persona_description = descriptor.description || '';
    power_user.persona_description_position = descriptor.position ?? persona_description_positions.IN_PROMPT;
    power_user.persona_description_depth = descriptor.depth ?? 2;
    power_user.persona_description_role = descriptor.role ?? 0;
    power_user.persona_description_lorebook = descriptor.lorebook || '';
  }
  if(power_user.persona_description_position===persona_description_positions.AFTER_CHAR)
    power_user.persona_description_position=persona_description_positions.IN_PROMPT;
  setUserName(currentName(user_avatar) || 'User', { toastPersonaNameChange: false });
}
const lockedPersona = () => {
  const id = getContext().chatMetadata?.persona;
  return validId(id) && currentName(id) !== undefined ? id : '';
};
applySelection(lockedPersona() || (validId(power_user[selectedKey]) ? power_user[selectedKey] : '') ||
  (validId(power_user.default_persona) ? power_user.default_persona : ''));
subscribeHostContext(() => {
  const next = lockedPersona() || power_user[selectedKey] || power_user.default_persona || '';
  if (next !== user_avatar) applySelection(next, { clearDescription: true });
});

export function getUserAvatar(id) { return './User Avatars/' + encodeURIComponent(String(id)); }
export async function getUserAvatars(doRender = true, openPageAt = '') {
  const response = await fetch('/api/avatars/get', { method: 'POST', cache: 'no-cache' });
  if (!response.ok) throw new Error('获取用户头像失败：HTTP ' + response.status);
  const names = await response.json();
  if (!Array.isArray(names)) throw new Error('用户头像列表格式无效。');
  if (doRender && user_avatar && !names.includes(user_avatar)) {
    const next = names.find(id => currentName(id) !== undefined) || '';
    power_user[selectedKey] = next;
    applySelection(next, { clearDescription: true });
    await saveSettings();
    await eventSource.emit(event_types.PERSONA_CHANGED, next);
  }
  if (doRender) {
    const list = document.getElementById('user_avatar_block');
    if (list) {
      list.replaceChildren(...names.map(id => {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'avatar-container'; button.dataset.avatarId = id;
        const image = document.createElement('img'); image.src = getUserAvatar(id); image.alt = '';
        const label = document.createElement('span'); label.textContent = currentName(id) || id;
        button.append(image, label); button.addEventListener('click', () => void setUserAvatar(id));
        return button;
      }));
      if (openPageAt) list.querySelector('[data-avatar-id="' + CSS.escape(openPageAt) + '"]')?.scrollIntoView({ block: 'nearest' });
    }
  }
  return names;
}
export async function setUserAvatar(id, _options = {}) {
  const selected = typeof id === 'string' ? id : this?.getAttribute?.('data-avatar-id');
  if (!validId(selected)) throw new Error('用户头像标识无效。');
  const names = await getUserAvatars(false);
  if (!names.includes(selected)) throw new Error('用户头像不存在：' + selected);
  if (selected === user_avatar) return;
  power_user[selectedKey] = selected;
  if (Object.hasOwn(getContext().chatMetadata || {}, 'persona')) {
    getContext().chatMetadata.persona = selected;
    await saveMetadata();
  }
  applySelection(selected);
  await saveSettings();
  await eventSource.emit(event_types.PERSONA_CHANGED, selected);
}
export function initUserAvatar(id) {
  if (validId(id)) { power_user[selectedKey] = id; applySelection(id); saveSettingsDebounced(); }
}
`;
