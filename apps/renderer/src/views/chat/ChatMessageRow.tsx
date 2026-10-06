import { useLayoutEffect, useRef } from "react";
import type { KeyboardEvent } from "react";

import type { ChatMessage, ConversationDetail, WorldInfoDocument } from "@mycompanion/shared";

import { characterInitial } from "../../components";
import { fetchCardVariables, mutateCardVariables } from "../../api";
import { listWorldInfoNames, loadWorldInfo, saveWorldInfo } from "../../world-info-api";
import { frontendCardOf } from "../../frontend-card";
import { useDisplayText } from "../../display-text";
import { renderMessageContent } from "../../message-rendering";
import { selectMessageSwipe } from "../../swipe-runtime";
import { MessageTokenUsage } from "../TokenAccountingDetails";
import { ReplyCandidates } from "../ReplyCandidates";
import { GenerationDetails } from "../GenerationDetails";
import { FrontendCardMessage } from "./FrontendCardMessage";

function statusLabel(message: ChatMessage): string | null {
  if (message.status === "failed") return "生成失败";
  if (message.status === "stopped") return "已停止";
  if (message.status === "streaming") return "生成中…";
  if (message.generationMetadata?.completionOutcome === "truncated") return "达到回复长度";
  return null;
}

// Extensions own the rendered children. React only replaces them when the
// underlying message changes, so typing and navigation preserve their UI.
function MessageContent({ message, index, characterName, conversation, onSwiped, onSendMessage, onDeleteMessage, onRegenerate }: {
  message: ChatMessage; index: number; characterName: string; conversation: ConversationDetail;
  onSwiped?: ((conversationId: string) => Promise<void> | void) | undefined;
  onSendMessage?: ((input: string) => void) | undefined;
  onDeleteMessage: (messageId: string) => void;
  onRegenerate: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const extra = message.extensionData?.extra as Record<string, unknown> | undefined;
  const stored = typeof extra?.display_text === "string" ? extra.display_text : message.content;
  // 显示阶段正则的结果优先：卡把界面放在 `markdownOnly` 规则里时，这里才拿得到真实内容。
  const displayText = useDisplayText();
  const content = displayText.get(message.id) ?? stored;
  const name = typeof message.extensionData?.name === "string" ? message.extensionData.name : message.role === "user" ? "User" : characterName;
  const isSystem = message.extensionData?.is_system === true;
  const isUser = message.role === "user";
  // 前端卡内容交给隔离 iframe 渲染：它自带整份 HTML 文档与样式，放进主文档会污染界面。
  const card = frontendCardOf(content);
  useLayoutEffect(() => {
    if (card || !element.current) return;
    renderMessageContent(element.current, content, name, isSystem, isUser, index);
  }, [card, content, name, isSystem, isUser, index]);
  if (card) {
    return (
      <FrontendCardMessage
        markup={card.markup}
        messageId={message.id}
        bridge={{
          messages: conversation.messages,
          characterName,
          // 复用应用自己的候选切换链路（切完由 onSwiped 刷新故事）。
          onSelectSwipe: async (messageId, swipeId) => {
            await selectMessageSwipe({ conversationId: conversation.id, messageId }, swipeId);
            await onSwiped?.(conversation.id);
          },
          onSend: (text) => onSendMessage?.(text),
          // 变量每次按需读取后端，不在此缓存：生成期间的宏写入也会改这些变量。
          onReadVariables: async (target) => {
            const state = await fetchCardVariables(conversation.id);
            if (!target?.type) return state.variables;
            const scope = (state.scopes as Record<string, Record<string, unknown>>)[target.type];
            return scope ?? {};
          },
          onWriteVariables: async (mutation) => {
            await mutateCardVariables(conversation.id, mutation);
          },
          // 世界书：复用应用自己的世界书接口（保存即创建）。
          onListLorebooks: () => listWorldInfoNames(),
          onReadLorebook: async (name) => {
            const document = await loadWorldInfo(name);
            return document as unknown as Record<string, unknown> | null;
          },
          onWriteLorebook: async (name, document) => {
            await saveWorldInfo(name, document as unknown as WorldInfoDocument);
          },
          onDeleteMessage: async (messageId) => { await onDeleteMessage(messageId); },
          onTrigger: () => onRegenerate(),
        }}
      />
    );
  }
  return <div className="mes_text" ref={element} />;
}

function MessageActions({
  message,
  conversation,
  isGenerating,
  onEdit,
  onDelete,
  onRegenerate,
}: {
  message: ChatMessage;
  conversation: ConversationDetail;
  isGenerating: boolean;
  onEdit: (message: ChatMessage) => void;
  onDelete: (messageId: string) => void;
  onRegenerate: () => void;
}) {
  // 只有当前分支可达的消息可操作；重新生成仅对最后一条助手回复开放。
  const isActiveBranch = message.branchId === conversation.activeBranchId;
  if (!isActiveBranch) return null;
  const isLastAssistant =
    conversation.messages.at(-1)?.id === message.id && message.role === "assistant";
  return (
    <div className="message-actions" role="group" aria-label="消息操作">
      {message.status !== "streaming" ? (
        <button
          className="message-action mes_edit"
          disabled={isGenerating}
          onClick={() => onEdit(message)}
          type="button"
        >
          编辑
        </button>
      ) : null}
      {isLastAssistant ? (
        <button
          className="message-action"
          disabled={isGenerating}
          onClick={onRegenerate}
          type="button"
        >
          重新生成
        </button>
      ) : null}
      <button
        className="message-action message-action--danger mes_delete"
        disabled={isGenerating}
        onClick={() => onDelete(message.id)}
        type="button"
      >
        删除
      </button>
    </div>
  );
}

// 单条消息的 portal 内容：作者行、正文/编辑器、token 用量、生成详情、分支候选与操作。
export function ChatMessageRow({
  message,
  index,
  name,
  conversation,
  generationControlsBusy,
  editingMessageId,
  editingDraft,
  onEditMessage,
  onEditingDraft,
  onSaveEdit,
  onCancelEdit,
  onDeleteMessage,
  onRegenerate,
  onActivateBranch,
  onSwiped,
  onSendMessage,
}: {
  message: ChatMessage;
  index: number;
  name: string;
  conversation: ConversationDetail;
  generationControlsBusy: boolean;
  editingMessageId: string | null;
  editingDraft: string;
  onEditMessage: (message: ChatMessage) => void;
  onEditingDraft: (value: string) => void;
  onSaveEdit: (messageId: string) => void;
  onCancelEdit: () => void;
  onDeleteMessage: (messageId: string) => void;
  onRegenerate: () => void;
  onActivateBranch?: ((conversationId: string, branchId: string) => Promise<void>) | undefined;
  onSwiped?: ((conversationId: string) => Promise<void> | void) | undefined;
  onSendMessage?: ((input: string) => void) | undefined;
}) {
  const handleEditKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSaveEdit(message.id);
    } else if (event.key === "Escape") {
      onCancelEdit();
    }
  };
  return (
    <>
      <div className="chat-message__author">
        <span>{message.role === "user" ? "你" : characterInitial(name)}</span>
        <strong className="ch_name"><span className="name_text">{typeof message.extensionData?.name === "string" ? message.extensionData.name : message.role === "user" ? "你" : name}</span></strong>
        <small>{statusLabel(message)}</small>
      </div>
      {editingMessageId === message.id ? (
        <div className="chat-message__editor">
          <textarea
            className="edit_textarea"
            aria-label="编辑消息"
            defaultValue={message.content}
            onChange={(event) => onEditingDraft(event.target.value)}
            onKeyDown={handleEditKeyDown}
            rows={Math.max(3, Math.ceil(message.content.length / 40))}
          />
          <div className="chat-message__editor-actions">
            <button className="button button--primary button--small mes_edit_done" disabled={!editingDraft.trim()} onClick={() => onSaveEdit(message.id)} type="button">保存</button>
            <button className="button button--quiet button--small mes_edit_cancel" onClick={onCancelEdit} type="button">取消</button>
          </div>
        </div>
      ) : (
        <MessageContent message={message} index={index} characterName={name} conversation={conversation} onSwiped={onSwiped} onSendMessage={onSendMessage} onDeleteMessage={onDeleteMessage} onRegenerate={onRegenerate} />
      )}
      <MessageTokenUsage metadata={message.generationMetadata} />
      <GenerationDetails metadata={message.generationMetadata} />
      <ReplyCandidates message={message} conversation={conversation} disabled={generationControlsBusy} onActivateBranch={onActivateBranch} onSwiped={onSwiped} />
      <MessageActions
        conversation={conversation}
        isGenerating={generationControlsBusy}
        message={message}
        onDelete={onDeleteMessage}
        onEdit={onEditMessage}
        onRegenerate={onRegenerate}
      />
    </>
  );
}
