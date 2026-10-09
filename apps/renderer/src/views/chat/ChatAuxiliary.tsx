import type {
  CharacterSummary,
  ConversationDetail,
  LorebookReport,
  MemoryRetrievalReport,
  PromptBudgetReport,
} from "@mycompanion/shared";
import { useTranslation } from "react-i18next";
import "../../i18n";

import { CharacterAvatar, Icon, Notice } from "../../components";
import { memoryText } from "../../diagnostic-translations";
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
  const { t, i18n } = useTranslation();
  const diagnostic = (value: string) => memoryText(i18n.language, value);
  return (
    <>
      {runtimeError ? <Notice tone="error">{t(runtimeError)}</Notice> : null}
      {!activeConversation ? (
        <section className="empty-workspace chat-onboarding" aria-labelledby="chat-welcome-title">
          <span aria-hidden="true" className="empty-workspace__mark"><Icon name="book" size={29} /></span>
          <h1 id="chat-welcome-title">{t("开始一段故事")}</h1>
          <p>{t("选择角色直接开聊；新故事从开场白开始，聊天记录只保存在本机。")}</p>
          {characters.length > 0 ? (
            <ul className="chat-onboarding__grid" aria-label={t("选择角色")}>
              {characters.map((character) => (
                <li key={character.id}>
                  <button type="button" onClick={() => onChatWithCharacter?.(character.id)}>
                    <CharacterAvatar character={character} />
                    <strong>{character.name}</strong>
                    <small>{t("世界书 {{lorebook}} · 正则 {{regex}}", { lorebook: character.lorebookEntryCount, regex: character.regexScriptCount })}</small>
                  </button>
                </li>
              ))}
              <li>
                <button className="chat-onboarding__import" type="button" onClick={onOpenImport}>
                  <span aria-hidden="true" className="chat-onboarding__plus"><Icon name="plus" size={19} /></span>
                  <strong>{t("导入角色卡")}</strong>
                  <small>PNG / JSON / YAML / CHARX / BYAF</small>
                </button>
              </li>
            </ul>
          ) : (
            <div className="chat-onboarding__empty">
              <button className="button button--primary" onClick={onOpenImport} type="button">{t("导入第一张角色卡")}</button>
              <small>{t("支持 PNG、JSON、YAML、CHARX 或 BYAF，导入前会先显示完整预览。")}</small>
            </div>
          )}
        </section>
      ) : activeConversation.messages.length === 0 && !hasRows ? <p className="panel-empty">{t("输入第一句话，开始故事。")}</p> : null}
      {isGenerating ? <div className="generating-indicator" role="status"><span /><span /><span />{t("正在等待模型回复")}</div> : null}
      {lastLorebookReport && lastLorebookReport.results.length > 0 ? (
        <details className="chat-lorebook-report">
          <summary>
            <Icon name="book" size={14} />
            {t("世界书触发")}
            <span>{lastLorebookReport.injectedCount > 0 ? t("{{count}} 条已注入提示词", { count: lastLorebookReport.injectedCount }) : t("本轮未注入")}</span>
          </summary>
          <ul>
            {lastLorebookReport.results.map((result) => (
              <li key={result.index} className={`chat-lorebook-report__item chat-lorebook-report__item--${result.status}`}>
                <strong>{result.name}</strong>
                <small>
                  {result.status === "injected"
                    ? (result.matchedKey ? t("关键词“{{key}}”命中", { key: result.matchedKey }) : t("常驻注入"))
                    : result.status === "disabled"
                      ? t("未启用")
                      : result.status === "budget_dropped"
                        ? t("超出 {{budget}} token 预算被舍弃", { budget: lastLorebookReport.budgetTokens })
                        : t("未匹配")}
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
            {t("记忆检索")}
            <span>{lastMemoryReport.injectedCount > 0 ? t("{{count}} 条已注入提示词", { count: lastMemoryReport.injectedCount }) : t("本轮未注入")}</span>
          </summary>
          <ul>
            {lastMemoryReport.results.map((result) => (
              <li key={result.memoryId} className={`chat-lorebook-report__item ${result.injected ? "chat-lorebook-report__item--injected" : "chat-lorebook-report__item--disabled"}`}>
                <strong>{result.content ? `…${result.content.slice(0, 20)}` : t("（无内容）")}</strong>
                <small>
                  {result.injected ? t("已注入") : t("未注入")}
                  {result.diagnostics.length > 0 ? ` · ${result.diagnostics.map(diagnostic).join("；")}` : ""}
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
            {t("提示词预算")}
            <span>
              {t("约 {{total}} / {{limit}} token", { total: lastPromptBudget.totalTokens, limit: lastPromptBudget.contextLimitTokens })}
              {lastPromptBudget.diagnostics.length > 0 ? t(" · 裁剪 {{count}} 项", { count: lastPromptBudget.diagnostics.length }) : t(" · 未裁剪")}
            </span>
          </summary>
          <ul>
            {lastPromptBudget.regions.map((region) => (
              <li key={region.key} className="chat-lorebook-report__item chat-lorebook-report__item--injected">
                <strong>{region.label}</strong>
                <small>{t("约 {{tokens}} token", { tokens: region.tokens })}</small>
              </li>
            ))}
            <li className="chat-lorebook-report__item chat-lorebook-report__item--injected">
              <strong>{t("近期对话")}</strong>
              <small>{t("{{count}} 条进入上下文", { count: lastPromptBudget.recentMessageCount })}</small>
            </li>
            {lastPromptBudget.diagnostics.map((line) => (
              <li key={line} className="chat-lorebook-report__item chat-lorebook-report__item--budget_dropped">
                <strong>{t("被裁剪")}</strong>
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
