import { mergeJsonChanges, type WorldInfoDocument } from "@mycompanion/shared";
import { flushSharedExtensionSettings, loadSharedExtensionSettings, saveSharedExtensionSettingsDebounced } from "./extension-settings";

export interface WorldEditorDraft { base: WorldInfoDocument; document: WorldInfoDocument }
export interface WorldDraftStore {
  read(name: string): WorldEditorDraft | undefined;
  selected(): string;
  select(name: string): void;
  write(name: string, draft: WorldEditorDraft): void;
  remove(name: string): void;
  merge(base: WorldInfoDocument, draft: WorldInfoDocument, saved: WorldInfoDocument): WorldInfoDocument;
  flush(): Promise<void>;
}
let pending: Promise<WorldDraftStore> | undefined;

// Use the profile settings writer: Electron's service port changes between
// launches, so origin-scoped browser storage cannot protect a restart.
export function loadWorldDraftStore(): Promise<WorldDraftStore> {
  return pending ??= (async () => {
    const settings = await loadSharedExtensionSettings();
    const root = settings.__mycompanion_editor_drafts ??= {};
    const data = root as { worlds?: Record<string, WorldEditorDraft>; worldSelected?: string };
    data.worlds ??= {};
    const store: WorldDraftStore = {
      read: name => Object.hasOwn(data.worlds!, name) ? structuredClone(data.worlds![name]) : undefined,
      selected: () => data.worldSelected ?? "",
      select: name => { data.worldSelected = name; saveSharedExtensionSettingsDebounced(); },
      write: (name, draft) => {
        Object.defineProperty(data.worlds!, name, { value: structuredClone(draft), enumerable: true, configurable: true, writable: true });
        saveSharedExtensionSettingsDebounced();
      },
      remove: name => { delete data.worlds![name]; saveSharedExtensionSettingsDebounced(); },
      merge: (base, draft, saved) => mergeJsonChanges(base, draft, saved) as WorldInfoDocument,
      flush: () => flushSharedExtensionSettings(),
    };
    return store;
  })().catch(error => { pending = undefined; throw error; });
}

export async function flushWorldEditorDrafts(): Promise<void> {
  if (pending) await (await pending).flush();
}
