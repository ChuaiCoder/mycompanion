import { loadExtensionHost } from "./ExtensionHost";
export interface ComposerDraftStore { read(id: string): string | undefined; write(id: string, value: string): void; flush(): Promise<void> }
let pending: Promise<ComposerDraftStore> | undefined;
export function loadComposerDraftStore(): Promise<ComposerDraftStore> {
  return pending ??= (async () => {
    await loadExtensionHost();
    const path = "/plugin-runtime/settings.js";
    const settings = await import(/* @vite-ignore */ path);
    await settings.loadExtensionSettings();
    const root = settings.extension_settings.__mycompanion_editor_drafts ??= {};
    const data = root.composers ??= {};
    return {
      read: (id: string) => typeof data[id] === "string" ? data[id] : undefined,
      write: (id: string, value: string) => { Object.defineProperty(data, id, { value, writable: true, enumerable: true, configurable: true }); settings.saveSettingsDebounced(); },
      flush: () => settings.saveSettings(),
    };
  })().catch(error => { pending = undefined; throw error; });
}
export async function flushComposerDrafts(): Promise<void> { if (pending) await (await pending).flush(); }
