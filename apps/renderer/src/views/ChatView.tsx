import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { MessageSurface } from "../message-surface";

import type {
  ChatMessage,
  CharacterSummary,
  ConversationDetail,
  ConversationSummary,
  LorebookReport,
  MemoryRetrievalReport,
  PromptBudgetReport,
  PromptPreviewResponse,
  StoryExportJson,
} from "@mycompanion/shared";

import { promptPreview, storyExportUrl } from "../api";
import {
  CharacterAvatar,
  characterInitial,
  Icon,
  Notice,
  type MessageListRef,
} from "../components";
import { MemoryPanel } from "./MemoryPanel";
import { MemoryRetrievalDiagnostics } from "./MemoryRetrievalDiagnostics";
import { MessageTokenUsage, TokenAccountingDetails } from "./TokenAccountingDetails";
import { renderMessageContent } from "../message-rendering";
import { ReplyCandidates } from "./ReplyCandidates";
import { GenerationDetails } from "./GenerationDetails";

export interface ChatViewProps {
  generationControlsBusy: boolean;
  conversations: ConversationSummary[];
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
  onOpenConversation: (id: string) => void;
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

function statusLabel(message: ChatMessage): string | null {
  if (message.status === "failed") return "生成失败";
  if (message.status === "stopped") return "已停止";
  if (message.status === "streaming") return "生成中…";
  if (message.generationMetadata?.completionOutcome === "truncated") return "达到回复长度";
  return null;
}

// Extensions own the rendered children. React only replaces them when the
// underlying message changes, so typing and navigation preserve their UI.
function MessageContent({ message, index, characterName }: { message: ChatMessage; index: number; characterName: string }) {
  const element = useRef<HTMLDivElement>(null);
  const extra = message.extensionData?.extra as Record<string, unknown> | undefined;
  const content = typeof extra?.display_text === "string" ? extra.display_text : message.content;
  const name = typeof message.extensionData?.name === "string" ? message.extensionData.name : message.role === "user" ? "User" : characterName;
  const isSystem = message.extensionData?.is_system === true;
  const isUser = message.role === "user";
  useLayoutEffect(() => {
    if (element.current) renderMessageContent(element.current, content, name, isSystem, isUser, index);
  }, [content, name, isSystem, isUser, index]);
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

function PromptPreviewPanel({
  conversationId,
  sourceRevision,
  draft,
  isGenerating,
}: {
  conversationId: string;
  sourceRevision: string;
  draft: string;
  isGenerating: boolean;
}) {
  // 默认收起（发送前按需展开）；收起时不发起预览请求。
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<PromptPreviewResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setPreview(null); setError(null); setExpanded({});
  }, [conversationId, sourceRevision]);

  // 草稿变化后自动刷新（防抖）；与真实请求相同组装，凭据已脱敏。
  // 面板收起时不请求。
  useEffect(() => {
    if (!open || isGenerating) { setIsLoading(false); return; }
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);
    const timer = setTimeout(() => {
      promptPreview(conversationId, draft, controller.signal)
        .then((result) => { if (!controller.signal.aborted) setPreview(result); })
        .catch((cause: unknown) => {
          if (controller.signal.aborted || cause instanceof DOMException && cause.name === "AbortError") return;
          setError("提示词预览加载失败。");
        })
        .finally(() => {
          if (!controller.signal.aborted) setIsLoading(false);
        });
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, conversationId, sourceRevision, draft, isGenerating]);

  const toggleRegion = useCallback((messageIndex: number) => {
    setExpanded((current) => ({
      ...current,
      [`message-${messageIndex}`]: !current[`message-${messageIndex}`],
    }));
  }, []);

  return (
    <details className="prompt-preview" open={open}>
      <summary onClick={(event) => { event.preventDefault(); setOpen((value) => !value); }}>
        <Icon name="book" size={14} />
        提示词预览
        <span>
          {open
            ? <>约 {preview?.totalTokens ?? "…"} token{preview && preview.redactions > 0 ? ` · 已脱敏 ${preview.redactions} 处` : ""}{isLoading ? " · 更新中" : ""}</>
            : "发送前查看完整提示词（已脱敏）"}
        </span>
      </summary>
      {error ? <p className="prompt-preview__error">{error}</p> : null}
      {preview ? (
        <div className="prompt-preview__body">
          <TokenAccountingDetails accounting={preview.tokenAccounting} />
          <ul className="prompt-preview__regions">
            {preview.regions.map((region) => (
              <li key={region.key} className="prompt-preview__region">
                <strong>{region.label}</strong>
                <small>约 {region.tokens} token</small>
              </li>
            ))}
            <li className="prompt-preview__region">
              <strong>近期对话</strong>
              <small>{preview.recentMessageCount} 条进入上下文</small>
            </li>
            {preview.diagnostics.map((line) => (
              <li key={line} className="prompt-preview__region prompt-preview__region--dropped">
                <strong>被裁剪</strong>
                <small>{line}</small>
              </li>
            ))}
          </ul>
          {preview.messages.map((message, index) => {
            const expandedKey = `message-${index}`;
            const isExpanded = !!expanded[expandedKey];
            return (
              <details className="prompt-preview__message" key={expandedKey} open={isExpanded}>
                <summary onClick={(event) => { event.preventDefault(); toggleRegion(index); }}>
                  <strong>{message.role === "system" ? "系统提示词" : message.role === "user" ? "用户" : "助手"}</strong>
                  <small>{isExpanded ? "收起" : "展开"}</small>
                </summary>
                {isExpanded ? <pre className="prompt-preview__content">{message.content}</pre> : null}
              </details>
            );
          })}
        </div>
      ) : null}
      {isGenerating ? <p className="prompt-preview__hint">生成中，预览仅反映发送前的草稿。</p> : null}
    </details>
  );
}

export function ChatView({
  generationControlsBusy,
  conversations,
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
  onOpenConversation,
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
  onGoToLibrary,
  onMemoryPanelToggle,
  sourceFocus,
  onOpenMemorySource,
  onActivateBranch,
  onSwiped,
}: ChatViewProps) {
  const { i18n } = useTranslation(), en = i18n.language.startsWith("en");
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
  const composer = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (composer.current && composer.current.value !== chatInput) composer.current.value = chatInput;
  }, [chatInput]);
  const send = (): void => {
    const input = composer.current?.value ?? chatInput;
    if (!activeConversation || generationControlsBusy || !input.trim()) return;
    if (composer.current) composer.current.value = "";
    onSendMessage(input);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };
  const handleEditKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (editingMessageId) onSaveEdit(editingMessageId);
    } else if (event.key === "Escape") {
      onCancelEdit();
    }
  };
  return (
    <main className={`runtime-shell ${memoryPanelOpen && activeConversation ? "runtime-shell--memory" : ""}`}>
      <aside className="story-list-pane" aria-label="故事列表">
        <header><h1>故事</h1>{conversations.length > 0 ? <small>{conversations.length} 段</small> : null}</header>
        {conversations.length === 0 ? <p className="panel-empty">选择角色并点击“开始对话”，这里会保存每一段故事。</p> : (
          <ul>{conversations.map((conversation) => <li key={conversation.id}><button data-conversation-id={conversation.id} aria-pressed={activeConversation?.id === conversation.id} onClick={() => onOpenConversation(conversation.id)} type="button"><span className="story-row__title"><strong>{conversation.title}</strong><small>{conversation.messageCount} 条</small></span><span className="story-row__preview">{conversation.lastMessagePreview || "尚无消息"}</span></button></li>)}</ul>
        )}
      </aside>
      <section className="chat-pane" aria-label="角色对话">
        <header className="pane-header">
          <div className="pane-heading"><strong>{activeConversation?.characterName ?? "开始一段故事"}</strong><span>{activeConversation?.title ?? "聊天记录只保存在本机"}</span>{memoryPanelOpen && activeConversation ? <span className="pane-heading__flag">记忆面板已打开</span> : null}</div>
          <div className="pane-header-actions">
            {activeConversation ? <details className="story-export"><summary>导出故事</summary><a download href={storyExportUrl(activeConversation.id, "markdown")}>Markdown</a><a download href={storyExportUrl(activeConversation.id, "json")}>JSON（全部分支）</a></details> : null}
            <button aria-expanded={memoryPanelOpen} className="button button--quiet" disabled={!activeConversation} onClick={onMemoryPanelToggle} type="button">
              <Icon name="brain" size={16} />
              记忆
            </button>
            {isGenerating ? (
              <button className="button button--quiet" onClick={onStopGeneration} type="button">
                <Icon name="stop" size={16} />
                停止
              </button>
            ) : (
              <button className="button button--quiet" disabled={!activeConversation} onClick={onOpenSettings} type="button">
                <Icon name="settings" size={16} />
                模型设置
              </button>
            )}
          </div>
        </header>
        <div id="chat" className="chat-message-list" ref={messageListRef} />
          {surface.rows.map(({ message, index, element, name, key }) => createPortal(<>
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
                <MessageContent message={message} index={index} characterName={name} />
              )}
              <MessageTokenUsage metadata={message.generationMetadata} />
              <GenerationDetails metadata={message.generationMetadata} />
              {activeConversation ? <ReplyCandidates message={message} conversation={activeConversation} disabled={generationControlsBusy} onActivateBranch={onActivateBranch} onSwiped={onSwiped} /> : null}
              {activeConversation && <MessageActions
                conversation={activeConversation}
                isGenerating={generationControlsBusy}
                message={message}
                onDelete={onDeleteMessage}
                onEdit={onEditMessage}
                onRegenerate={onRegenerate}
              />}
            </>, element, key))}
        {createPortal(<>
          {runtimeError ? <Notice tone="error">{runtimeError}</Notice> : null}
          {!activeConversation ? (
            <section className="empty-workspace chat-onboarding" aria-labelledby="chat-welcome-title">
              <span aria-hidden="true" className="empty-workspace__mark"><Icon name="book" size={29} /></span>
              <h1 id="chat-welcome-title">开始一段故事</h1>
              <p>选择角色直接开聊；新故事从开场白开始，聊天记录只保存在本机。</p>
              {characters.length > 0 ? (
                <ul className="chat-onboarding__grid" aria-label="选择角色">
                  {characters.map((character) => (
                    <li key={character.id}>
                      <button type="button" onClick={() => onChatWithCharacter?.(character.id)}>
                        <CharacterAvatar character={character} />
                        <strong>{character.name}</strong>
                        <small>世界书 {character.lorebookEntryCount} · 正则 {character.regexScriptCount}</small>
                      </button>
                    </li>
                  ))}
                  <li>
                    <button className="chat-onboarding__import" type="button" onClick={onOpenImport}>
                      <span aria-hidden="true" className="chat-onboarding__plus"><Icon name="plus" size={19} /></span>
                      <strong>导入角色卡</strong>
                      <small>PNG / JSON / YAML / CHARX / BYAF</small>
                    </button>
                  </li>
                </ul>
              ) : (
                <div className="chat-onboarding__empty">
                  <button className="button button--primary" onClick={onOpenImport} type="button">导入第一张角色卡</button>
                  <small>支持 PNG、JSON、YAML、CHARX 或 BYAF，导入前会先显示完整预览。</small>
                </div>
              )}
            </section>
          ) : activeConversation.messages.length === 0 && surface.rows.length === 0 ? <p className="panel-empty">输入第一句话，开始故事。</p> : null}
          {isGenerating ? <div className="generating-indicator" role="status"><span /><span /><span />正在等待模型回复</div> : null}
          {lastLorebookReport && lastLorebookReport.results.length > 0 ? (
            <details className="chat-lorebook-report">
              <summary>
                <Icon name="book" size={14} />
                世界书触发
                <span>{lastLorebookReport.injectedCount > 0 ? `${lastLorebookReport.injectedCount} 条已注入提示词` : "本轮未注入"}</span>
              </summary>
              <ul>
                {lastLorebookReport.results.map((result) => (
                  <li key={result.index} className={`chat-lorebook-report__item chat-lorebook-report__item--${result.status}`}>
                    <strong>{result.name}</strong>
                    <small>
                      {result.status === "injected"
                        ? (result.matchedKey ? `关键词“${result.matchedKey}”命中` : "常驻注入")
                        : result.status === "disabled"
                          ? "未启用"
                          : result.status === "budget_dropped"
                            ? `超出 ${lastLorebookReport.budgetTokens} token 预算被舍弃`
                            : "未匹配"}
                    </small>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {lastMemoryReport && (lastMemoryReport.results.length > 0 || lastMemoryReport.retrieval) ? (
            <details className="chat-lorebook-report chat-memory-report">
              <summary>
                <Icon name="brain" size={14} />
                记忆检索
                <span>{lastMemoryReport.injectedCount > 0 ? `${lastMemoryReport.injectedCount} 条已注入提示词` : "本轮未注入"}</span>
              </summary>
              <ul>
                {lastMemoryReport.results.map((result) => (
                  <li key={result.memoryId} className={`chat-lorebook-report__item ${result.injected ? "chat-lorebook-report__item--injected" : "chat-lorebook-report__item--disabled"}`}>
                    <strong>{result.content ? `…${result.content.slice(0, 20)}` : "（无内容）"}</strong>
                    <small>
                      {result.injected ? "已注入" : "未注入"}
                      {result.diagnostics.length > 0 ? ` · ${result.diagnostics.join("；")}` : ""}
                    </small>
                  </li>
                ))}
              </ul>
              <MemoryRetrievalDiagnostics retrieval={lastMemoryReport.retrieval} />
            </details>
          ) : null}
          {lastPromptBudget ? (
            <details className="chat-lorebook-report chat-prompt-budget">
              <summary>
                <Icon name="book" size={14} />
                提示词预算
                <span>
                  约 {lastPromptBudget.totalTokens} / {lastPromptBudget.contextLimitTokens} token
                  {lastPromptBudget.diagnostics.length > 0 ? ` · 裁剪 ${lastPromptBudget.diagnostics.length} 项` : " · 未裁剪"}
                </span>
              </summary>
              <ul>
                {lastPromptBudget.regions.map((region) => (
                  <li key={region.key} className="chat-lorebook-report__item chat-lorebook-report__item--injected">
                    <strong>{region.label}</strong>
                    <small>约 {region.tokens} token</small>
                  </li>
                ))}
                <li className="chat-lorebook-report__item chat-lorebook-report__item--injected">
                  <strong>近期对话</strong>
                  <small>{lastPromptBudget.recentMessageCount} 条进入上下文</small>
                </li>
                {lastPromptBudget.diagnostics.map((line) => (
                  <li key={line} className="chat-lorebook-report__item chat-lorebook-report__item--budget_dropped">
                    <strong>被裁剪</strong>
                    <small>{line}</small>
                  </li>
                ))}
              </ul>
              <TokenAccountingDetails accounting={lastPromptBudget.tokenAccounting} />
            </details>
          ) : null}
        </>, surface.auxiliary)}
        {activeConversation ? (
          <PromptPreviewPanel
            conversationId={activeConversation.id}
            sourceRevision={activeConversation.activeBranchId + "/" + activeConversation.updatedAt}
            draft={chatInput.trim()}
            isGenerating={isGenerating}
          />
        ) : null}
        <form id="send_form" className="chat-composer" onSubmit={(event) => { event.preventDefault(); send(); }}>
          <textarea id="send_textarea" ref={composer} aria-label="输入消息" disabled={!activeConversation || isGenerating} onInput={(event) => onChatInput(event.currentTarget.value)} onKeyDown={handleKeyDown} placeholder={activeConversation ? "输入消息，Enter 发送，Shift+Enter 换行" : "先选择或导入一个角色，开始一段故事"} rows={3} defaultValue={chatInput} />
          <div className="chat-composer__bar">
            <div className="chat-composer__side">
              <details className="composer-menu">
                <summary aria-label="更多操作" title="更多操作"><Icon name="plus" size={17} /></summary>
                <div className="composer-menu__popup" role="menu">
                  <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onOpenImport?.(); }}><Icon name="character" size={15} />添加角色卡</button>
                  <button id="option_continue" type="button" disabled={!onContinue || !activeConversation || activeConversation.messages.at(-1)?.role !== "assistant" || generationControlsBusy || Boolean(editingMessageId)} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onContinue?.(); }}><Icon name="book" size={15} />{en ? "Continue reply" : "续写回复"}</button>
                  <button id="option_impersonate" type="button" disabled={!onImpersonate || !activeConversation || generationControlsBusy || Boolean(editingMessageId)} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onImpersonate?.(); }}><Icon name="character" size={15} />{en ? "Draft my message" : "代写我的消息"}</button>
                </div>
              </details>
            </div>
            <div className="chat-composer__side chat-composer__side--right">
              <button className="composer-connection" onClick={onOpenSettings} title="模型设置" type="button">
                <span aria-hidden="true" className="status-dot" />
                <span>{connectionLabel}</span>
              </button>
              {generationControlsBusy ? (
                <button id="mes_stop" aria-label="停止生成" className="composer-send composer-send--stop" onClick={onStopGeneration} type="button">
                  <Icon name="stop" size={16} />
                </button>
              ) : (
                <button id="send_but" aria-label="发送消息" className="composer-send" disabled={!activeConversation} type="submit">
                  <span aria-hidden="true">↑</span>
                </button>
              )}
            </div>
          </div>
          {activeCommands.length > 0 ? <small className="chat-command-hint">可用插件命令：{activeCommands.map((command) => `/${command.name}`).join("、")}</small> : null}
        </form>
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
