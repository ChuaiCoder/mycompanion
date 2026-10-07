import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ConversationDetail, PromptPreviewResponse } from "@mycompanion/shared";
import * as api from "../api";
import { ChatView, type ChatViewProps } from "./ChatView";
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
it("focuses and highlights the actual source message, exposes both story exports, and explains truncated replies", () => {
  const conversation: ConversationDetail = { id: "story", characterId: "character", characterName: "旅人", title: "Story", lastMessagePreview: "reply", messageCount: 1, activeBranchId: "branch", createdAt: "2026-10-02", updatedAt: "2026-10-02", messages: [{ id: "source", conversationId: "story", branchId: "branch", parentMessageId: null, role: "assistant", content: "reply", status: "complete", createdAt: "2026-10-02", generationMetadata: { model: "fixture", temperature: 0.7, maxTokens: 300, completionOutcome: "truncated", finishReason: "length" } }] };
  const noop = () => {};
  const props: ChatViewProps = { activeConversation: conversation, chatInput: "", isGenerating: false, generationControlsBusy: false, runtimeError: null, editingMessageId: null, editingDraft: "", activeCommands: [], lastLorebookReport: null, lastMemoryReport: null, lastPromptBudget: null, memoryPanelOpen: false, messageListRef: { current: null }, onChatInput: noop, onSendMessage: noop, onStopGeneration: noop, onRegenerate: noop, onGenerate: noop, onEditMessage: noop, onEditingDraft: noop, onSaveEdit: noop, onCancelEdit: noop, onDeleteMessage: noop, onOpenSettings: noop, onGoToLibrary: noop, onMemoryPanelToggle: noop, sourceFocus: { conversationId: "story", messageId: "source", revision: 1 } };
  render(<ChatView {...props} />);
  const row = document.querySelector('[data-message-id="source"]');
  expect(row).toHaveClass("chat-message--source"); expect(row).toHaveFocus(); expect(screen.getByText("达到回复长度")).toBeInTheDocument();
  // 截断还要显眼地说出来并给出可操作方向：正文可能停在句中，只靠作者行里那行小字很容易被忽略。
  expect(screen.getByText(/被截断/)).toBeInTheDocument();
  expect(screen.getByText(/最大输出 Token/)).toBeInTheDocument();
  expect(document.querySelector('a[href="/api/conversations/story/export?format=markdown"]')).not.toBeNull();
  expect(document.querySelector('a[href="/api/conversations/story/export?format=json"]')).not.toBeNull();
});

it("keeps the chat shell's child count in step with its declared grid columns", () => {
  // .runtime-shell 声明了单列，只有打开记忆面板时才由 --memory 追加第二列。
  // 之前它在 1280px/900px 断点里被写成固定两列，而聊天视图只渲染一个子元素，
  // 空出的第一列把聊天区压成窄条。这里锁住"列数与子元素数同增同减"这个契约。
  const conversation: ConversationDetail = { id: "story", characterId: "character", characterName: "旅人", title: "Story", lastMessagePreview: "reply", messageCount: 1, activeBranchId: "branch", createdAt: "2026-10-02", updatedAt: "2026-10-02", messages: [] };
  const noop = () => {};
  const base: ChatViewProps = { activeConversation: conversation, chatInput: "", isGenerating: false, generationControlsBusy: false, runtimeError: null, editingMessageId: null, editingDraft: "", activeCommands: [], lastLorebookReport: null, lastMemoryReport: null, lastPromptBudget: null, memoryPanelOpen: false, messageListRef: { current: null }, onChatInput: noop, onSendMessage: noop, onStopGeneration: noop, onRegenerate: noop, onGenerate: noop, onEditMessage: noop, onEditingDraft: noop, onSaveEdit: noop, onCancelEdit: noop, onDeleteMessage: noop, onOpenSettings: noop, onGoToLibrary: noop, onMemoryPanelToggle: noop };

  const closed = render(<ChatView {...base} />);
  const closedShell = closed.container.querySelector(".runtime-shell")!;
  expect(closedShell.classList.contains("runtime-shell--memory")).toBe(false);
  expect(closedShell.children).toHaveLength(1);
  expect(closedShell.children[0]!.classList.contains("chat-pane")).toBe(true);
  cleanup();

  const open = render(<ChatView {...base} memoryPanelOpen />);
  const openShell = open.container.querySelector(".runtime-shell")!;
  expect(openShell.classList.contains("runtime-shell--memory")).toBe(true);
  expect(openShell.children).toHaveLength(2);
  expect(openShell.children[1]!.classList.contains("memory-side-pane")).toBe(true);
  cleanup();

  // 没有对话时记忆栏不渲染，修饰符也不能出现，否则同样会空出一列。
  const noStory = render(<ChatView {...base} activeConversation={null} memoryPanelOpen />);
  const noStoryShell = noStory.container.querySelector(".runtime-shell")!;
  expect(noStoryShell.classList.contains("runtime-shell--memory")).toBe(false);
  expect(noStoryShell.children).toHaveLength(1);
});

it("aborts a stale open preview on a same-story source revision and ignores its late response", async () => {
  vi.useFakeTimers();
  const conversation: ConversationDetail = { id: "preview-story", characterId: "character", characterName: "Role", title: "Story", lastMessagePreview: "", messageCount: 0, activeBranchId: "original", createdAt: "2026-10-03", updatedAt: "2026-10-03T00:00:00.000Z", messages: [] };
  const noop = () => {};
  const props: ChatViewProps = { activeConversation: conversation, chatInput: "same draft", isGenerating: false, generationControlsBusy: false, runtimeError: null, editingMessageId: null, editingDraft: "", activeCommands: [], lastLorebookReport: null, lastMemoryReport: null, lastPromptBudget: null, memoryPanelOpen: false, messageListRef: { current: null }, onChatInput: noop, onSendMessage: noop, onStopGeneration: noop, onRegenerate: noop, onGenerate: noop, onEditMessage: noop, onEditingDraft: noop, onSaveEdit: noop, onCancelEdit: noop, onDeleteMessage: noop, onOpenSettings: noop, onGoToLibrary: noop, onMemoryPanelToggle: noop };
  let resolveOld!: (value: PromptPreviewResponse) => void;
  const result = (label: string): PromptPreviewResponse => ({ messages: [], regions: [{ key: "character_core", label, tokens: 1 }], totalTokens: 1, recentMessageCount: 0, redactions: 0, diagnostics: [] });
  const request = vi.spyOn(api, "promptPreview").mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValue(result("Latest branch preview"));
  const view = render(<ChatView {...props} />);
  fireEvent.click(document.querySelector('.prompt-preview > summary')!);
  await act(async () => { await vi.advanceTimersByTimeAsync(350); });
  expect(request).toHaveBeenCalledTimes(1);
  view.rerender(<ChatView {...props} activeConversation={{ ...conversation, activeBranchId: "new-branch", updatedAt: "2026-10-03T00:00:01.000Z" }} />);
  expect(request.mock.calls[0]?.[2]?.aborted).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(350); });
  expect(screen.getByText("Latest branch preview")).toBeInTheDocument();
  await act(async () => { resolveOld(result("Obsolete original preview")); });
  expect(screen.queryByText("Obsolete original preview")).toBeNull();
  expect(screen.getByText("Latest branch preview")).toBeInTheDocument();
});
