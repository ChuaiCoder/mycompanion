import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ConversationDetail, PromptPreviewResponse } from "@mycompanion/shared";
import * as api from "../api";
import { ChatView, type ChatViewProps } from "./ChatView";
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
it("focuses and highlights the actual source message, exposes both story exports, and explains truncated replies", () => {
  const conversation: ConversationDetail = { id: "story", characterId: "character", characterName: "旅人", title: "Story", lastMessagePreview: "reply", messageCount: 1, activeBranchId: "branch", createdAt: "2026-10-02", updatedAt: "2026-10-02", messages: [{ id: "source", conversationId: "story", branchId: "branch", parentMessageId: null, role: "assistant", content: "reply", status: "complete", createdAt: "2026-10-02", generationMetadata: { model: "fixture", temperature: 0.7, maxTokens: 300, completionOutcome: "truncated", finishReason: "length" } }] };
  const noop = () => {};
  const props: ChatViewProps = { activeConversation: conversation, conversations: [conversation], chatInput: "", isGenerating: false, generationControlsBusy: false, runtimeError: null, editingMessageId: null, editingDraft: "", activeCommands: [], lastLorebookReport: null, lastMemoryReport: null, lastPromptBudget: null, memoryPanelOpen: false, messageListRef: { current: null }, onChatInput: noop, onOpenConversation: noop, onSendMessage: noop, onStopGeneration: noop, onRegenerate: noop, onEditMessage: noop, onEditingDraft: noop, onSaveEdit: noop, onCancelEdit: noop, onDeleteMessage: noop, onOpenSettings: noop, onGoToLibrary: noop, onMemoryPanelToggle: noop, sourceFocus: { conversationId: "story", messageId: "source", revision: 1 } };
  render(<ChatView {...props} />);
  const row = document.querySelector('[data-message-id="source"]');
  expect(row).toHaveClass("chat-message--source"); expect(row).toHaveFocus(); expect(screen.getByText("达到回复长度")).toBeInTheDocument();
  expect(document.querySelector('a[href="/api/conversations/story/export?format=markdown"]')).not.toBeNull();
  expect(document.querySelector('a[href="/api/conversations/story/export?format=json"]')).not.toBeNull();
});

it("aborts a stale open preview on a same-story source revision and ignores its late response", async () => {
  vi.useFakeTimers();
  const conversation: ConversationDetail = { id: "preview-story", characterId: "character", characterName: "Role", title: "Story", lastMessagePreview: "", messageCount: 0, activeBranchId: "original", createdAt: "2026-10-03", updatedAt: "2026-10-03T00:00:00.000Z", messages: [] };
  const noop = () => {};
  const props: ChatViewProps = { activeConversation: conversation, conversations: [conversation], chatInput: "same draft", isGenerating: false, generationControlsBusy: false, runtimeError: null, editingMessageId: null, editingDraft: "", activeCommands: [], lastLorebookReport: null, lastMemoryReport: null, lastPromptBudget: null, memoryPanelOpen: false, messageListRef: { current: null }, onChatInput: noop, onOpenConversation: noop, onSendMessage: noop, onStopGeneration: noop, onRegenerate: noop, onEditMessage: noop, onEditingDraft: noop, onSaveEdit: noop, onCancelEdit: noop, onDeleteMessage: noop, onOpenSettings: noop, onGoToLibrary: noop, onMemoryPanelToggle: noop };
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
