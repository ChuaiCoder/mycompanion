import type {
  Dispatch,
  SetStateAction,
} from "react";

import type {
  CharacterDetail,
  LorebookReport,
  MemoryRetrievalReport,
  PromptBudgetReport,
} from "@mycompanion/shared";

import {
  fetchCharacter,
  fetchConversation,
  activateBranch,
} from "../api";
import {
  toSummary,
  type ServiceState,
} from "../components";
import type { useCharacterImport } from "../hooks/useCharacterImport";
import type { useCharacterSelection } from "../hooks/useCharacterSelection";
import type { useChatGeneration } from "../hooks/useChatGeneration";
import type { useConversations } from "../hooks/useConversations";
import type { WorkspaceView } from "../hooks/useExtensionResume";
import type { ModelConnection } from "../hooks/useModelConnection";
import type { usePlugins } from "../hooks/usePlugins";
import type { useProviderSettings } from "../hooks/useProviderSettings";
import { LibraryView } from "./LibraryView";
import { ChatView } from "./ChatView";
import { SettingsView } from "./SettingsView";
import { PluginsView } from "./PluginsView";
import { MemoryView } from "./MemoryView";
import { WorldInfoPanel } from "./WorldInfoPanel";
import { CharacterPanel } from "./CharacterPanel";
import { AppSidebar } from "./AppSidebar";

type SourceFocus = { conversationId: string; messageId: string; revision: number } | null;

// 布局装配层：App 负责钩子编排与数据流，本组件只做视图组合与交互回调。
// 钩子返回对象整体透传，避免逐字段 props 转手的重复样板。
export interface AppLayoutProps {
  serviceState: ServiceState;
  /** 模型连通性：侧栏状态点显示它，与本地服务可达性分开。 */
  modelConnection: ModelConnection;
  runtimeError: string | null;
  setRuntimeError: Dispatch<SetStateAction<string | null>>;
  isSidebarCollapsed: boolean;
  setIsSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
  workspaceView: WorkspaceView;
  setWorkspaceView: Dispatch<SetStateAction<WorkspaceView>>;
  regexPanelOpen: boolean;
  setRegexPanelOpen: Dispatch<SetStateAction<boolean>>;
  lorebookPanelOpen: boolean;
  setLorebookPanelOpen: Dispatch<SetStateAction<boolean>>;
  worldEditorOpen: boolean;
  setWorldEditorOpen: Dispatch<SetStateAction<boolean>>;
  characterPanelOpen: boolean;
  setCharacterPanelOpen: Dispatch<SetStateAction<boolean>>;
  lastLorebookReport: LorebookReport | null;
  lastPromptBudget: PromptBudgetReport | null;
  lastMemoryReport: MemoryRetrievalReport | null;
  memoryPanelOpen: boolean;
  setMemoryPanelOpen: Dispatch<SetStateAction<boolean>>;
  sourceFocus: SourceFocus;
  setSourceFocus: Dispatch<SetStateAction<SourceFocus>>;
  navigationRevision: { current: number };
  characterSelection: ReturnType<typeof useCharacterSelection>;
  characterImport: ReturnType<typeof useCharacterImport>;
  conversationsState: ReturnType<typeof useConversations>;
  providerSettings: ReturnType<typeof useProviderSettings>;
  chat: ReturnType<typeof useChatGeneration>;
  pluginsState: ReturnType<typeof usePlugins>;
}

export function AppLayout(props: AppLayoutProps) {
  const {
    serviceState,
    modelConnection,
    runtimeError,
    setRuntimeError,
    isSidebarCollapsed,
    setIsSidebarCollapsed,
    workspaceView,
    setWorkspaceView,
    regexPanelOpen,
    setRegexPanelOpen,
    lorebookPanelOpen,
    setLorebookPanelOpen,
    worldEditorOpen,
    setWorldEditorOpen,
    characterPanelOpen,
    setCharacterPanelOpen,
    lastLorebookReport,
    lastPromptBudget,
    lastMemoryReport,
    memoryPanelOpen,
    setMemoryPanelOpen,
    sourceFocus,
    setSourceFocus,
    navigationRevision,
    characterSelection,
    characterImport,
    conversationsState,
    providerSettings,
    chat,
    pluginsState,
  } = props;

  const {
    characters,
    selectedCharacter,
    isLoadingCharacter,
    listError,
    handleSelectCharacter,
  } = characterSelection;
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
  const {
    conversations,
    activeConversation,
    handleStartConversation,
    handleOpenConversation,
  } = conversationsState;
  const {
    provider,
    setProvider,
    apiKeyDraft,
    setApiKeyDraft,
    isSavingProvider,
    providerNotice,
    providerIssue,
    isConnectionReady,
    markConnectionReady,
    handleSaveProvider,
  } = providerSettings;
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
    handleGenerate,
    handleContinue,
    handleImpersonate,
    beginEditMessage,
    cancelEditMessage,
    saveEditMessage,
    handleDeleteMessage,
  } = chat;
  const {
    plugins,
    activeCommands,
    handlePluginToggle,
    handlePluginUninstall,
  } = pluginsState;

  const handleCharacterSaved = (updated: CharacterDetail): void => {
    const summary = toSummary(updated);
    characterSelection.setCharacters(current => current.map(item => item.id === summary.id ? summary : item));
    characterSelection.setSelectedCharacter(current => current?.id === updated.id ? updated : current);
    if (activeConversation?.characterId === updated.id) {
      conversationsState.setActiveConversation(current => current?.characterId === updated.id ? { ...current, characterName: updated.name } : current);
    }
  };

  // 对话页空态点角色直接开聊：先取详情保持角色库选中态，再为该角色建故事。
  // 注意：这条路会先 setSelectedCharacter，检视栏会瞬时从网格切成角色详情。
  // 角色库网格里的"开始对话"因此**不走这里**（见 onStartConversationWith），
  // 否则会出现"先跳详情再进聊天"的闪动。
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

  return (
    <div className={`desktop-shell ${isSidebarCollapsed ? "desktop-shell--sidebar-collapsed" : ""}`}>
      <AppSidebar
        busy={isImporting || isSaving}
        collapsed={isSidebarCollapsed}
        conversationCount={conversations.length}
        conversations={conversations}
        activeConversationId={activeConversation?.id}
        fileInputRef={fileInputRef}
        isImporting={isImporting}
        memoryInjectedCount={lastMemoryReport?.injectedCount ?? ""}
        memoryPanelOpen={memoryPanelOpen}
        onCollapseToggle={() => setIsSidebarCollapsed((value) => !value)}
        onCardFile={(event) => void handleCardFile(event)}
        onChatNav={() => { setMemoryPanelOpen(false); setWorkspaceView("chat"); }}
        onMemoryNav={() => setWorkspaceView("memory")}
        onNavigate={setWorkspaceView}
        onOpenConversation={(id) => void handleOpenConversation(id)}
        onDeleteConversation={conversationsState.handleDeleteConversation}
        onOpenFilePicker={openFilePicker}
        pluginCount={plugins.length}
        modelConnection={modelConnection}
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
        onStartConversationWith={(id) => void handleStartConversation(id)}
        onBackToLibrary={() => characterSelection.setSelectedCharacter(null)}
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
        onOpenSettings={() => setWorkspaceView("settings")}
        onRegenerate={() => void handleRegenerate()}
        onGenerate={() => void handleGenerate()}
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
        onSave={() => handleSaveProvider(false)}
        onSaveAndTest={() => handleSaveProvider(true)}
        provider={provider}
        providerNotice={providerNotice}
        providerIssue={providerIssue}
        isConnectionReady={isConnectionReady}
        onConnectionReady={markConnectionReady}
        selectedCharacterName={selectedCharacter?.name}
        onContinue={() => { if (activeConversation) setWorkspaceView("chat"); else if (selectedCharacter) void handleStartConversation(); else setWorkspaceView("chat"); }}
        runtimeError={runtimeError}
      /></div>
      {workspaceView === "memory" ? <MemoryView
        online={serviceState === "online"}
        onOpenSource={(conversationId, messageId, revision) => {
          void handleOpenConversation(conversationId);
          setSourceFocus({ conversationId, messageId, revision });
          setWorkspaceView("chat");
        }}
      /> : null}
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
