import {
  useEffect,
  useRef,
  useState,
} from "react";

import type {
  CharacterDetail,
  LorebookReport,
  MemoryRetrievalReport,
  PromptBudgetReport,
} from "@mycompanion/shared";

import {
  fetchHealth,
  fetchCharacter,
  fetchConversation,
  activateBranch,
  getProviderSettings,
  listConversations,
  listPlugins,
} from "./api";
import {
  toSummary,
  type ServiceState,
} from "./components";
import { flushSharedExtensionSettings } from "./extension-settings";
import { flushWorldEditorDrafts } from "./world-editor-drafts";
import { flushComposerDrafts } from "./composer-drafts";
import { useCharacterImport } from "./hooks/useCharacterImport";
import { useCharacterSelection } from "./hooks/useCharacterSelection";
import { useChatGeneration } from "./hooks/useChatGeneration";
import { useConversations } from "./hooks/useConversations";
import { readExtensionResume, useExtensionResume, type WorkspaceView } from "./hooks/useExtensionResume";
import { usePlugins } from "./hooks/usePlugins";
import { useProviderSettings } from "./hooks/useProviderSettings";
import { LibraryView } from "./views/LibraryView";
import { ChatView } from "./views/ChatView";
import { SettingsView } from "./views/SettingsView";
import { PluginsView } from "./views/PluginsView";
import { WorldInfoPanel } from "./views/WorldInfoPanel";
import { CharacterPanel } from "./views/CharacterPanel";
import { AppSidebar } from "./views/AppSidebar";
import "./styles.css";
import { initializeUiLanguage } from "./i18n";

export function App() {
  const resume = useRef(readExtensionResume());
  const [serviceState, setServiceState] = useState<ServiceState>("checking");
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>(resume.current.view ?? "chat");
  const [regexPanelOpen, setRegexPanelOpen] = useState(false);
  const [lorebookPanelOpen, setLorebookPanelOpen] = useState(false);
  const [worldEditorOpen, setWorldEditorOpen] = useState(false);
  const [characterPanelOpen, setCharacterPanelOpen] = useState(false);
  // 最近一次世界书匹配报告（FR-LORE-003）：随 SSE 的 lorebook 事件更新，供高级查看。
  const [lastLorebookReport, setLastLorebookReport] = useState<LorebookReport | null>(null);
  // 最近一次提示词预算报告（FR-PROMPT-003）：随 SSE 的 prompt_budget 事件更新。
  const [lastPromptBudget, setLastPromptBudget] = useState<PromptBudgetReport | null>(null);
  // 最近一次记忆检索报告（FR-MEM-005）：随 SSE 的 memory 事件更新。
  const [lastMemoryReport, setLastMemoryReport] = useState<MemoryRetrievalReport | null>(null);
  // 记忆中心面板（FR-MEM-007）：聊天页右侧边栏，按当前故事加载。
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);
  const [sourceFocus, setSourceFocus] = useState<{ conversationId: string; messageId: string; revision: number } | null>(null);
  // 角色选择/故事导航共用的防竞态序号。
  const navigationRevision = useRef(0);
  useEffect(() => {
    const flush = async () => { await flushWorldEditorDrafts(); await flushComposerDrafts(); await flushSharedExtensionSettings(); };
    window.__mycompanionFlushDrafts = flush;
    return () => { if (window.__mycompanionFlushDrafts === flush) delete window.__mycompanionFlushDrafts; };
  }, []);

  useEffect(() => {
    // 外部模块（角色世界书面板）请求编辑某本书时，同时展开世界书编辑器。
    const reveal = () => setWorldEditorOpen(true);
    window.addEventListener("mycompanion:world-editor", reveal);
    return () => window.removeEventListener("mycompanion:world-editor", reveal);
  }, []);

  // 健康检查须先于各领域 hook 的挂载请求发出（与原单一挂载 effect 的请求顺序一致）。
  useEffect(() => {
    const controller = new AbortController();
    void fetchHealth(controller.signal)
      .then(() => setServiceState("online"))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setServiceState("offline");
      });
    return () => controller.abort();
  }, []);

  const characterSelection = useCharacterSelection({
    navigationRevision,
    resumeCharacterId: resume.current.characterId,
    setWorkspaceView,
    closeCharacterPanels: () => { setRegexPanelOpen(false); setLorebookPanelOpen(false); },
    clearImportState: () => characterImport.clearImportState(),
    setSuccessMessage: (message) => characterImport.setSuccessMessage(message),
  });
  useEffect(() => { if (serviceState === "online") void initializeUiLanguage().catch(() => {}); }, [serviceState]);
  const {
    characters,
    selectedCharacter,
    isLoadingCharacter,
    listError,
    handleSelectCharacter,
  } = characterSelection;

  const characterImport = useCharacterImport({
    onPreviewStart: () => setWorkspaceView("library"),
    onCommitted: (character) => {
      const summary = toSummary(character);
      characterSelection.setCharacters((current) => [
        summary,
        ...current.filter((item) => item.id !== summary.id),
      ]);
      characterSelection.setSelectedCharacter(character);
      if (character.sourceFormat === "backyard-byaf") void listConversations().then(listing => {
        conversationsState.setConversations(current => {
          const latest = new Map(current.map(item => [item.id, item]));
          const imported = listing.items.map(item => {
            const visible = latest.get(item.id);
            return visible && Date.parse(visible.updatedAt) > Date.parse(item.updatedAt) ? visible : item;
          });
          return [...imported, ...current.filter(item => !listing.items.some(incoming => incoming.id === item.id))];
        });
      }).catch(() => setRuntimeError("角色已保存，但随卡故事列表暂时无法读取；请重新打开应用后继续。"));
      const story = conversationsState.activeConversation;
      if (story?.characterId === character.id) void fetchConversation(story.id).then(updated => {
        conversationsState.setActiveConversation(current => current?.id === story.id ? updated : current);
      }).catch(() => {});
      setRegexPanelOpen(false);
      setLorebookPanelOpen(false);
    },
  });
  const {
    fileInputRef,
    previewHeadingRef,
    preview,
    draftFile,
    importError,
    importErrorDetails,
    successMessage,
    isImporting,
    isSaving,
    openFilePicker,
    clearImportState,
    handleCardFile,
    handleCommit,
  } = characterImport;

  const conversationsState = useConversations({
    navigationRevision,
    resumeConversationId: resume.current.conversationId,
    selectedCharacterId: selectedCharacter?.id,
    setWorkspaceView,
    setRuntimeError,
  });
  const {
    conversations,
    activeConversation,
    handleStartConversation,
    handleOpenConversation,
  } = conversationsState;

  const providerSettings = useProviderSettings({ setRuntimeError });
  const {
    provider,
    setProvider,
    apiKeyDraft,
    setApiKeyDraft,
    isSavingProvider,
    providerNotice,
    providerIssue,
    isConnectionReady,
    handleSaveProvider,
  } = providerSettings;

  const chat = useChatGeneration({
    initialInput: resume.current.input ?? "",
    activeConversation,
    setActiveConversation: conversationsState.setActiveConversation,
    setConversations: conversationsState.setConversations,
    setRuntimeError,
    providerModel: provider?.model,
    setLastLorebookReport,
    setLastPromptBudget,
    setLastMemoryReport,
  });
  const {
    messageListRef,
    chatInput,
    setChatInput,
    isGenerating,
    generationControlsBusy,
    editingMessageId,
    editingDraft,
    setEditingDraft,
    handleSendMessage,
    handleRegenerate,
    handleContinue,
    handleImpersonate,
    beginEditMessage,
    cancelEditMessage,
    saveEditMessage,
    handleDeleteMessage,
  } = chat;

  const pluginsState = usePlugins({
    setRuntimeError,
  });
  const {
    plugins,
    activeCommands,
    handlePluginToggle,
    handlePluginUninstall,
  } = pluginsState;

  useExtensionResume({
    workspaceView,
    conversationId: activeConversation?.id,
    characterId: selectedCharacter?.id,
    chatInput,
  });

  const handleCharacterSaved = (updated: CharacterDetail): void => {
    const summary = toSummary(updated);
    characterSelection.setCharacters(current => current.map(item => item.id === summary.id ? summary : item));
    characterSelection.setSelectedCharacter(current => current?.id === updated.id ? updated : current);
    if (activeConversation?.characterId === updated.id) {
      conversationsState.setActiveConversation(current => current?.characterId === updated.id ? { ...current, characterName: updated.name } : current);
    }
  };

  // 对话页空态点角色直接开聊：先取详情保持角色库选中态，再为该角色建故事。
  const handleChatWithCharacter = async (id: string): Promise<void> => {
    const revision = ++navigationRevision.current;
    setRuntimeError(null);
    try {
      const character = await fetchCharacter(id);
      if (revision !== navigationRevision.current) return;
      characterSelection.setSelectedCharacter(character);
      await conversationsState.handleStartConversation(id);
    } catch (error) {
      if (revision === navigationRevision.current) {
        setRuntimeError(error instanceof Error ? error.message : "暂时无法读取角色详情。");
      }
    }
  };

  useEffect(() => {
    if (workspaceView === "chat") {
      void listConversations()
        .then((result) => conversationsState.setConversations(result.items))
        .catch(() => setRuntimeError("暂时无法读取故事列表。"));
      void listPlugins()
        .then((result) => pluginsState.setPlugins(result.items))
        .catch(() => undefined);
    }
    if (workspaceView === "settings" && !provider) {
      void getProviderSettings()
        .then(setProvider)
        .catch(() => setRuntimeError("暂时无法读取模型设置。"));
    }
    if (workspaceView === "plugins") {
      void listPlugins()
        .then((result) => pluginsState.setPlugins(result.items))
        .catch(() => setRuntimeError("暂时无法读取插件列表。"));
    }
  }, [workspaceView, provider]);

  return (
    <div className={`desktop-shell ${isSidebarCollapsed ? "desktop-shell--sidebar-collapsed" : ""}`}>
      <AppSidebar
        busy={isImporting || isSaving}
        collapsed={isSidebarCollapsed}
        conversationCount={conversations.length}
        characters={characters}
        fileInputRef={fileInputRef}
        isImporting={isImporting}
        isLoadingCharacter={isLoadingCharacter}
        listError={listError}
        memoryInjectedCount={lastMemoryReport?.injectedCount ?? ""}
        memoryPanelOpen={memoryPanelOpen}
        onCollapseToggle={() => setIsSidebarCollapsed((value) => !value)}
        onCardFile={(event) => void handleCardFile(event)}
        onChatNav={() => { setMemoryPanelOpen(false); setWorkspaceView("chat"); }}
        onMemoryNav={() => { if (workspaceView === "chat" && memoryPanelOpen) { setMemoryPanelOpen(false); } else { setMemoryPanelOpen(true); setWorkspaceView("chat"); } }}
        onNavigate={setWorkspaceView}
        onOpenFilePicker={openFilePicker}
        onSelectCharacter={(id) => void handleSelectCharacter(id)}
        pluginCount={plugins.length}
        selectedCharacterId={selectedCharacter?.id}
        serviceState={serviceState}
        view={workspaceView}
      />

      {workspaceView === "library" ? <LibraryView
        batchItems={characterImport.batchItems}
        onSkipFile={() => void characterImport.handleSkipFile()}
        onRetryFile={id => void characterImport.handleRetryFile(id)}
        onOpenDuplicate={id => void characterImport.handleOpenDuplicate(id)}
        onReplaceDuplicate={(id, updatedAt) => void handleCommit("replace", id, updatedAt)}
        onRefreshPreview={() => void characterImport.handleRefreshPreview()}
        onOpenSettings={() => setWorkspaceView("settings")}
        connectionReady={isConnectionReady}
        onEditCharacter={() => { if (selectedCharacter) setCharacterPanelOpen(true); }}
        draftFileName={draftFile?.name ?? null}
        importError={importError}
        importErrorDetails={importErrorDetails}
        isLoadingCharacter={isLoadingCharacter}
        isImporting={isImporting}
        isSaving={isSaving}
        listError={listError}
        onCancelImport={clearImportState}
        onCommit={() => void handleCommit()}
        onOpenFilePicker={openFilePicker}
        onSelectCharacter={(id) => void handleSelectCharacter(id)}
        onStartConversation={() => void handleStartConversation()}
        preview={preview}
        previewHeadingRef={previewHeadingRef}
        regexPanelOpen={regexPanelOpen}
        onRegexPanelToggle={() => setRegexPanelOpen((value) => !value)}
        lorebookPanelOpen={lorebookPanelOpen}
        onLorebookPanelToggle={() => setLorebookPanelOpen((value) => !value)}
        worldEditorOpen={worldEditorOpen}
        onWorldEditorToggle={() => setWorldEditorOpen((value) => !value)}
        selectedCharacter={selectedCharacter}
        successMessage={successMessage}
        characters={characters}
      /> : null}
      <div className="workspace-view" hidden={workspaceView !== "chat"}><ChatView
        generationControlsBusy={generationControlsBusy || conversationsState.branchBusy}
        activeCommands={activeCommands}
        activeConversation={activeConversation}
        chatInput={chatInput}
        characters={characters}
        connectionLabel={isConnectionReady ? (provider?.model || "默认模型") : "未连接模型"}
        conversations={conversations}
        onChatWithCharacter={(id) => void handleChatWithCharacter(id)}
        onOpenImport={openFilePicker}
        editingDraft={editingDraft}
        editingMessageId={editingMessageId}
        isGenerating={isGenerating}
        messageListRef={messageListRef}
        lastLorebookReport={lastLorebookReport}
        lastMemoryReport={lastMemoryReport}
        lastPromptBudget={lastPromptBudget}
        memoryPanelOpen={memoryPanelOpen}
        sourceFocus={sourceFocus}
        onOpenMemorySource={(id, message) => void (async () => {
          if (generationControlsBusy) return;
          const revision = ++navigationRevision.current; setRuntimeError(null);
          try {
            let conversation = await fetchConversation(id);
            if (revision !== navigationRevision.current) return;
            if (!conversation.messages.some(item => item.id === message.id)) conversation = await activateBranch(id, message.branchId);
            if (revision !== navigationRevision.current) return;
            if (!conversation.messages.some(item => item.id === message.id)) throw new Error("来源消息已删除或不可访问。");
            conversationsState.setActiveConversation(conversation); setWorkspaceView("chat");
            setSourceFocus({ conversationId: id, messageId: message.id, revision });
          } catch (cause) { if (revision === navigationRevision.current) setRuntimeError(cause instanceof Error ? cause.message : "无法打开来源消息。"); }
        })()}
        onCancelEdit={cancelEditMessage}
        onMemoryPanelToggle={() => setMemoryPanelOpen((value) => !value)}
        onChatInput={setChatInput}
        onDeleteMessage={(id) => void handleDeleteMessage(id)}
        onEditMessage={beginEditMessage}
        onEditingDraft={setEditingDraft}
        onGoToLibrary={() => setWorkspaceView("library")}
        onOpenConversation={(id) => void handleOpenConversation(id)}
        onOpenSettings={() => setWorkspaceView("settings")}
        onRegenerate={() => void handleRegenerate()}
        onContinue={() => void handleContinue()}
        onImpersonate={() => void handleImpersonate()}
        onActivateBranch={conversationsState.handleActivateBranch}
        onSwiped={(id) => void (async () => {
          const updated = await fetchConversation(id);
          conversationsState.setActiveConversation(current => current?.id === id ? updated : current);
        })()}
        onSaveEdit={(id) => void saveEditMessage(id)}
        onSendMessage={(input) => void handleSendMessage(input)}
        onStopGeneration={() => { void chat.handleStopGeneration(); }}
        runtimeError={runtimeError}
      /></div>
      <div hidden={workspaceView !== "settings"}><SettingsView
        applicationBusy={generationControlsBusy}
        apiKeyDraft={apiKeyDraft}
        isSavingProvider={isSavingProvider}
        onApiKeyDraft={setApiKeyDraft}
        onProviderField={(patch) => setProvider((current) => current ? { ...current, ...patch } : current)}
        onSave={() => void handleSaveProvider(false)}
        onSaveAndTest={() => void handleSaveProvider(true)}
        provider={provider}
        providerNotice={providerNotice}
        providerIssue={providerIssue}
        isConnectionReady={isConnectionReady}
        selectedCharacterName={selectedCharacter?.name}
        onContinue={() => { if (activeConversation) setWorkspaceView("chat"); else if (selectedCharacter) void handleStartConversation(); else setWorkspaceView("chat"); }}
        runtimeError={runtimeError}
      /></div>
      {workspaceView === "plugins" ? <PluginsView
        onPluginToggle={(plugin) => void handlePluginToggle(plugin)}
        onPluginUninstall={(id) => void handlePluginUninstall(id)}
        plugins={plugins}
        runtimeError={runtimeError}
      /> : null}
      <WorldInfoPanel open={worldEditorOpen} online={serviceState === "online"} character={selectedCharacter} onClose={() => setWorldEditorOpen(false)} />
      <CharacterPanel open={characterPanelOpen} online={serviceState === "online"} character={selectedCharacter} onSaved={handleCharacterSaved} onClose={() => setCharacterPanelOpen(false)} />
    </div>
  );
}
