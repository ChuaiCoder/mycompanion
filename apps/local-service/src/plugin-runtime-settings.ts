// A single mutable settings object is shared by all extensions in this
// document. Hydrate before importing extension entrypoints; serialize writes.
export const extensionSettingsSource = String.raw`
import {applyMacroVariableChange} from '/plugin-runtime/macro-variable-sync.js';
import {isMacroDraftActive} from '/plugin-runtime/macro-draft.js';
const root = window;
const key = Symbol.for('MyCompanion.extensionSettings');
const shared = root[key] ??= { settings: {}, ready: null, queue: Promise.resolve(), timer: null, listeners: new Set() };
const participants = new Map();
const clone=value=>JSON.parse(JSON.stringify(value));
shared.failedPatches??=[];
// Capture synchronously at save time; execute each domain's immutable snapshot
// within the same ordered settings queue. Notifications run outside the queue.
export const registerSettingsParticipant = (key, capture) => { participants.set(key, capture); return () => participants.delete(key); };
let saveErrorHandler = error => console.error(error);
export const setSettingsErrorHandler = handler => { saveErrorHandler = handler; };
export const extension_settings = shared.settings;
export async function loadExtensionSettings() {
  if (!shared.ready) {
    shared.ready = (async () => {
      const response = await fetch('/api/extensions/settings');
      if (!response.ok) throw new Error('Extension settings could not be loaded: ' + response.status);
      const { extensionSettings } = await response.json();
      for (const key of Object.keys(extension_settings)) delete extension_settings[key];
      for (const [key, value] of Object.entries(extensionSettings)) Object.defineProperty(extension_settings, key, { value, writable: true, enumerable: true, configurable: true });
      // Tavern starts from this default even when an older/imported settings
      // document has no variables namespace. The original Helper reads it
      // directly before any slash command has initialized the lazy store.
      (extension_settings.variables ??= {}).global ??= {};
      shared.baseline=clone(extension_settings);
    })().catch(error => { shared.ready = null; throw error; });
  }
  return shared.ready;
}
export function onExtensionSettingsSaved(callback) {
  shared.listeners.add(callback);
  return () => shared.listeners.delete(callback);
}
export function saveSettings() {
  if(isMacroDraftActive())return Promise.resolve();
  root.clearTimeout(shared.timer); shared.timer = null;
  // Capture at call time so later edits cannot mutate an already queued save.
  const saves = [...participants.values()].map(capture => capture());
  const snapshot=clone(extension_settings),patch={base:clone(shared.baseline??{}),next:snapshot};
  shared.baseline=clone(snapshot);
  const operation = shared.queue.catch(() => {}).then(async () => {
    try{
      const body=JSON.stringify({extensionSettings:snapshot,patches:[...shared.failedPatches,patch]});
      const response = await fetch('/api/extensions/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
      if (!response.ok) throw new Error('Extension settings could not be saved: ' + response.status + ' ' + await response.text());
      shared.failedPatches=[];
    }catch(error){shared.failedPatches.push(patch);throw error;}
    for (const save of saves) await save();
  });
  shared.queue = operation;
  return operation.then(async () => {
    for (const callback of shared.listeners) {
      try { await callback(); } catch (error) { console.error('Extension settings listener failed', error); }
    }
  });
}
export function applyGlobalMacroChanges(changes){
  for(const change of changes.filter(item=>item.scope==='global')){
    applyMacroVariableChange((extension_settings.variables??={}).global??={},change);
    if(shared.baseline)applyMacroVariableChange((shared.baseline.variables??={}).global??={},change);
  }
}
export function saveSettingsDebounced() {
  if(isMacroDraftActive())return;
  root.clearTimeout(shared.timer);
  shared.timer = root.setTimeout(() => {
    void saveSettings().catch(error => {
      console.error(error);
      saveErrorHandler(error);
    });
  }, 300);
}
`;
