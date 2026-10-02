// Small browser adapters for the independent desktop's live character and
// group navigation state. No upstream UI or source is embedded.
export const rossAscendsRuntimeSource = String.raw`
import { getContext } from '/plugin-runtime/compat-runtime.js';
import { selectCharacterById } from '/plugin-runtime/character-editor.js';

export function isMobile() {
  return Boolean(navigator.userAgentData?.mobile || window.matchMedia('(pointer: coarse) and (max-width: 900px)').matches);
}

export function favsToHotswap() {
  const panel = document.getElementById('right-nav-panel');
  const container = panel?.querySelector('.hotswap');
  if (!panel || !container) return;
  const favorites = getContext().characters.map((character, index) => ({ character, index }))
    .filter(({ character }) => character?.fav === true || character?.fav === 'true' ||
      character?.data?.extensions?.fav === true || character?.data?.extensions?.fav === 'true').slice(0, 25);
  panel.hidden = favorites.length === 0;
  container.replaceChildren(...favorites.map(({ character, index }) => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'favorite-character';
    button.dataset.avatar = character.avatar;
    button.textContent = '★ ' + character.name;
    button.title = character.name;
    button.addEventListener('click', () => { void selectCharacterById(index); });
    return button;
  }));
}
window.addEventListener('mycompanion:characters', favsToHotswap);
queueMicrotask(favsToHotswap);
`;

export const groupChatsRuntimeSource = String.raw`
import { getContext } from '/plugin-runtime/compat-runtime.js';
export function getGroupNames() {
  const context = getContext();
  if (!context.groupId) return [];
  if (!Array.isArray(context.groupMembers)) throw new Error('当前群聊尚未载入成员，无法组装群聊提示词。');
  const byAvatar = new Map(context.characters.map(character => [character.avatar, character.name]));
  return context.groupMembers.map(avatar => byAvatar.get(avatar)).filter(Boolean);
}
`;
