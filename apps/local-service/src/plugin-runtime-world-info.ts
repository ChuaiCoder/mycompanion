import { convertCharacterBook, newWorldInfoEntryTemplate, parseRegexFromString, worldInfoSettingsSchema } from "@mycompanion/shared";

export const worldInfoDataSource = `
export const newWorldInfoEntryTemplate = ${JSON.stringify(newWorldInfoEntryTemplate)};
export const parseRegexFromString = ${parseRegexFromString.toString()};
export const convertCharacterBook = ${convertCharacterBook.toString()};
export const defaultSettings = ${JSON.stringify(worldInfoSettingsSchema.parse({}))};
`;

export const worldInfoRuntimeSource = String.raw`
import { defaultSettings } from '/plugin-runtime/world-info-data.js';
export { newWorldInfoEntryTemplate, convertCharacterBook, parseRegexFromString } from '/plugin-runtime/world-info-data.js';
import { getContext, eventSource, event_types } from '/plugin-runtime/compat-runtime.js';
import { oai_settings, getChatCompletionModel } from '/plugin-runtime/openai-settings.js';
import { extension_settings } from '/plugin-runtime/settings.js';
import { registerSettingsParticipant, saveSettings, saveSettingsDebounced } from '/plugin-runtime/settings.js';
import { Popup } from '/plugin-runtime/popup.js';
import {captureMacroApiTarget,requestMacroEvaluation} from '/plugin-runtime/macro-api.js';
export const METADATA_KEY = 'world_info', DEFAULT_DEPTH = 4, DEFAULT_WEIGHT = 100, MAX_SCAN_DEPTH = 1000;
export const world_info_position = { before: 0, after: 1, ANTop: 2, ANBottom: 3, atDepth: 4, EMTop: 5, EMBottom: 6, outlet: 7 };
export const wi_anchor_position = { before: 0, after: 1 };
export const world_info_logic = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 };
export const world_names = [], selected_world_info = [], world_info = {};
const clone = value => structuredClone(value);
const settings = clone(defaultSettings);
export let world_info_include_names = settings.world_info_include_names;
const cache = new Map(), epochs = new Map(), queues = new Map(), pending = new Map();
let ready, listRevision = 0, controlsAttached = false;
const notify = detail => window.dispatchEvent(new CustomEvent('mycompanion:world-info', { detail }));
const revision = name => { const next = (epochs.get(name) || 0) + 1; epochs.set(name, next); return next; };
const reportError = error => { console.error(error); globalThis.toastr?.error(error.message, '世界书保存失败'); };
async function request(path, body, method = 'POST') {
  const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error('World info HTTP ' + response.status + ': ' + await response.text());
  return response.json();
}
function assignRecord(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  for (const [key, value] of Object.entries(source)) Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}
export const worldInfoCache = {
  has: name => cache.has(name), get: name => cache.has(name) ? clone(cache.get(name)) : undefined,
  set: (name, data) => { revision(name); cache.set(name, clone(data)); return worldInfoCache; },
  delete: name => { revision(name); return cache.delete(name); },
  clear: () => { for (const name of cache.keys()) revision(name); cache.clear(); },
};
export function getWorldInfoSettings() { return { ...settings, world_info, world_info_include_names }; }
function assignSettings(value) {
  Object.assign(settings, value); world_info_include_names = settings.world_info_include_names;
  assignRecord(world_info, value.world_info ?? defaultSettings.world_info);
  selected_world_info.splice(0, selected_world_info.length, ...(world_info.globalSelect || []));
  world_info.globalSelect = selected_world_info;
}
export async function loadWorldInfoState() {
  return ready ??= (async () => {
    assignSettings(await request('/api/worldinfo/settings', undefined, 'GET'));
    await updateWorldInfoList();
  })().catch(error => { ready = undefined; throw error; });
}
registerSettingsParticipant('world-info', () => {
  world_info.globalSelect = selected_world_info;
  const snapshot = clone(getWorldInfoSettings());
  return async () => { await request('/api/worldinfo/settings', snapshot, 'PUT'); };
});
export function updateWorldInfoSettings(value, activeWorldInfo) {
  for (const [key, next] of Object.entries(value || {})) {
    if (key !== 'world_info' && Object.hasOwn(defaultSettings, key)) settings[key] = typeof defaultSettings[key] === 'boolean' ? Boolean(next) : Number(next);
  }
  world_info_include_names = settings.world_info_include_names;
  if (Array.isArray(activeWorldInfo)) selected_world_info.splice(0, selected_world_info.length, ...activeWorldInfo);
  world_info.globalSelect = selected_world_info;
  syncWorldInfoControls(); notify({ settings: true }); saveSettingsDebounced();
}
export async function updateWorldInfoList() {
  const revision = ++listRevision;
  const data = await request('/api/worldinfo/list', undefined, 'GET');
  if (revision !== listRevision) return;
  world_names.splice(0, world_names.length, ...data.world_names);
  syncWorldInfoControls(); notify({ names: true });
}
function enqueue(name, operation) {
  const write = (queues.get(name) || Promise.resolve()).catch(() => {}).then(operation);
  queues.set(name, write);
  // Keep rejection observable to callers/flush, but never leave it unhandled.
  void write.catch(() => {});
  return write;
}
function persist(name, snapshot) {
  const write = enqueue(name, () => request('/api/worldinfo/edit', { name, data: snapshot }));
  // Subscribers can await another save without waiting on their own callback.
  return write.then(async () => {
    notify({ name });
    await eventSource.emit(event_types.WORLDINFO_UPDATED, name, clone(snapshot));
  });
}
export async function saveWorldInfo(name, data, immediately = false) {
  if (!name || !data) return;
  const snapshot = clone(data); revision(name); cache.set(name, snapshot);
  if (pending.has(name)) clearTimeout(pending.get(name).timer);
  pending.delete(name);
  if (immediately) return persist(name, snapshot);
  const item = { snapshot, timer: setTimeout(() => {
    if (pending.get(name) !== item) return;
    pending.delete(name); void persist(name, snapshot).catch(reportError);
  }, 1000) };
  pending.set(name, item);
}
export async function flushWorldInfoWrites() {
  for (;;) {
    const notifications = [];
    for (const [name, item] of pending) {
      clearTimeout(item.timer); pending.delete(name);
      notifications.push(persist(name, item.snapshot));
    }
    const writes = [...queues.entries()];
    await Promise.all([...writes.map(([, promise]) => promise), ...notifications]);
    if (!pending.size && writes.length === queues.size && writes.every(([name, promise]) => queues.get(name) === promise)) return;
  }
}
export async function loadWorldInfo(name) {
  if (!name) return;
  if (cache.has(name)) return clone(cache.get(name));
  const version = epochs.get(name);
  const response = await fetch('/api/worldinfo/get', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }), cache: 'no-store' });
  if (version !== epochs.get(name)) return cache.has(name) ? clone(cache.get(name)) : null;
  if (!response.ok) return null;
  const data = await response.json();
  if (version !== epochs.get(name)) return cache.has(name) ? clone(cache.get(name)) : null;
  cache.set(name, clone(data)); return data;
}
export async function deleteWorldInfo(name) {
  if (!world_names.includes(name)) return false;
  const version = revision(name), previous = cache.get(name), buffered = pending.get(name);
  if (buffered) clearTimeout(buffered.timer);
  pending.delete(name); cache.delete(name);
  try {
    await enqueue(name, () => request('/api/worldinfo/delete', { name }));
  } catch (error) {
    if (epochs.get(name) === version) {
      if (previous !== undefined) cache.set(name, previous);
      if (buffered) await saveWorldInfo(name, buffered.snapshot);
    }
    reportError(error); return false;
  }
  // Reads begun after delete was requested but before it committed must also
  // be invalidated. A later explicit save has its own epoch and remains intact.
  if (epochs.get(name) === version) { revision(name); cache.delete(name); }
  for (let index = selected_world_info.length - 1; index >= 0; index--) if (selected_world_info[index] === name) selected_world_info.splice(index, 1);
  for (const binding of world_info.charLore || []) binding.extraBooks = binding.extraBooks.filter(item => item !== name);
  await saveSettings(); await updateWorldInfoList(); notify({ name, deleted: true });
  return true;
}
export async function createNewWorldInfo(name, { interactive = false } = {}) {
  if (!name) return false;
  const { fileName } = await request('/api/files/sanitize-filename', { fileName: name });
  if (!fileName.trim()) return false;
  const existing = world_names.find(item => item.localeCompare(fileName, undefined, { sensitivity: 'base' }) === 0);
  if (existing) {
    if (!interactive || !(await Popup.show.confirm('覆盖世界书', '同名世界书已存在，是否覆盖？'))) return false;
    if (!(await deleteWorldInfo(existing))) return false;
  }
  await saveWorldInfo(fileName, { entries: {} }, true); await updateWorldInfoList();
  selectWorldInfoEditor(fileName); return true;
}
export function selectWorldInfoEditor(name) {
  const select = document.getElementById('world_editor_select');
  if (select) select.value = String(world_names.indexOf(name));
  window.dispatchEvent(new CustomEvent('mycompanion:world-editor', { detail: { name } }));
}
export function setWorldInfoButtonClass(chid, forceValue) {
  const character = getContext().characters.find(item => item.id === chid) || getContext().characters[chid];
  const value = forceValue ?? Boolean(character?.data?.extensions?.world && world_names.includes(character.data.extensions.world));
  if (forceValue === undefined && chid === undefined) return;
  document.querySelectorAll('#set_character_world, #world_button').forEach(node => node.classList.toggle('world_set', value));
}
export async function getWorldInfoPrompt(chat, maxContext, isDryRun = false, globalScanData) {
  const target=captureMacroApiTarget();
  await flushWorldInfoWrites();
  const context = getContext();
  const { snapshotExtensionPrompts } = await import('/plugin-runtime/compat-runtime.js');
  const extensionScanPrompts = await snapshotExtensionPrompts({}, [], { scanOnly: true });
  world_info.globalSelect = selected_world_info;
  const { report, activated } = await requestMacroEvaluation('/api/worldinfo/prompt', current=>({
    chat, maxContext, isDryRun, maxResponseTokens: oai_settings.openai_max_tokens,
    model: getChatCompletionModel() ?? undefined, globalVariables: extension_settings.variables?.global ?? {},
    characterId: current.characterUuid, metadata: current.chatMetadata,conversationId:target.conversationId,
    settings: getWorldInfoSettings(), globalScanData, userName: context.name1,
    extensionScanPrompts,
  }),target);
  const sorted = report.results.filter(item => item.status === 'injected').sort((a, b) => a.insertionOrder - b.insertionOrder);
  const at = position => sorted.filter(item => item.position === position && item.content).map(item => item.content);
  const worldInfoBefore = at(0).join('\n'), worldInfoAfter = at(1).join('\n');
  const worldInfoDepth = [], outletEntries = {};
  for (const item of sorted) {
    if (item.position === 4 && item.content) {
      let group = worldInfoDepth.find(group => group.depth === item.depth && group.role === item.role);
      if (!group) { group = { depth: item.depth, role: item.role, entries: [] }; worldInfoDepth.push(group); }
      group.entries.push(item.content);
    }
  }
  for (const item of [...sorted].reverse()) {
    if (item.position === 7 && item.outletName && item.content) {
      if (!Object.hasOwn(outletEntries, item.outletName)) Object.defineProperty(outletEntries, item.outletName, { value: [], enumerable: true });
      outletEntries[item.outletName].push(item.content);
    }
  }
  if (!isDryRun && activated.length) await eventSource.emit(event_types.WORLD_INFO_ACTIVATED, activated);
  return { worldInfoString: worldInfoBefore + worldInfoAfter, worldInfoBefore, worldInfoAfter,
    worldInfoExamples: sorted.filter(item => item.position === 5 || item.position === 6).map(item => ({ position: item.position === 5 ? 0 : 1, content: item.content })),
    worldInfoDepth, anBefore: at(2), anAfter: at(3), outletEntries };
}
export function syncWorldInfoControls() {
  for (const [key, value] of Object.entries(settings)) {
    const node = document.getElementById(key); if (!node || key === 'world_info') continue;
    if (typeof value === 'boolean') node.checked = value; else node.value = String(value);
  }
  for (const id of ['world_info', 'world_editor_select']) {
    const node = document.getElementById(id); if (!node) continue;
    const previous = node.selectedOptions?.[0]?.textContent;
    node.replaceChildren(new Option(id === 'world_info' ? '不绑定全局世界书' : '选择世界书', ''));
    world_names.forEach((name, index) => node.append(new Option(name, String(index), false, id === 'world_info' ? selected_world_info.includes(name) : previous === name)));
  }
  if (!controlsAttached && globalThis.jQuery) {
    controlsAttached = true;
    globalThis.jQuery(document).on('input.mc-world-info change.mc-world-info', '[data-world-info-setting]', event => {
      const node = event.target, key = node.id;
      if (Object.hasOwn(defaultSettings, key)) updateWorldInfoSettings({ [key]: typeof defaultSettings[key] === 'boolean' ? node.checked : Number(node.value) });
    }).on('change.mc-world-info', '#world_info', event => {
      const names = [...event.target.selectedOptions].filter(option => option.value !== '').map(option => world_names[Number(option.value)]).filter(Boolean);
      updateWorldInfoSettings({}, names);
      void eventSource.emit(event_types.WORLDINFO_SETTINGS_UPDATED).catch(reportError);
    }).on('change.mc-world-info', '#world_editor_select', event => selectWorldInfoEditor(world_names[Number(event.target.value)] || ''));
  }
}
await loadWorldInfoState();
`;

export const worldInfoShimSource = `export { DEFAULT_DEPTH, DEFAULT_WEIGHT, MAX_SCAN_DEPTH, METADATA_KEY, convertCharacterBook, createNewWorldInfo, deleteWorldInfo, getWorldInfoPrompt, getWorldInfoSettings, loadWorldInfo, newWorldInfoEntryTemplate, parseRegexFromString, saveWorldInfo, selected_world_info, setWorldInfoButtonClass, wi_anchor_position, world_info, world_info_include_names, world_info_logic, world_info_position, world_names, worldInfoCache, updateWorldInfoSettings, updateWorldInfoList } from '/plugin-runtime/world-info.js';`;
