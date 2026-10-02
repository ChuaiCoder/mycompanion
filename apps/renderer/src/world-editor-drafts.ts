import type { WorldInfoDocument } from "@mycompanion/shared";
import { loadExtensionHost } from "./ExtensionHost";

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

// Use the existing profile settings writer: Electron's service port changes
// between launches, so origin-scoped browser storage cannot protect restart.
export function loadWorldDraftStore(): Promise<WorldDraftStore> {
  return pending ??= (async () => {
    await loadExtensionHost();
    const settingsPath = "/plugin-runtime/settings.js";
    const settings = await import(/* @vite-ignore */ settingsPath) as {
      extension_settings: Record<string, unknown>;
      loadExtensionSettings(): Promise<void>;
      saveSettingsDebounced(): void;
      saveSettings(): Promise<void>;
    };
    const mergePath = "/plugin-runtime/chat-merge.js";
    const { mergeJsonChanges } = await import(/* @vite-ignore */ mergePath);
    await settings.loadExtensionSettings();
    const root = settings.extension_settings.__mycompanion_editor_drafts ??= {};
    const data = root as { worlds?: Record<string, WorldEditorDraft>; worldSelected?: string };
    data.worlds ??= {};
    const store: WorldDraftStore = {
      read: name => Object.hasOwn(data.worlds!, name) ? structuredClone(data.worlds![name]) : undefined,
      selected: () => data.worldSelected ?? "",
      select: name => { data.worldSelected = name; settings.saveSettingsDebounced(); },
      write: (name, draft) => {
        Object.defineProperty(data.worlds!, name, { value: structuredClone(draft), enumerable: true, configurable: true, writable: true });
        settings.saveSettingsDebounced();
      },
      remove: name => { delete data.worlds![name]; settings.saveSettingsDebounced(); },
      merge: (base, draft, saved) => mergeJsonChanges(base, draft, saved) as WorldInfoDocument,
      flush: () => settings.saveSettings(),
    };
    return store;
  })().catch(error => { pending = undefined; throw error; });
}

export async function flushWorldEditorDrafts(): Promise<void> {
  if (pending) await (await pending).flush();
}
