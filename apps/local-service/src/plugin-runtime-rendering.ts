// Forward to the same renderer used by the visible React conversation. No
// second converter, hidden message surface or copied Tavern implementation.
export const messageRenderingSource = String.raw`
import { getContext, clearExtensionPrompts, subscribeHostContext } from '/plugin-runtime/compat-runtime.js';
import { cancelDebouncedChatSave } from '/plugin-runtime/chat.js';
import { onExtensionSettingsSaved } from '/plugin-runtime/settings.js';
import { eventSource, event_types } from '/plugin-runtime/compat-runtime.js';
let renderer,regexDisplayKey;
const refreshRegexDisplay=()=>{
  if(!renderer)return;const key=renderer.regexDisplayKey();if(key===regexDisplayKey)return;regexDisplayKey=key;
  for(const [index,message] of getContext().chat.entries())updateMessageBlock(index,message);
};
subscribeHostContext(refreshRegexDisplay);
onExtensionSettingsSaved(refreshRegexDisplay);
eventSource.on(event_types.CHARACTER_EDITED,refreshRegexDisplay);
eventSource.on(event_types.PRESET_CHANGED,refreshRegexDisplay);
export function connectMessageRendering(value) { renderer = value; }
function connected() {
  if (!renderer) throw new Error('消息渲染器尚未连接。');
  return renderer;
}
export function messageFormatting(...args) { return connected().messageFormatting(...args); }
export function reloadMarkdownProcessor() { return connected().reloadMarkdownProcessor(); }
export async function clearChat({ clearData = false } = {}) {
  cancelDebouncedChatSave(); clearExtensionPrompts();
  document.querySelector('#chat .mes_edit_cancel')?.click();
  if (clearData) getContext().chat.length = 0;
  connected().messageSurface.clear();
}
export async function printMessages() {
  const context = getContext();
  connected().messageSurface.print(context.chat, context);
  await scrollChatToBottom({ waitForFrame: true });
}
export function addOneMessage(message, { type, insertAfter = null, scroll = true, insertBefore = null, forceId = null, showSwipes = true } = {}) {
  const context = getContext(), found = context.chat.indexOf(message);
  const index = typeof forceId === 'number' ? forceId : typeof insertBefore === 'number' ? insertBefore - 1
    : typeof insertAfter === 'number' ? insertAfter + 1 : found < 0 ? context.chat.length - 1 : found;
  if (type === 'swipe') { message.swipe_id ??= 0; message.swipes ??= [message.mes]; }
  const element = connected().messageSurface.add(message, index, { type, insertAfter, insertBefore, showSwipes }, context);
  if (!insertAfter && !insertBefore && scroll) void scrollChatToBottom({ waitForFrame: true });
  return globalThis.jQuery(element);
}
export function updateMessageBlock(messageId, message, { rerenderMessage = true } = {}) {
  const index = Number(messageId);
  if (!Number.isInteger(index) || index < 0) return;
  const block = document.querySelector('#chat > .mes[mesid="' + index + '"]');
  const content = block?.querySelector('.mes_text');
  if (content && rerenderMessage) {
    content.innerHTML = messageFormatting(message.extra?.display_text ?? message.mes, message.name, message.is_system, message.is_user, index);
  }
}
export async function scrollChatToBottom({ waitForFrame = false } = {}) {
  if (waitForFrame) await new Promise(resolve => requestAnimationFrame(resolve));
  const chat = document.getElementById('chat');
  if (!chat) return;
  if (chat.scrollHeight > chat.clientHeight) chat.scrollTo({ top: chat.scrollHeight, behavior: 'instant' });
  else ([...chat.querySelectorAll(':scope > .mes')].at(-1) ?? chat.lastElementChild)?.scrollIntoView({ block: 'end', behavior: 'instant' });
}
`;
