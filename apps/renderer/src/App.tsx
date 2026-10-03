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
  fetchConversation,
  activateBranch,
  getProviderSettings,
  listConversations,
  listPlugins,
} from "./api";
import {
  CharacterAvatar,
  Icon,
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
import "./styles.css";
import { useTranslation } from "react-i18next";
import { initializeUiLanguage } from "./i18n";
import { libraryText } from "./library-translations";

export function App() {
  const { t, i18n } = useTranslation();
  const resume = useRef(readExtensionResume());
  const [serviceState, setServiceState] = useState<ServiceState>("checking");
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>(resume.current.view ?? "library");
  const [regexPanelOpen, setRegexPanelOpen] = useState(false);
  const [lorebookPanelOpen, setLorebookPanelOpen] = useState(false);
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
    const reveal = () => setLorebookPanelOpen(true);
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
      <aside className="sidebar">
        <div className="brand-row">
          <button className="brand-button" onClick={() => setWorkspaceView("library")} type="button"><span aria-hidden="true" className="brand-mark">M</span><span className="brand-name">MyCompanion</span></button>
          <button aria-expanded={!isSidebarCollapsed} aria-label={isSidebarCollapsed ? "展开侧边栏" : "收起侧边栏"} className="sidebar-collapse" onClick={() => setIsSidebarCollapsed((value) => !value)} type="button">{isSidebarCollapsed ? "▣" : "◫"}</button>
        </div>
        <nav aria-label="主导航" className="primary-nav">
          <button className="nav-row nav-row--new" disabled={isImporting || isSaving} onClick={openFilePicker} type="button"><Icon name="plus" /><span>{t(isImporting ? "nav.reading" : "nav.import")}</span><kbd>Ctrl I</kbd></button>
          <button aria-current={workspaceView === "library" ? "page" : undefined} className={`nav-row ${workspaceView === "library" ? "nav-row--active" : ""}`} onClick={() => setWorkspaceView("library")} type="button"><Icon name="character" /><span>{t("nav.library")}</span></button>
          <button aria-current={workspaceView === "chat" ? "page" : undefined} className={`nav-row ${workspaceView === "chat" ? "nav-row--active" : ""}`} onClick={() => setWorkspaceView("chat")} type="button"><Icon name="book" /><span>{t("nav.chat")}</span><small>{conversations.length || ""}</small></button>
          <button aria-current={workspaceView === "plugins" ? "page" : undefined} className={`nav-row ${workspaceView === "plugins" ? "nav-row--active" : ""}`} onClick={() => setWorkspaceView("plugins")} type="button"><Icon name="sparkles" /><span>{t("nav.plugins")}</span><small>{plugins.length || ""}</small></button>
          <button aria-current={workspaceView === "chat" ? "page" : undefined} className={`nav-row ${workspaceView === "chat" ? "nav-row--active" : ""}`} onClick={() => { setMemoryPanelOpen(true); setWorkspaceView("chat"); }} type="button"><Icon name="brain" /><span>{t("nav.memory")}</span><small>{lastMemoryReport?.injectedCount ?? ""}</small></button>
        </nav>
        <section aria-labelledby="recent-characters-title" className="sidebar-library">
          <div className="tree-heading"><div><Icon name="character" size={16} /><h2 id="recent-characters-title">我的角色</h2></div><button aria-label="导入新的角色卡" disabled={isImporting || isSaving} onClick={openFilePicker} type="button"><Icon name="plus" size={16} /></button></div>
          <div id="right-nav-panel" hidden><div aria-label="收藏角色" className="hotswap" /></div>
          {listError ? <p className="sidebar-error">{listError}</p> : null}
          {characters.length === 0 ? (
            <div className="tree-empty"><span>还没有角色</span><small>导入 PNG、JSON 或 CHARX 角色卡</small></div>
          ) : (
            <ul className="character-list" aria-label="已保存角色">
              {characters.map((character) => <li key={character.id}><button aria-pressed={selectedCharacter?.id === character.id} className="character-row" disabled={isLoadingCharacter} onClick={() => void handleSelectCharacter(character.id)} type="button"><CharacterAvatar character={character} /><span className="character-row__copy"><strong>{character.name}</strong><small>世界书 {character.lorebookEntryCount} · 正则 {character.regexScriptCount}</small></span><Icon name="chevron" size={14} /></button></li>)}
            </ul>
          )}
        </section>
        <footer className="sidebar-footer">
          <div className={`service-state service-state--${serviceState}`}><span aria-hidden="true" className="status-dot" /><span>{t("service." + serviceState)}</span></div>
          <button aria-label={t("nav.settings")} aria-pressed={workspaceView === "settings"} onClick={() => setWorkspaceView("settings")} type="button"><Icon name="settings" size={18} /></button>
        </footer>
        <input ref={fileInputRef} multiple accept=".json,.png,.yaml,.yml,.charx,.zip,.byaf,.jpg,.jpeg,application/json,image/png,application/charx,application/zip,application/byaf,application/yaml,text/yaml" aria-label={libraryText(i18n.language, "选择角色卡文件")} className="visually-hidden-input" disabled={isImporting || isSaving} onChange={(event) => void handleCardFile(event)} type="file" />
      </aside>

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
        selectedCharacter={selectedCharacter}
        successMessage={successMessage}
        characters={characters}
      /> : null}
      <div className="workspace-view" hidden={workspaceView !== "chat"}><ChatView
        generationControlsBusy={generationControlsBusy || conversationsState.branchBusy}
        activeCommands={activeCommands}
        activeConversation={activeConversation}
        chatInput={chatInput}
        conversations={conversations}
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
        onContinue={() => { if (activeConversation) setWorkspaceView("chat"); else if (selectedCharacter) void handleStartConversation(); else setWorkspaceView("library"); }}
        runtimeError={runtimeError}
      /></div>
      {workspaceView === "plugins" ? <PluginsView
        onPluginToggle={(plugin) => void handlePluginToggle(plugin)}
        onPluginUninstall={(id) => void handlePluginUninstall(id)}
        plugins={plugins}
        runtimeError={runtimeError}
      /> : null}
      <WorldInfoPanel open={lorebookPanelOpen} online={serviceState === "online"} character={selectedCharacter} onClose={() => setLorebookPanelOpen(false)} />
      <CharacterPanel open={characterPanelOpen} online={serviceState === "online"} character={selectedCharacter} onSaved={handleCharacterSaved} onClose={() => setCharacterPanelOpen(false)} />
    </div>
  );
}
