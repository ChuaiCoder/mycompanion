import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ConversationDetail } from "@mycompanion/shared";
import { ChatView, type ChatViewProps } from "./ChatView";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
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
