import type { NativeGenerationOptions, QuietGenerationOptions } from "./api";
import { useEffect, useLayoutEffect, useRef } from "react";
import type { CodePluginContribution, ConversationDetail, ExtensionChatMessage, ExtensionChatState } from "@mycompanion/shared";
import { DOMPurify, messageFormatting, reloadMarkdownProcessor, configureRegexFormatting } from "./message-rendering";
import { messageSurface } from "./message-surface";

export interface PluginHostContext {
  conversationId: string | null;
  characterId: string | null;
  branchId: string | null;
  chatMetadata: Record<string, unknown>;
  name1: string;
  name2: string;
  isGenerating: boolean;
  nativeGenerating: boolean;
  generationControlsBusy: boolean;
  chat: ExtensionChatMessage[];
  characters: Array<{ id: string; name: string; updatedAt: string }>;
  extensionTypes: Record<string, "local" | "global">;
}
interface HostCallbacks {
  syncMacroMetadata(conversationId: string, metadata: Record<string, unknown>): void;
  generationBusy(value: boolean): void;
  stopGeneration(): boolean;
  generateNative(value: string, options?: NativeGenerationOptions): Promise<string | undefined>;
  regenerateNative(options?: NativeGenerationOptions): Promise<string | undefined>;
  continueNative(options?: NativeGenerationOptions): Promise<string | undefined>;
  impersonateNative(options?: NativeGenerationOptions): Promise<string | undefined>;
  generateQuietNative(options: QuietGenerationOptions): Promise<string | undefined>;
  clearCharacterSelection(): Promise<void>;
  selectCharacter(id: string, switchMenu: boolean): Promise<void>;
  refreshCharacters(): Promise<void>;
  status(id: string, status: string): void;
  contributions(id: string, value: CodePluginContribution): Promise<void>;
  input(value: string): void;
  openSettings(): void;
  renderChat(conversation: ConversationDetail, state: ExtensionChatState, reloaded?: boolean): void;
}
interface HostRuntime {
  stopGeneration(): boolean;
  runSlashCommand(input: string): Promise<{ pipe: string; isError: boolean; errorMessage: string } | null>;
  editCharacter(id: string): Promise<void>;
  connect(callbacks: HostCallbacks & { messageSurface: typeof messageSurface; messageFormatting: typeof messageFormatting; reloadMarkdownProcessor: typeof reloadMarkdownProcessor; configureRegexFormatting: typeof configureRegexFormatting }): void;
  updateContext(context: PluginHostContext): void;
  start(): Promise<void>;
  flush(): Promise<void>;
  callHook(id: string, hook: string): Promise<boolean>;
}
let runtimePromise: Promise<HostRuntime> | undefined;
let loadedRuntime: HostRuntime | undefined;
declare global { interface Window { __mycompanionFlushDrafts?: () => Promise<void> } }
Object.assign(globalThis, { DOMPurify });
export function loadExtensionHost(): Promise<HostRuntime> {
  return runtimePromise ??= (async () => {
    const libraries = "/plugin-runtime/libraries.js";
    await import(/* @vite-ignore */ libraries);
    const path = "/plugin-runtime/desktop-host.js";
    loadedRuntime = await import(/* @vite-ignore */ path) as HostRuntime;
    return loadedRuntime;
  })();
}
export async function flushLoadedExtensionHost(): Promise<void> { await loadedRuntime?.flush(); }
export function reloadForExtensions(): void { window.location.reload(); }

export function useExtensionHost(context: PluginHostContext, callbacks: HostCallbacks, online: boolean): void {
  const current = useRef({ context, callbacks }); current.current = { context, callbacks };
  const runtime = useRef<HostRuntime | null>(null);
  useEffect(() => {
    if (!online) return;
    let disposed = false;
    void loadExtensionHost().then(async host => {
      if (disposed) return;
      runtime.current = host;
      host.connect({
        syncMacroMetadata: (id, metadata) => current.current.callbacks.syncMacroMetadata(id, metadata),
        generationBusy: value => current.current.callbacks.generationBusy(value),
        stopGeneration: () => current.current.callbacks.stopGeneration(),
        generateNative: (value, options) => current.current.callbacks.generateNative(value, options),
        regenerateNative: options => current.current.callbacks.regenerateNative(options),
        continueNative: options => current.current.callbacks.continueNative(options),
        impersonateNative: options => current.current.callbacks.impersonateNative(options),
        generateQuietNative: options => current.current.callbacks.generateQuietNative(options),
        clearCharacterSelection: () => current.current.callbacks.clearCharacterSelection(),
        selectCharacter: (id, switchMenu) => current.current.callbacks.selectCharacter(id, switchMenu),
        refreshCharacters: () => current.current.callbacks.refreshCharacters(),
        messageFormatting, reloadMarkdownProcessor, messageSurface, configureRegexFormatting,
        status: (id, status) => current.current.callbacks.status(id, status),
        contributions: (id, value) => current.current.callbacks.contributions(id, value),
        input: value => current.current.callbacks.input(value),
        openSettings: () => current.current.callbacks.openSettings(),
        renderChat: (conversation, state, reloaded) => current.current.callbacks.renderChat(conversation, state, reloaded),
      });
      host.updateContext(current.current.context);
      await host.start();
    }).catch(error => current.current.callbacks.status("host", error instanceof Error ? error.message : String(error)));
    return () => { disposed = true; };
  }, [online]);
  // Stream assistant_start is committed with flushSync, so the following macro
  // RPC must observe the accepted branch and its messages during that commit.
  useLayoutEffect(() => { runtime.current?.updateContext(context); }, [context]);
}
