import {
  useEffect,
  useRef,
  useState,
} from "react";

import type {
  LorebookReport,
  MemoryRetrievalReport,
  PromptBudgetReport,
} from "@mycompanion/shared";

import {
  fetchHealth,
  fetchConversation,
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
import { AppLayout } from "./views/AppLayout";
import "./styles.css";
import { initializeUiLanguage } from "./i18n";

// 应用根组件：只做钩子编排与跨域数据流，视图装配在 views/AppLayout.tsx。
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
  const { selectedCharacter } = characterSelection;

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

  const conversationsState = useConversations({
    navigationRevision,
    resumeConversationId: resume.current.conversationId,
    selectedCharacterId: selectedCharacter?.id,
    setWorkspaceView,
    setRuntimeError,
  });
  const { activeConversation } = conversationsState;

  const providerSettings = useProviderSettings({ setRuntimeError });
  const {
    provider,
    setProvider,
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
  const { chatInput } = chat;

  const pluginsState = usePlugins({
    setRuntimeError,
  });

  useExtensionResume({
    workspaceView,
    conversationId: activeConversation?.id,
    characterId: selectedCharacter?.id,
    chatInput,
  });

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
    <AppLayout
      serviceState={serviceState}
      runtimeError={runtimeError}
      setRuntimeError={setRuntimeError}
      isSidebarCollapsed={isSidebarCollapsed}
      setIsSidebarCollapsed={setIsSidebarCollapsed}
      workspaceView={workspaceView}
      setWorkspaceView={setWorkspaceView}
      regexPanelOpen={regexPanelOpen}
      setRegexPanelOpen={setRegexPanelOpen}
      lorebookPanelOpen={lorebookPanelOpen}
      setLorebookPanelOpen={setLorebookPanelOpen}
      worldEditorOpen={worldEditorOpen}
      setWorldEditorOpen={setWorldEditorOpen}
      characterPanelOpen={characterPanelOpen}
      setCharacterPanelOpen={setCharacterPanelOpen}
      lastLorebookReport={lastLorebookReport}
      lastPromptBudget={lastPromptBudget}
      lastMemoryReport={lastMemoryReport}
      memoryPanelOpen={memoryPanelOpen}
      setMemoryPanelOpen={setMemoryPanelOpen}
      sourceFocus={sourceFocus}
      setSourceFocus={setSourceFocus}
      navigationRevision={navigationRevision}
      characterSelection={characterSelection}
      characterImport={characterImport}
      conversationsState={conversationsState}
      providerSettings={providerSettings}
      chat={chat}
      pluginsState={pluginsState}
    />
  );
}
