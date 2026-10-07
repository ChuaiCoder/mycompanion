import { useEffect, useRef, useState } from "react";

import type { ConversationDetail, ConversationSummary } from "@mycompanion/shared";

import { ApiRequestError, activateBranch, createConversation, deleteConversation, deleteConversations, fetchConversation } from "../api";
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

  /**
   * 删除故事（FR-DATA-004 软删除）：服务端只打删除标记，因此这是可恢复操作。删除的是
   * 当前打开的故事时一并清空激活态，避免详情继续显示一条已删除的记录。
   * 返回是否成功，供侧边栏决定收起还是保留确认态。
   */
  const handleDeleteConversation = async (id: string): Promise<boolean> => {
    // 只推进 revision，让在途的"打开会话"读取作废，避免它把已删项写回列表。
    ++navigationRevision.current;
    setRuntimeError(null);
    try {
      await deleteConversation(id);
      // 删除是按 id 的幂等操作，结果必须落地：以前这里在用户切过故事时提前 return，
      // 导致已删除的故事继续留在侧栏。
      setConversations(current => current.filter(item => item.id !== id));
      setActiveConversation(current => current?.id === id ? null : current);
      return true;
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "无法删除这个故事。");
      return false;
    }
  };

  /**
   * 批量删除故事：一次请求、一次事务，与单条删除同为软删除。
   *
   * 只把服务端确认删掉的 id 从列表移除——`skipped` 里的（已删或不存在）不当作成功，
   * 否则界面会显示"删掉了"而实际没删。返回真正删除的条数供界面汇报。
   */
  const handleDeleteConversations = async (ids: readonly string[]): Promise<number> => {
    if (!ids.length) return 0;
    ++navigationRevision.current;
    setRuntimeError(null);
    try {
      const result = await deleteConversations(ids);
      const removed = new Set(result.deleted.map(item => item.id));
      setConversations(current => current.filter(item => !removed.has(item.id)));
      setActiveConversation(current => current && removed.has(current.id) ? null : current);
      return removed.size;
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "无法删除这些故事。");
      return 0;
    }
  };

  return {
    conversations,
    setConversations,
    activeConversation,
    setActiveConversation,
    handleStartConversation,
    handleOpenConversation,
    handleActivateBranch,
    handleDeleteConversation,
    handleDeleteConversations,
    branchBusy,
  };
}
