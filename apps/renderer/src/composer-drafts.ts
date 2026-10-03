import { flushSharedExtensionSettings, loadSharedExtensionSettings, saveSharedExtensionSettingsDebounced } from "./extension-settings";

export interface ComposerDraftStore { read(id: string): string | undefined; write(id: string, value: string): void; flush(): Promise<void> }
let pending: Promise<ComposerDraftStore> | undefined;
export function loadComposerDraftStore(): Promise<ComposerDraftStore> {
  return pending ??= (async () => {
    const settings = await loadSharedExtensionSettings();
    const root = settings.__mycompanion_editor_drafts ??= {};
    const data = (root as Record<string, unknown>).composers ??= {};
    const composers = data as Record<string, unknown>;
    return {
      read: (id: string) => typeof composers[id] === "string" ? composers[id] as string : undefined,
      write: (id: string, value: string) => { Object.defineProperty(composers, id, { value, writable: true, enumerable: true, configurable: true }); saveSharedExtensionSettingsDebounced(); },
      flush: () => flushSharedExtensionSettings(),
    };
  })().catch(error => { pending = undefined; throw error; });
}
export async function flushComposerDrafts(): Promise<void> { if (pending) await (await pending).flush(); }
