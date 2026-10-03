import type { NativeGenerationOptions } from "../api";
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { flushSync } from "react-dom";

import type {
  ChatMessage,
  ConversationDetail,
  ConversationSummary,
  GenerationSseEvent,
  LorebookReport,
  MemoryRetrievalReport,
  PromptBudgetReport,
} from "@mycompanion/shared";

import {
  ApiRequestError,
  deleteMessage,
  editMessage,
  fetchConversation,
  listConversations,
  stopGeneration,
  streamChatMessage,
  streamRegenerate,
  streamForegroundMode,
} from "../api";
import { replaceMessage, updateLastAssistantContent } from "../chat-stream-utils";
import { observeProviderConnection } from "../provider-connection";
import { loadComposerDraftStore, type ComposerDraftStore } from "../composer-drafts";

export type NativeGenerationResult = { status: "complete"; text: string } | { status: "stopped" | "skipped" | "preview" } | { status: "failed"; error: Error };
function resultObserver(handler: (event: GenerationSseEvent) => void) {
  const state: { result: NativeGenerationResult } = { result: { status: "skipped" } };
  return { state, onEvent: (event: GenerationSseEvent) => {
    if (event.type === "done") state.result = event.message.status === "complete" ? { status: "complete", text: event.message.content }
      : event.message.status === "failed" ? { status: "failed", error: new Error(event.message.content) } : { status: "stopped" };
    if (event.type === "error") state.result = { status: "failed", error: new Error(event.message) };
    if (event.type === "impersonate_result") state.result = { status: "complete", text: event.text };
    if (event.type === "generation_end" && state.result.status !== "failed") state.result = { status: event.reason };
    handler(event);
  } };
}

// 聊天生成：SSE 发送/停止/重新生成/消息编辑，以及生成中的 UI 状态。
export function useChatGeneration(deps: {
  initialInput: string;
  activeConversation: ConversationDetail | null;
  setActiveConversation: Dispatch<SetStateAction<ConversationDetail | null>>;
  setConversations: Dispatch<SetStateAction<ConversationSummary[]>>;
  setRuntimeError: (message: string | null) => void;
  providerModel: string | undefined;
  setLastLorebookReport: (report: LorebookReport) => void;
  setLastPromptBudget: (report: PromptBudgetReport) => void;
  setLastMemoryReport: (report: MemoryRetrievalReport) => void;
}) {
  const {
    initialInput,
    activeConversation,
    setActiveConversation,
    setConversations,
    setRuntimeError,
    providerModel,
    setLastLorebookReport,
    setLastPromptBudget,
    setLastMemoryReport,
  } = deps;
  const messageListRef = useRef<HTMLDivElement>(null);
  const streamControllerRef = useRef<AbortController | null>(null);
  const streamConversationRef = useRef<string | null>(null);
  const activeConversationId = useRef(activeConversation?.id);
  const activeStory = useRef(activeConversation);
  const mounted = useRef(true);
  activeConversationId.current = activeConversation?.id;
  activeStory.current = activeConversation;
  const isCurrentStory = (id: string) => mounted.current && activeConversationId.current === id;
  const [chatInput, setInput] = useState(initialInput);
  const inputRevision = useRef(0), firstComposer = useRef(true);
  const composerDrafts = useRef<ComposerDraftStore | null>(null);
  const [draftTarget, setDraftTarget] = useState<string | undefined>();
  const setChatInput: Dispatch<SetStateAction<string>> = value => { inputRevision.current++; setInput(value); };
  const renderedComposer = useRef({ id: activeConversation?.id, revision: inputRevision.current });
  const inputEditedAtNavigation = useRef(false);
  if (renderedComposer.current.id !== activeConversation?.id) {
    inputEditedAtNavigation.current = renderedComposer.current.revision !== inputRevision.current;
  }
  renderedComposer.current = { id: activeConversation?.id, revision: inputRevision.current };
  const [isNativeGenerating, setIsGenerating] = useState(false);
  const isGenerating = isNativeGenerating;
  const generationControlsBusy = isNativeGenerating;
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");

  useEffect(() => {
    const id = activeConversation?.id;
    if (!id) return;
    let disposed = false;
    const revision = inputRevision.current;
    const editedAtNavigation = inputEditedAtNavigation.current;
    void loadComposerDraftStore().then(store => {
      if (disposed || activeConversationId.current !== id) return;
      composerDrafts.current = store;
      // A user can type while hydration is pending. That newer input wins.
      if (!editedAtNavigation && revision === inputRevision.current) setInput(store.read(id) ?? (firstComposer.current ? initialInput : ""));
      firstComposer.current = false; setDraftTarget(id);
    }).catch(error => { if (!disposed) setRuntimeError("输入草稿暂时无法恢复：" + (error instanceof Error ? error.message : String(error))); });
    return () => { disposed = true; };
  }, [activeConversation?.id]);
  useEffect(() => {
    if (draftTarget && draftTarget === activeConversation?.id) composerDrafts.current?.write(draftTarget, chatInput);
  }, [draftTarget, activeConversation?.id, chatInput]);

  useEffect(() => {
    setEditingMessageId(null);
    setEditingDraft("");
  }, [activeConversation?.id]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      streamControllerRef.current?.abort();
    };
  }, []);

  const reloadStory = async (id: string): Promise<void> => {
    const updated = await fetchConversation(id);
    setActiveConversation(current => current?.id === id ? updated : current);
  };

  useEffect(() => {
    messageListRef.current?.scrollTo({
      top: messageListRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [activeConversation?.messages.length, isGenerating]);

  // 把一次 SSE 生成事件流映射到 UI 状态：
  // assistant_start accepts the actual branch before subsequent output-macro RPCs.
  // A regenerated reply replaces the old tail after its parent, rather than
  // exposing messages from the old branch until the stream finishes.
  const makeStreamHandler = (conversationId: string) => {
    const connectionIsCurrent = observeProviderConnection();
    let streamBranchId = activeConversation?.activeBranchId;
    return (event: GenerationSseEvent): void => {
      if (mounted.current && connectionIsCurrent() && event.type === "done" && event.message.status === "complete") {
        window.dispatchEvent(new CustomEvent("mycompanion:provider-tested", { detail: { ok: true, model: providerModel } }));
      }
      // Navigation can change while an old stream is still producing events.
      if (!isCurrentStory(conversationId)) return;
      if (activeStory.current?.activeBranchId !== streamBranchId) return;
      if (event.type === "lorebook") {
        // 世界书报告只进入本地查看状态，不进入消息列表（FR-LORE-003）。
        setLastLorebookReport(event.report);
        return;
      }
      if (event.type === "prompt_budget") {
        // 预算报告只进入本地查看状态（FR-PROMPT-003）。
        setLastPromptBudget(event.report);
        return;
      }
      if (event.type === "memory") {
        // 记忆检索报告只进入本地查看状态（FR-MEM-005）。
        setLastMemoryReport(event.report);
        return;
      }
      if (event.type === "macro_variables") {
        // 服务端已原子持久化变量；这里同步本地草稿，让后续宏上下文读取一致。
        setActiveConversation((current) => {
          if (!current || current.id !== conversationId) return current;
          const metadata = { ...(current.chatMetadata ?? {}) } as Record<string, unknown>;
          const variables = { ...(metadata.variables as Record<string, unknown> | undefined) };
          for (const change of event.changes) {
            if (change.scope !== "local") continue;
            if (change.afterExists) variables[change.key] = change.after;
            else delete variables[change.key];
          }
          metadata.variables = variables;
          return { ...current, chatMetadata: metadata };
        });
        return;
      }
      if (event.type === "assistant_start") {
        if (event.message.branchId !== streamBranchId) {
          // Only this accepted native-generation transition can preserve a
          // running slash command. Independent navigation still cancels it.
          window.dispatchEvent(new CustomEvent("mycompanion:generation-branch-accepted", {
            detail: { conversationId, branchId: event.message.branchId },
          }));
          streamBranchId = event.message.branchId;
        }
        flushSync(() => setActiveConversation((current) => {
          if (!current || current.id !== conversationId) return current;
          const parentIndex = current.messages.findIndex(message => message.id === event.message.parentMessageId);
          return {
            ...current,
            activeBranchId: event.message.branchId,
            messages: [...current.messages.slice(0, parentIndex + 1), event.message],
          };
        }));
        return;
      }
      setActiveConversation((current) => {
        if (!current || current.id !== conversationId) return current;
        if (event.type === "user_message") {
          return { ...current, messages: [...current.messages, event.message] };
        }
        if (event.type === "delta") {
          return updateLastAssistantContent(current, event.delta);
        }
        if (event.type === "done") {
          return replaceMessage(current, event.message);
        }
        return current;
      });
    };
  };

  const handleSendMessage = async (input?: string, options: NativeGenerationOptions = {}): Promise<NativeGenerationResult> => {
    const content = options.dryRun ? "" : (input ?? chatInput).trim();
    if (!activeConversation || (!content && !options.allowEmpty && !options.dryRun) || isGenerating || streamControllerRef.current) return { status: "skipped" };
    const story = activeConversation.id;
    if (!options.dryRun) setChatInput("");
    setRuntimeError(null);
    setIsGenerating(true);
    const controller = new AbortController();
    streamControllerRef.current = controller;
    streamConversationRef.current = story;
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort(); else options.signal?.addEventListener("abort", abort, { once: true });
    const observed = resultObserver(makeStreamHandler(story));
    try {
      await streamChatMessage(story, content, controller.signal, observed.onEvent, options);
      setConversations((await listConversations()).items);
      if (observed.state.result.status === "failed" && isCurrentStory(story)) setRuntimeError(observed.state.result.error.message);
      return observed.state.result;
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        // 用户点击“停止”：服务端保留已接收文本并标记 stopped，重新拉取最终状态。
        try {
          await reloadStory(story);
        } catch { /* keep partial state */ }
        return { status: "stopped" };
      }
      if (isCurrentStory(story)) {
        setRuntimeError(error instanceof Error ? error.message : "消息发送失败。");
      }
      try {
        await reloadStory(story);
      } catch {
        // Preserve the visible draft when a local reload is also unavailable.
      }
      return { status: "failed", error: error instanceof Error ? error : new Error(String(error)) };
    } finally {
      options.signal?.removeEventListener("abort", abort);
      setIsGenerating(false);
      streamControllerRef.current = null;
      streamConversationRef.current = null;
    }
  };

  const handleStopGeneration = async (): Promise<void> => {
    const story = streamConversationRef.current;
    if (!story) return;
    // 优先断开 SSE 连接，服务端据此中止并保留已接收文本（标记 stopped）。
    streamControllerRef.current?.abort();
    try {
      await stopGeneration(story);
      await reloadStory(story);
    } catch {
      // 停止是幂等的；最终状态以重新拉取为准，失败时保持当前可见内容。
    }
  };

  const handleForegroundGeneration = async (mode: "continue" | "impersonate" | undefined, options: NativeGenerationOptions = {}): Promise<NativeGenerationResult> => {
    if (!activeConversation || isGenerating || streamControllerRef.current || editingMessageId) return { status: "skipped" };
    if (mode === "continue" && activeConversation.messages.at(-1)?.role !== "assistant") return { status: "skipped" };
    const story = activeConversation.id;
    const branch = activeConversation.activeBranchId;
    setRuntimeError(null);
    setIsGenerating(true);
    const controller = new AbortController();
    streamControllerRef.current = controller;
    streamConversationRef.current = story;
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort(); else options.signal?.addEventListener("abort", abort, { once: true });
    const handler = makeStreamHandler(story);
    let impersonated = "";
    const observed = resultObserver(event => {
      if (mode !== "impersonate") { handler(event); return; }
      if (!isCurrentStory(story) || activeStory.current?.activeBranchId !== branch) return;
      if (event.type === "delta") {
        impersonated += event.delta;
        flushSync(() => setChatInput(impersonated));
      } else if (event.type === "impersonate_result") {
        flushSync(() => setChatInput(event.text));
      } else handler(event);
    });
    try {
      if (mode) await streamForegroundMode(story, mode, controller.signal, observed.onEvent, options);
      else await streamRegenerate(story, controller.signal, observed.onEvent, options);
      await reloadStory(story);
      setConversations((await listConversations()).items);
      if (observed.state.result.status === "failed" && isCurrentStory(story)) setRuntimeError(observed.state.result.error.message);
      return observed.state.result;
    } catch (error) {
      if (isCurrentStory(story) && !controller.signal.aborted && !(error instanceof DOMException && error.name === "AbortError")) {
        setRuntimeError(error instanceof Error ? error.message : mode === "continue" ? "续写失败。" : mode === "impersonate" ? "代写失败。" : "重新生成失败。");
      }
      try {
        await reloadStory(story);
      } catch { /* keep partial state */ }
      return controller.signal.aborted ? { status: "stopped" } : { status: "failed", error: error instanceof Error ? error : new Error(String(error)) };
    } finally {
      options.signal?.removeEventListener("abort", abort);
      setIsGenerating(false);
      streamControllerRef.current = null;
      streamConversationRef.current = null;
    }
  };
  const handleRegenerate = (options: NativeGenerationOptions = {}) => handleForegroundGeneration(undefined, options);
  const handleContinue = (options: NativeGenerationOptions = {}) => handleForegroundGeneration("continue", options);
  const handleImpersonate = (options: NativeGenerationOptions = {}) => handleForegroundGeneration("impersonate", options);

  const beginEditMessage = (message: ChatMessage): void => {
    if (isGenerating) return;
    setEditingMessageId(message.id);
    setEditingDraft(message.content);
  };

  const cancelEditMessage = (): void => {
    setEditingMessageId(null);
    setEditingDraft("");
  };

  const saveEditMessage = async (messageId: string): Promise<void> => {
    const content = editingDraft.trim();
    if (!activeConversation || !content) return;
    const story = activeConversation.id;
    setRuntimeError(null);
    try {
      await editMessage(story, messageId, content);
      const updated = await fetchConversation(story);
      setActiveConversation((current) => current?.id === story ? updated : current);
      if (isCurrentStory(story)) cancelEditMessage();
    } catch (error) {
      if (isCurrentStory(story)) setRuntimeError(error instanceof ApiRequestError ? error.message : "保存编辑失败。");
    }
  };

  const handleDeleteMessage = async (messageId: string): Promise<void> => {
    if (!activeConversation || isGenerating) return;
    const story = activeConversation.id;
    setRuntimeError(null);
    try {
      const updated = await deleteMessage(story, messageId);
      setActiveConversation(current => current?.id === story ? updated : current);
    } catch (error) {
      if (isCurrentStory(story)) setRuntimeError(error instanceof ApiRequestError ? error.message : "删除消息失败。");
    }
  };

  return {
    messageListRef,
    streamControllerRef,
    chatInput,
    setChatInput,
    isNativeGenerating,
    isGenerating,
    generationControlsBusy,
    editingMessageId,
    editingDraft,
    setEditingDraft,
    handleSendMessage,
    handleStopGeneration,
    handleRegenerate,
    handleContinue,
    handleImpersonate,
    beginEditMessage,
    cancelEditMessage,
    saveEditMessage,
    handleDeleteMessage,
  };
}
