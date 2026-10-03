import type {
  CharacterSummary,
  ConversationDetail,
  LorebookReport,
  MemoryRetrievalReport,
  PromptBudgetReport,
} from "@mycompanion/shared";

import { CharacterAvatar, Icon, Notice } from "../../components";
import { MemoryRetrievalDiagnostics } from "../MemoryRetrievalDiagnostics";
import { TokenAccountingDetails } from "../TokenAccountingDetails";

// 消息列表尾部 portal 的辅助内容：运行时错误、空态引导、生成指示与各轮诊断报告。
export function ChatAuxiliary({
  runtimeError,
  activeConversation,
  characters,
  hasRows,
  isGenerating,
  lastLorebookReport,
  lastMemoryReport,
  lastPromptBudget,
  onChatWithCharacter,
  onOpenImport,
}: {
  runtimeError: string | null;
  activeConversation: ConversationDetail | null;
  characters: CharacterSummary[];
  hasRows: boolean;
  isGenerating: boolean;
  lastLorebookReport: LorebookReport | null;
  lastMemoryReport: MemoryRetrievalReport | null;
  lastPromptBudget: PromptBudgetReport | null;
  onChatWithCharacter?: ((id: string) => void) | undefined;
  onOpenImport?: (() => void) | undefined;
}) {
  return (
    <>
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
      ) : activeConversation.messages.length === 0 && !hasRows ? <p className="panel-empty">输入第一句话，开始故事。</p> : null}
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
    </>
  );
}
