import { useEffect, useRef, useState } from "react";

import type { ConversationDetail, ConversationSummary } from "@mycompanion/shared";

import { ApiRequestError, activateBranch, createConversation, fetchConversation } from "../api";
import { flushSharedExtensionSettings } from "../extension-settings";
import type { WorkspaceView } from "./useExtensionResume";

// 故事会话：创建/打开与当前激活会话，和角色选中共用 navigationRevision 防竞态。
export function useConversations(deps: {
  navigationRevision: { current: number };
  resumeConversationId: string | undefined;
  selectedCharacterId: string | undefined;
  setWorkspaceView: (view: WorkspaceView) => void;
  setRuntimeError: (message: string | null) => void;
}) {
  const {
    navigationRevision,
    resumeConversationId,
    selectedCharacterId,
    setWorkspaceView,
    setRuntimeError,
  } = deps;
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversation, setActiveConversation] = useState<ConversationDetail | null>(null);
  const [branchBusy, setBranchBusy] = useState(false);
  const branchOperation = useRef(false);

  useEffect(() => {
    if (!resumeConversationId) return;
    const controller = new AbortController();
    const revision = navigationRevision.current;
    const current = () => !controller.signal.aborted && revision === navigationRevision.current;
    void fetchConversation(resumeConversationId, controller.signal)
      .then(conversation => { if (current()) setActiveConversation(conversation); })
      .catch(error => { if (current() && error?.name !== "AbortError") setRuntimeError("无法恢复之前的故事。"); });
    return () => controller.abort();
    // 仅在挂载时执行一次：resumeConversationId 来自挂载快照。
  }, []);

  // 可选 characterId 覆盖：对话页空态直接点角色开聊时，选中角色尚未落入 state。
  const handleStartConversation = async (characterId?: string): Promise<void> => {
    const targetCharacterId = characterId ?? selectedCharacterId;
    if (!targetCharacterId) return;
    const revision = ++navigationRevision.current;
    setRuntimeError(null);
    try {
      const conversation = await createConversation(targetCharacterId);
      if (revision !== navigationRevision.current) return;
      setActiveConversation(conversation);
      setConversations((current) => [conversation, ...current]);
      setWorkspaceView("chat");
    } catch (error) {
      if (revision !== navigationRevision.current) return;
      setRuntimeError(error instanceof ApiRequestError ? error.message : "无法创建故事。");
    }
  };

  const handleOpenConversation = async (id: string): Promise<void> => {
    const revision = ++navigationRevision.current;
    setRuntimeError(null);
    try {
      const conversation = await fetchConversation(id);
      if (revision !== navigationRevision.current) return;
      setActiveConversation(conversation);
      setWorkspaceView("chat");
    } catch (error) {
      if (revision !== navigationRevision.current) return;
      setRuntimeError(error instanceof ApiRequestError ? error.message : "无法打开故事。");
    }
  };

  const handleActivateBranch = async (conversationId: string, branchId: string): Promise<void> => {
    if (branchOperation.current || activeConversation?.id !== conversationId) return;
    branchOperation.current = true;
    const revision = ++navigationRevision.current;
    setBranchBusy(true); setRuntimeError(null);
    try {
      await flushSharedExtensionSettings();
      if (revision !== navigationRevision.current) return;
      const conversation = await activateBranch(conversationId, branchId);
      if (revision !== navigationRevision.current) return;
      setActiveConversation(conversation);
      setConversations(current => current.map(item => item.id === conversationId ? { ...item,
        activeBranchId: conversation.activeBranchId, updatedAt: conversation.updatedAt,
        lastMessagePreview: conversation.lastMessagePreview, messageCount: conversation.messageCount } : item));
    } catch (error) {
      if (revision === navigationRevision.current) setRuntimeError(error instanceof Error ? error.message : "无法切换回复分支。");
    } finally { branchOperation.current = false; setBranchBusy(false); }
  };

  return {
    conversations,
    setConversations,
    activeConversation,
    setActiveConversation,
    handleStartConversation,
    handleOpenConversation,
    handleActivateBranch,
    branchBusy,
  };
}
