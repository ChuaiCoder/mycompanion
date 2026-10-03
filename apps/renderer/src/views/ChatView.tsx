import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { MessageSurface } from "../message-surface";

import type {
  ChatMessage,
  CharacterSummary,
  ConversationDetail,
  LorebookReport,
  MemoryRetrievalReport,
  PromptBudgetReport,
  StoryExportJson,
} from "@mycompanion/shared";

import type { MessageListRef } from "../components";
import { MemoryPanel } from "./MemoryPanel";
import { ChatHeader } from "./chat/ChatHeader";
import { ChatMessageRow } from "./chat/ChatMessageRow";
import { ChatAuxiliary } from "./chat/ChatAuxiliary";
import { ChatComposer } from "./chat/ChatComposer";
import { PromptPreviewPanel } from "./chat/PromptPreviewPanel";

export interface ChatViewProps {
  generationControlsBusy: boolean;
  activeConversation: ConversationDetail | null;
  characters?: CharacterSummary[];
  connectionLabel?: string;
  chatInput: string;
  isGenerating: boolean;
  runtimeError: string | null;
  editingMessageId: string | null;
  editingDraft: string;
  activeCommands: Array<{ name: string }>;
  lastLorebookReport: LorebookReport | null;
  lastMemoryReport: MemoryRetrievalReport | null;
  lastPromptBudget: PromptBudgetReport | null;
  memoryPanelOpen: boolean;
  messageListRef: MessageListRef;
  onChatInput: (value: string) => void;
  onChatWithCharacter?: (id: string) => void;
  onOpenImport?: () => void;
  onSendMessage: (input: string) => void;
  onStopGeneration: () => void;
  onRegenerate: () => void;
  onContinue?: () => void;
  onImpersonate?: () => void;
  onActivateBranch?: (conversationId: string, branchId: string) => Promise<void>;
  onSwiped?: (conversationId: string) => Promise<void> | void;
  onEditMessage: (message: ChatMessage) => void;
  onEditingDraft: (value: string) => void;
  onSaveEdit: (messageId: string) => void;
  onCancelEdit: () => void;
  onDeleteMessage: (messageId: string) => void;
  onOpenSettings: () => void;
  onGoToLibrary: () => void;
  onMemoryPanelToggle: () => void;
  sourceFocus?: { conversationId: string; messageId: string; revision: number } | null;
  onOpenMemorySource?: (conversationId: string, message: StoryExportJson["messages"][number]) => void;
}

// 聊天页组装层：持有 MessageSurface 绑定与来源聚焦，具体区块见 views/chat/ 下的子组件。
export function ChatView({
  generationControlsBusy,
  activeConversation,
  characters = [],
  connectionLabel = "未连接模型",
  chatInput,
  isGenerating,
  runtimeError,
  editingMessageId,
  editingDraft,
  activeCommands,
  lastLorebookReport,
  lastMemoryReport,
  lastPromptBudget,
  memoryPanelOpen,
  messageListRef,
  onChatInput,
  onChatWithCharacter,
  onOpenImport,
  onSendMessage,
  onStopGeneration,
  onRegenerate,
  onContinue,
  onImpersonate,
  onEditMessage,
  onEditingDraft,
  onSaveEdit,
  onCancelEdit,
  onDeleteMessage,
  onOpenSettings,
  onMemoryPanelToggle,
  sourceFocus,
  onOpenMemorySource,
  onActivateBranch,
  onSwiped,
}: ChatViewProps) {
  const [surface] = useState(() => new MessageSurface());
  const [, updateSurface] = useState(0);
  useLayoutEffect(() => {
    if (!messageListRef.current) return;
    return surface.bind(messageListRef.current, () => updateSurface(value => value + 1));
  }, [surface, messageListRef]);
  useLayoutEffect(() => { surface.sync(activeConversation); }, [surface, activeConversation]);
  useLayoutEffect(() => {
    if (!sourceFocus || sourceFocus.conversationId !== activeConversation?.id) return;
    surface.ensureVisible(sourceFocus.messageId);
    const row = surface.rows.find(value => value.message.id === sourceFocus.messageId);
    if (!row) return;
    surface.rows.forEach(value => value.element.classList.remove("chat-message--source"));
    row.element.classList.add("chat-message--source"); row.element.tabIndex = -1;
    row.element.scrollIntoView?.({ block: "center", behavior: "smooth" }); row.element.focus({ preventScroll: true });
  }, [surface, activeConversation, sourceFocus]);
  return (
    <main className={`runtime-shell ${memoryPanelOpen && activeConversation ? "runtime-shell--memory" : ""}`}>
      <section className="chat-pane" aria-label="角色对话">
        <ChatHeader
          activeConversation={activeConversation}
          memoryPanelOpen={memoryPanelOpen}
          isGenerating={isGenerating}
          onMemoryPanelToggle={onMemoryPanelToggle}
          onStopGeneration={onStopGeneration}
          onOpenSettings={onOpenSettings}
        />
        <div id="chat" className="chat-message-list" ref={messageListRef} />
          {surface.rows.map(({ message, index, element, name, key }) => activeConversation ? createPortal(
            <ChatMessageRow
              conversation={activeConversation}
              editingDraft={editingDraft}
              editingMessageId={editingMessageId}
              generationControlsBusy={generationControlsBusy}
              index={index}
              message={message}
              name={name}
              onActivateBranch={onActivateBranch}
              onCancelEdit={onCancelEdit}
              onDeleteMessage={onDeleteMessage}
              onEditMessage={onEditMessage}
              onEditingDraft={onEditingDraft}
              onRegenerate={onRegenerate}
              onSaveEdit={onSaveEdit}
              onSwiped={onSwiped}
            />, element, key) : null)}
        {createPortal(
          <ChatAuxiliary
            activeConversation={activeConversation}
            characters={characters}
            hasRows={surface.rows.length > 0}
            isGenerating={isGenerating}
            lastLorebookReport={lastLorebookReport}
            lastMemoryReport={lastMemoryReport}
            lastPromptBudget={lastPromptBudget}
            runtimeError={runtimeError}
            onChatWithCharacter={onChatWithCharacter}
            onOpenImport={onOpenImport}
          />, surface.auxiliary)}
        {activeConversation ? (
          <PromptPreviewPanel
            conversationId={activeConversation.id}
            sourceRevision={activeConversation.activeBranchId + "/" + activeConversation.updatedAt}
            draft={chatInput.trim()}
            isGenerating={isGenerating}
          />
        ) : null}
        <ChatComposer
          activeCommands={activeCommands}
          activeConversation={activeConversation}
          chatInput={chatInput}
          connectionLabel={connectionLabel}
          editingMessageId={editingMessageId}
          generationControlsBusy={generationControlsBusy}
          isGenerating={isGenerating}
          onChatInput={onChatInput}
          onContinue={onContinue}
          onImpersonate={onImpersonate}
          onOpenImport={onOpenImport}
          onOpenSettings={onOpenSettings}
          onSendMessage={onSendMessage}
          onStopGeneration={onStopGeneration}
        />
      </section>
      {memoryPanelOpen && activeConversation ? (
        <aside className="memory-side-pane" aria-label="记忆中心">
          <div className="memory-side-pane__bar">
            <strong>记忆中心</strong>
            <button type="button" onClick={onMemoryPanelToggle}>关闭</button>
          </div>
          <MemoryPanel
            conversationId={activeConversation.id}
            conversationTitle={activeConversation.title}
            runtimeError={runtimeError}
            sourceRevision={activeConversation.activeBranchId + "/" + activeConversation.updatedAt}
            navigationBusy={generationControlsBusy}
            onOpenSource={onOpenMemorySource}
          />
        </aside>
      ) : null}
    </main>
  );
}
