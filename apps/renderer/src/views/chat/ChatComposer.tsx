import { useLayoutEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import type { ConversationDetail } from "@mycompanion/shared";

import { Icon } from "../../components";

// 底部输入区：消息输入框、更多操作菜单、连接状态与发送/停止按钮。
// 输入框保持非受控（defaultValue + ref 同步），与原有行为一致。
export function ChatComposer({
  activeConversation,
  chatInput,
  isGenerating,
  generationControlsBusy,
  editingMessageId,
  activeCommands,
  connectionLabel,
  connectionState,
  onChatInput,
  onSendMessage,
  onStopGeneration,
  onOpenSettings,
  onOpenImport,
  onContinue,
  onImpersonate,
}: {
  activeConversation: ConversationDetail | null;
  chatInput: string;
  isGenerating: boolean;
  generationControlsBusy: boolean;
  editingMessageId: string | null;
  activeCommands: Array<{ name: string }>;
  connectionLabel: string;
  /** 连接探测的真实状态；决定圆点颜色，与侧栏保持一致。 */
  connectionState?: "checking" | "online" | "offline" | undefined;
  onChatInput: (value: string) => void;
  onSendMessage: (input: string) => void;
  onStopGeneration: () => void;
  onOpenSettings: () => void;
  onOpenImport?: (() => void) | undefined;
  onContinue?: (() => void) | undefined;
  onImpersonate?: (() => void) | undefined;
}) {
  const { i18n } = useTranslation(), en = i18n.language.startsWith("en");
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
  return (
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
            <span aria-hidden="true" className={`status-dot${connectionState ? ` status-dot--${connectionState}` : ""}`} />
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
  );
}
