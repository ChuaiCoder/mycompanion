import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import type { ChatMessage, ConversationDetail, WorldInfoDocument } from "@mycompanion/shared";

import { characterInitial } from "../../components";
import { fetchCardVariables, fetchCharacter, fetchConversation, mutateCardVariables } from "../../api";
import { buildRuntimeModuleScript, planCardRuntime } from "../../frontend-card-runtime";
import { listWorldInfoNames, loadWorldInfo, saveWorldInfo } from "../../world-info-api";
import { frontendCardOf } from "../../frontend-card";
import { useDisplayText } from "../../display-text";
import { renderMessageContent } from "../../message-rendering";
import { selectMessageSwipe } from "../../swipe-runtime";
import { MessageTokenUsage } from "../TokenAccountingDetails";
import { ReplyCandidates } from "../ReplyCandidates";
import { GenerationDetails } from "../GenerationDetails";
import { FrontendCardMessage } from "./FrontendCardMessage";

// 卡自带运行时（MVU 等）的模块源码按角色缓存：同一张卡的所有故事共用一份，
// 避免每条卡片消息都重新拉取角色详情。
const runtimeSourceCache = new Map<string, string | undefined>();

function statusLabel(message: ChatMessage): string | null {
  if (message.status === "failed") return "生成失败";
  if (message.status === "stopped") return "已停止";
  if (message.status === "streaming") return "生成中…";
  if (message.generationMetadata?.completionOutcome === "truncated") return "达到回复长度";
  return null;
}

// Extensions own the rendered children. React only replaces them when the
// underlying message changes, so typing and navigation preserve their UI.
function MessageContent({ message, index, characterName, conversation, onSwiped, onSendMessage, onDeleteMessage, onRegenerate, onGenerate, onStopGeneration }: {
  message: ChatMessage; index: number; characterName: string; conversation: ConversationDetail;
  onSwiped?: ((conversationId: string) => Promise<void> | void) | undefined;
  onStopGeneration?: (() => Promise<void> | void) | undefined;
  onSendMessage?: ((input: string) => void) | undefined;
  onDeleteMessage: (messageId: string) => void;
  onRegenerate: () => void;
  /** 按当前上下文生成（卡片的 /trigger）。 */
  onGenerate?: (() => void) | undefined;
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
  // 卡自带的运行时（MVU 等）以数据形式存在角色卡的扩展字段里，需要按角色取一次。
  const [runtimeSource, setRuntimeSource] = useState<string | undefined>(undefined);
  const characterId = conversation.characterId;
  useEffect(() => {
    if (!card) return;
    if (runtimeSourceCache.has(characterId)) {
      setRuntimeSource(runtimeSourceCache.get(characterId));
      return;
    }
    let active = true;
    void (async () => {
      let source: string | undefined;
      try {
        const character = await fetchCharacter(characterId);
        const plan = planCardRuntime(character.rawExtensions as Record<string, unknown> | undefined);
        source = plan ? buildRuntimeModuleScript(plan) : undefined;
      } catch {
        // 取不到角色详情时只是没有运行时，卡片其余部分照常工作。
        source = undefined;
      }
      runtimeSourceCache.set(characterId, source);
      if (active) setRuntimeSource(source);
    })();
    return () => { active = false; };
  }, [card, characterId]);
  useLayoutEffect(() => {
    if (card || !element.current) return;
    renderMessageContent(element.current, content, name, isSystem, isUser, index);
  }, [card, content, name, isSystem, isUser, index]);
  if (card) {
    return (
      <FrontendCardMessage
        markup={card.markup}
        messageId={message.id}
        runtimeSource={runtimeSource}
        hostGlobals={{
          // 卡自带运行时（MVU 等）直接引用这些对象；缺了它们模块会在顶层抛错。
          __hostConversationId: conversation.id,
          __hostCharacterName: characterName,
          __hostChat: conversation.messages.map(item => ({
            name: item.role === "user" ? "User" : characterName,
            is_user: item.role === "user",
            is_system: false,
            mes: item.content,
            send_date: item.createdAt,
            extra: item.extensionData ?? {},
          })),
        }}
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
          onTrigger: () => {
            // 酒馆 /trigger 的语义是按当前上下文生成，而不是重新生成最后一条。
            // 卡的管道删掉占位后末条是 user 消息，此时重新生成无事可做（实测确认）。
            if (onGenerate) onGenerate(); else onRegenerate();
          },
          // `/trigger` 前先等生成空闲：卡的管道是 `/sys | /cut | /trigger`，而 `/sys` 自己
          // 会启动一次生成，宿主在"正在生成"时会静默跳过后续触发（实测过）。
          // 直接读取后端状态，避免依赖此处拿不到的 React 生成标志。
          onWaitForIdle: async () => {
            const deadline = Date.now() + 180_000;
            for (;;) {
              const detail = await fetchConversation(conversation.id).catch(() => null);
              const generating = (detail?.messages ?? []).some(item => item.status === "streaming");
              if (!generating || Date.now() > deadline) return;
              await new Promise(resolve => setTimeout(resolve, 500));
            }
          },
          // `/cut` 删除的消息可能正在生成，先中止以免生成输出随消息消失。
          onCancelGeneration: async () => { await onStopGeneration?.(); },
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
  /** 按当前上下文生成（卡片的 /trigger）。 */
  onGenerate?: (() => void) | undefined;
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
  onGenerate,
  onStopGeneration,
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
  /** 按当前上下文生成（卡片的 /trigger）。 */
  onGenerate?: (() => void) | undefined;
  onStopGeneration?: (() => Promise<void> | void) | undefined;
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
        <MessageContent message={message} index={index} characterName={name} conversation={conversation} onSwiped={onSwiped} onSendMessage={onSendMessage} onDeleteMessage={onDeleteMessage} onRegenerate={onRegenerate} onGenerate={onGenerate} onStopGeneration={onStopGeneration} />
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
