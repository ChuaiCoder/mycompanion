import { mergeChatMessages, mergeJsonChanges, toExtensionMessage } from "@mycompanion/shared";

// These pure, dependency-free functions are also used by the repository and
// renderer. Serving their compiled bodies keeps merging identical at both ends.
export const chatMergeSource = `
export const mergeJsonChanges = ${mergeJsonChanges.toString()};
export const mergeChatMessages = ${mergeChatMessages.toString()};
export const toExtensionMessage = ${toExtensionMessage.toString()};
`;

export const chatPersistenceSource = String.raw`
import { mergeJsonChanges, mergeChatMessages, toExtensionMessage } from '/plugin-runtime/chat-merge.js';
import {applyMacroVariableChange} from '/plugin-runtime/macro-variable-sync.js';
import {isMacroDraftActive} from '/plugin-runtime/macro-draft.js';
let context, callbacks, lastHost, baseline, rendering = false;
let queue = Promise.resolve(), debounce, pending, outstanding = 0;
export let isChatSaving = false;
const clone = value => JSON.parse(JSON.stringify(value));
const same = target => context?.conversationId === target.id && context?.branchId === target.branchId;
const state = () => ({ messages: clone(context.chat), metadata: clone(context.chatMetadata) });
const project = conversation => ({ messages: conversation.messages.map(message => toExtensionMessage(message, conversation.characterName)), metadata: conversation.chatMetadata || {} });
const merge = (base, next, current) => ({ messages: mergeChatMessages(base.messages, next.messages, current.messages, mergeJsonChanges), metadata: mergeJsonChanges(base.metadata, next.metadata, current.metadata) });
function replaceRecord(target, source, preserveNested = false) {
  for (const key of Object.keys(target)) if (!Object.hasOwn(source, key)) delete target[key];
  for (const [key, value] of Object.entries(source)) {
    const previous = target[key];
    if (preserveNested && previous !== null && value !== null && typeof previous === 'object' && typeof value === 'object'
      && Array.isArray(previous) === Array.isArray(value)) replaceRecord(previous, value, true);
    else Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
  }
  if (Array.isArray(target) && Array.isArray(source)) target.length = source.length;
}
function replaceState(value, preserveVariables = true) {
  const existing = new Map(context.chat.map(message => [message.id, message]));
  context.chat.splice(0, context.chat.length, ...value.messages.map(message => {
    const target = existing.get(message.id);
    if (target) { replaceRecord(target, message); return target; }
    return message;
  }));
  const metadata = { ...value.metadata }, local = context.chatMetadata.variables;
  if (preserveVariables && local && typeof local === 'object' && !Array.isArray(local)
    && (metadata.variables === undefined || metadata.variables && typeof metadata.variables === 'object' && !Array.isArray(metadata.variables))) {
    // Missing variables means an empty namespace, but imported closures still
    // retain the canonical map for this story after an assistant branch switch.
    replaceRecord(local, metadata.variables ?? {}, true); metadata.variables = local;
  }
  replaceRecord(context.chatMetadata, metadata, preserveVariables);
}
export function bindChatContext(value) { context = value; }
export function applyLocalMacroChanges(conversationId,changes){
  if(!context || (context.conversationId??null)!==(conversationId??null))return;
  for(const change of changes.filter(item=>item.scope==='local')){
    applyMacroVariableChange(context.chatMetadata.variables??={},change);
    if(baseline)applyMacroVariableChange(baseline.metadata.variables??={},change);
  }
}
export function applyWorldInfoState(target,value){
  if(!context || context.conversationId!==target.conversationId || context.branchId!==target.branchId || !value)return false;
  for(const key of ['timedWorldInfo','__mycompanion_world_info_state'])if(Object.hasOwn(value,key)){
    const next=clone(value[key]),previous=context.chatMetadata[key];
    if(previous && next && typeof previous==='object' && typeof next==='object' && Array.isArray(previous)===Array.isArray(next))
      replaceRecord(previous,next,true);
    else context.chatMetadata[key]=next;
    if(baseline)baseline.metadata[key]=clone(next);
  }
  callbacks?.syncMetadata?.(target.conversationId,clone(context.chatMetadata));
  return true;
}
export function connectChatPersistence(value) { callbacks = value; }
export function applyChatContext(next) {
  if (!next.chat) return;
  const incoming = { messages: clone(next.chat), metadata: clone(next.chatMetadata ?? context.chatMetadata) };
  const switched = (Object.hasOwn(next, 'conversationId') && next.conversationId !== context.conversationId) || (Object.hasOwn(next, 'branchId') && next.branchId !== context.branchId);
  if (switched && pending) {
    const snapshot = same(pending) ? capture() : pending;
    clearTimeout(debounce); pending = undefined;
    void enqueue(snapshot).catch(error => callbacks?.error(error));
  }
  if (switched || !lastHost) {
    // Branches share this story's local variable namespace. React publishes a
    // new snapshot on every message/delta; retain imported/cached map identity.
    replaceState(incoming, !Object.hasOwn(next, 'conversationId') || next.conversationId === context.conversationId); baseline = clone(incoming);
  } else {
    replaceState(merge(lastHost, incoming, state()));
    if (!rendering) baseline = clone(merge(lastHost, incoming, baseline));
  }
  lastHost = clone(incoming);
}
function capture() {
  // ST's neutral chat has no persisted file; keep its in-memory state without
  // inventing a story or preventing extension initialization.
  if (!context.conversationId || !context.branchId) return null;
  for (const message of context.chat) {
    if (!message.id) message.id = crypto.randomUUID();
    if (message.mes === undefined) message.mes = '';
    if (message.is_user === undefined) message.is_user = false;
  }
  return { id: context.conversationId, branchId: context.branchId, base: clone(baseline), next: state() };
}
async function read(response) {
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error?.message || '聊天请求失败：HTTP ' + response.status);
  }
  return response.json();
}
function render(conversation, value, reloaded = false) {
  if (!callbacks?.render) throw new Error('聊天界面尚未连接。');
  rendering = true;
  try { callbacks.render(conversation, value, reloaded); } finally { rendering = false; }
}
function enqueue(snapshot) {
  if (!snapshot) return Promise.resolve();
  outstanding++; isChatSaving = true;
  const operation = queue.catch(() => {}).then(async () => {
    const { id, ...payload } = snapshot;
    const conversation = await read(await fetch('/api/conversations/' + encodeURIComponent(id) + '/extension-state', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }));
    if (same(snapshot)) {
      const stored = project(conversation);
      const latest = merge(snapshot.next, state(), stored);
      baseline = clone(stored);
      replaceState(latest);
      lastHost = clone(latest);
      render(conversation, latest);
    }
  }).finally(() => { outstanding--; isChatSaving = outstanding > 0; });
  queue = operation;
  return operation;
}
export function saveChatConditional() {
  if(isMacroDraftActive())return Promise.resolve();
  clearTimeout(debounce); pending = undefined;
  return enqueue(capture());
}
export const saveMetadata = saveChatConditional;
export function cancelDebouncedChatSave() { clearTimeout(debounce); pending = undefined; }
export function saveMetadataDebounced() {
  if(isMacroDraftActive())return;
  pending = capture(); clearTimeout(debounce);
  if (!pending) return;
  debounce = setTimeout(() => {
    const snapshot = same(pending) ? capture() : pending; pending = undefined;
    void enqueue(snapshot).catch(error => callbacks?.error(error));
  }, 1000);
}
export async function flushChatSaves() {
  if (pending) {
    clearTimeout(debounce);
    const snapshot = same(pending) ? capture() : pending; pending = undefined;
    await enqueue(snapshot);
  }
  await queue;
}
export async function reloadCurrentChat() {
  const target = { id: context.conversationId, branchId: context.branchId };
  if (!target.id) return;
  await flushChatSaves();
  const conversation = await read(await fetch('/api/conversations/' + encodeURIComponent(target.id)));
  if (!same(target)) return;
  const loaded = project(conversation);
  replaceState(loaded); baseline = clone(loaded); lastHost = clone(loaded);
  render(conversation, loaded, true);
  await callbacks.changed(target.id);
}
`;
