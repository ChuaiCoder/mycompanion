import { useTranslation } from "react-i18next";
import "../../i18n";

import type { ConversationDetail, PromptBudgetReport } from "@mycompanion/shared";

/** 累计 token 的紧凑写法：950 / 12.3k / 3.4M。 */
function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

// 输入区下方的状态栏：只展示有真实数据来源的会话统计——回复轮数、提供商报告的
// 累计用量与缓存命中率（来自各消息的 generationMetadata.usage）、最近一次生成的
// 上下文占用（来自提示词预算报告）。拿不到来源的指标（如 tok/s）宁可不显示。
export function ChatStatusBar({ activeConversation, lastPromptBudget }: {
  activeConversation: ConversationDetail | null;
  lastPromptBudget: PromptBudgetReport | null;
}) {
  const { t } = useTranslation();
  if (!activeConversation) return null;
  const replies = activeConversation.messages.filter(message => message.role === "assistant").length;
  let totalTokens = 0, inputTokens = 0, cachedTokens = 0, hasUsage = false;
  for (const message of activeConversation.messages) {
    const usage = message.generationMetadata?.usage;
    if (!usage) continue;
    hasUsage = true;
    totalTokens += usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    inputTokens += usage.inputTokens ?? 0;
    cachedTokens += usage.cachedInputTokens ?? 0;
  }
  const cacheHit = inputTokens > 0 && cachedTokens > 0
    ? Math.min(100, Math.round((cachedTokens / inputTokens) * 100)) : null;
  const contextUsed = lastPromptBudget && lastPromptBudget.contextLimitTokens > 0
    ? Math.round((lastPromptBudget.totalTokens / lastPromptBudget.contextLimitTokens) * 100) : null;
  return (
    <div className="chat-statusbar">
      <span>{t("{{count}} 轮回复", { count: replies })}</span>
      {hasUsage ? <span>{t("累计 {{tokens}} tok", { tokens: formatTokens(totalTokens) })}</span> : null}
      {cacheHit !== null ? <span>{t("缓存命中 {{percent}}%", { percent: cacheHit })}</span> : null}
      {contextUsed !== null ? <span>{t("上下文 {{percent}}%", { percent: contextUsed })}</span> : null}
    </div>
  );
}
