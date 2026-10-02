import type { NativeGenerationOptions } from "../api";
import type { NativeGenerationResult } from "./useChatGeneration";
import { useMemo, useRef, type Dispatch, type SetStateAction } from "react";
import { flushSync } from "react-dom";
import { toExtensionMessage } from "@mycompanion/shared";

import type {
  CharacterDetail,
  CharacterSummary,
  ChatMessage,
  CodePlugin,
  CodePluginContribution,
  ConversationDetail,
  ConversationSummary,
} from "@mycompanion/shared";

import {
  ApiRequestError,
  createConversation,
  fetchCharacter,
  fetchConversation,
  listCharacters,
  listConversations,
  streamQuietGeneration,
} from "../api";
import { useExtensionHost, type PluginHostContext } from "../ExtensionHost";
import type { WorkspaceView } from "./useExtensionResume";

// 扩展宿主桥接：把当前聊天/角色状态注入插件宿主上下文，
// 并把宿主的生成/选角/刷新/渲染回调接回 App 的状态流。
export function useExtensionHostBridge(deps: {
  online: boolean;
  activeConversation: ConversationDetail | null;
  selectedCharacter: CharacterDetail | null;
  characters: CharacterSummary[];
  codePlugins: CodePlugin[];
  isGenerating: boolean;
  isNativeGenerating: boolean;
  generationControlsBusy: boolean;
  navigationRevision: { current: number };
  characterRefreshRevision: { current: number };
  streamControllerRef: { current: AbortController | null };
  setExtensionGenerating: (value: boolean) => void;
  setActiveConversation: Dispatch<SetStateAction<ConversationDetail | null>>;
  setConversations: Dispatch<SetStateAction<ConversationSummary[]>>;
  setCharacters: Dispatch<SetStateAction<CharacterSummary[]>>;
  setSelectedCharacter: Dispatch<SetStateAction<CharacterDetail | null>>;
  setChatInput: (value: string) => void;
  setWorkspaceView: (view: WorkspaceView) => void;
  setCharacterPanelOpen: (open: boolean) => void;
  setOpenedPluginId: (id: string | null) => void;
  clearImportState: () => void;
  handleStopGeneration: () => Promise<void>;
  handleSendMessage: (input?: string, options?: NativeGenerationOptions) => Promise<NativeGenerationResult>;
  handleRegenerate: (options?: NativeGenerationOptions) => Promise<NativeGenerationResult>;
  handleCodePluginStatus: (id: string, status: string) => void;
  handleCodePluginContributions: (id: string, contribution: CodePluginContribution) => Promise<void>;
}): void {
  const {
    online,
    activeConversation,
    selectedCharacter,
    characters,
    codePlugins,
    isGenerating,
    isNativeGenerating,
    generationControlsBusy,
    navigationRevision,
    characterRefreshRevision,
    streamControllerRef,
    setExtensionGenerating,
    setActiveConversation,
    setConversations,
    setCharacters,
    setSelectedCharacter,
    setChatInput,
    setWorkspaceView,
    setCharacterPanelOpen,
    setOpenedPluginId,
    clearImportState,
    handleStopGeneration,
    handleSendMessage,
    handleRegenerate,
    handleCodePluginStatus,
    handleCodePluginContributions,
  } = deps;
  const navigationState = useRef({ activeConversation, isGenerating });
  navigationState.current = { activeConversation, isGenerating };

  const pluginHostContext: PluginHostContext = useMemo(() => ({
    conversationId: activeConversation?.id ?? null,
    characterId: activeConversation?.characterId ?? selectedCharacter?.id ?? null,
    branchId: activeConversation?.activeBranchId ?? null,
    chatMetadata: activeConversation?.chatMetadata ?? {},
    name1: "User",
    name2: activeConversation?.characterName ?? selectedCharacter?.name ?? "",
    isGenerating,
    nativeGenerating: isNativeGenerating,
    generationControlsBusy,
    chat: activeConversation?.messages.map(message => toExtensionMessage(message, activeConversation.characterName)) ?? [],
    characters: characters.map(character => ({ id: character.id, name: character.name, updatedAt: character.updatedAt })),
    extensionTypes: Object.fromEntries(codePlugins.map(plugin => [`third-party/${plugin.id}`, "local" as const])),
  }), [activeConversation, selectedCharacter, codePlugins, characters, isGenerating, isNativeGenerating, generationControlsBusy]);
  useExtensionHost(pluginHostContext, {
    syncMacroMetadata: (id, metadata) => flushSync(() => setActiveConversation(current => current?.id === id
      ? { ...current, chatMetadata: structuredClone(metadata) } : current)),
    generationBusy: value => flushSync(() => setExtensionGenerating(value)),
    stopGeneration: () => {
      const controller = streamControllerRef.current;
      if (!controller || controller.signal.aborted) return false;
      void handleStopGeneration();
      return true;
    },
    generateQuietNative: options => {
      if (!activeConversation) throw new Error("请先打开一个故事，再运行后台生成。");
      return streamQuietGeneration(activeConversation.id, options);
    },
    generateNative: async (value, options) => {
      const result = await handleSendMessage(value, options);
      if (result.status === "failed") throw result.error;
      return result.status === "complete" ? result.text : undefined;
    },
    regenerateNative: async options => {
      const result = await handleRegenerate(options);
      if (result.status === "failed") throw result.error;
      return result.status === "complete" ? result.text : undefined;
    },
    clearCharacterSelection: async () => {
      const revision = ++navigationRevision.current;
      const listing = await listConversations();
      if (revision !== navigationRevision.current) return;
      flushSync(() => {
        setActiveConversation(null); setSelectedCharacter(null); setConversations(listing.items);
        setChatInput(""); setCharacterPanelOpen(false); setWorkspaceView("library"); clearImportState();
      });
    },
    selectCharacter: async (id, switchMenu) => {
      const revision = ++navigationRevision.current;
      const superseded = () => revision !== navigationRevision.current || navigationState.current.isGenerating;
      const character = await fetchCharacter(id);
      if (superseded()) return;
      if (character.deletedAt) throw new Error("角色已删除。");
      const listing = await listConversations();
      if (superseded()) return;
      const existing = listing.items.find(item => item.characterId === id);
      const active = navigationState.current.activeConversation;
      const conversation = active?.characterId === id ? active
        : existing ? await fetchConversation(existing.id) : await createConversation(id);
      if (superseded()) return;
      flushSync(() => {
        setSelectedCharacter(character);
        // A same-role refresh must not replace edits/generation that arrived during reads.
        setActiveConversation(current => current?.characterId === id ? { ...current, characterName: character.name } : conversation);
        setConversations(current => [conversation, ...current.filter(item => item.id !== conversation.id)]);
        if (active?.characterId !== id) setChatInput("");
        if (switchMenu) { setWorkspaceView("chat"); setCharacterPanelOpen(true); }
        clearImportState();
      });
    },
    refreshCharacters: async () => {
      const revision = ++characterRefreshRevision.current;
      const selectedId = selectedCharacter?.id, activeId = activeConversation?.characterId;
      const loadCharacter = async (id: string) => {
        try { return await fetchCharacter(id); }
        catch (error) { if (error instanceof ApiRequestError && error.code === "CHARACTER_NOT_FOUND") return null; throw error; }
      };
      const [listing, selected, active] = await Promise.all([
        listCharacters(), selectedId ? loadCharacter(selectedId) : null,
        activeId ? loadCharacter(activeId) : null,
      ]);
      if (revision !== characterRefreshRevision.current) return;
      flushSync(() => {
        setCharacters(listing.items);
        setSelectedCharacter(current => current?.id === selectedId ? selected : current);
        if (activeId) setActiveConversation(current => current?.characterId !== activeId ? current : active ? { ...current, characterName: active.name } : null);
      });
    },
    status: handleCodePluginStatus, contributions: handleCodePluginContributions, input: setChatInput,
    openSettings: () => { setWorkspaceView("plugins"); setOpenedPluginId("all"); },
    renderChat: (conversation, state, reloaded) => {
      flushSync(() => setActiveConversation(current => {
        if (current?.id !== conversation.id || (!reloaded && current.activeBranchId !== conversation.activeBranchId)) return current;
        const known = new Map([...conversation.messages, ...current.messages].map(message => [message.id, message]));
        const messages = state.messages.map((raw, index): ChatMessage => {
          const previous = known.get(raw.id);
          const { id, mes, is_user, role: _role, content: _content, status, ...extensionData } = raw;
          return { ...previous, id, conversationId: conversation.id, branchId: conversation.activeBranchId,
            parentMessageId: state.messages[index - 1]?.id ?? null, role: is_user ? "user" : "assistant", content: mes,
            status: status === "streaming" || status === "stopped" || status === "failed" ? status : "complete",
            createdAt: previous?.createdAt ?? new Date().toISOString(), extensionData };
        });
        return { ...conversation, messages, chatMetadata: state.metadata, messageCount: messages.length, lastMessagePreview: messages.at(-1)?.content.slice(0, 120) ?? "" };
      }));
    },
  }, online);
}
