import type { ChatMessage, TokenAccounting } from "@mycompanion/shared";
import { useTranslation } from "react-i18next";
import "../i18n";
import { tokenReasonText } from "../diagnostic-translations";

export function TokenAccountingDetails({ accounting }: { accounting?: TokenAccounting | undefined }) {
  const { t, i18n } = useTranslation();
  if (!accounting) return null;
  return <details className="token-accounting-details">
    <summary>{t("Token 估算详情")}</summary>
    <p>{t("本地输入估算：{{tokens}} token；模型 {{model}}。", { tokens: accounting.promptTokens, model: accounting.model })}</p>
    <p>{t(accounting.textEstimated ? "文本使用兼容估算。" : "文本使用 {{encoding}} 分词计算。", { encoding: accounting.encoding })}{t(" 消息框架仍为估算。")}</p>
    {accounting.mediaEstimated ? <p>{t("媒体估算：{{tokens}} token。", { tokens: accounting.mediaTokens })}</p> : null}
    {!accounting.complete ? <p>{t("部分请求内容未计入，当前估算不完整。")}</p> : null}
    <ul>{accounting.reasons.map(reason => <li key={reason}>{tokenReasonText(reason,i18n.language)}</li>)}</ul>
  </details>;
}

export function MessageTokenUsage({ metadata }: { metadata: ChatMessage["generationMetadata"] }) {
  const { t } = useTranslation();
  const usage = metadata?.usage, accounting = metadata?.tokenAccounting;
  if (!usage && !accounting) return null;
  const difference = usage?.inputTokens !== undefined && accounting ? usage.inputTokens - accounting.promptTokens : undefined;
  return <details className="message-token-usage">
    <summary>{usage ? t("提供商报告用量") : t("Token 估算")}</summary>
    {usage ? <dl>
      {usage.inputTokens !== undefined ? <><dt>{t("输入")}</dt><dd>{usage.inputTokens} token</dd></> : null}
      {usage.outputTokens !== undefined ? <><dt>{t("输出")}</dt><dd>{usage.outputTokens} token</dd></> : null}
      {usage.totalTokens !== undefined ? <><dt>{t("总用量")}</dt><dd>{usage.totalTokens} token</dd></> : null}
      {usage.cachedInputTokens !== undefined ? <><dt>{t("缓存输入")}</dt><dd>{usage.cachedInputTokens} token</dd></> : null}
      {usage.nonCachedInputTokens !== undefined ? <><dt>{t("非缓存输入")}</dt><dd>{usage.nonCachedInputTokens} token</dd></> : null}
      {usage.cacheCreationInputTokens !== undefined ? <><dt>{t("写入缓存")}</dt><dd>{usage.cacheCreationInputTokens} token</dd></> : null}
      {usage.candidatesOutputTokens !== undefined ? <><dt>{t("候选输出")}</dt><dd>{usage.candidatesOutputTokens} token</dd></> : null}
      {usage.toolInputTokens !== undefined ? <><dt>{t("工具结果输入")}</dt><dd>{usage.toolInputTokens} token</dd></> : null}
      {usage.reasoningTokens !== undefined ? <><dt>{t("推理输出")}</dt><dd>{usage.reasoningTokens} token</dd></> : null}
    </dl> : null}
    {usage?.reasoningTokens !== undefined ? <p>{t("推理输出包含在提供商输出中，不再加到总用量。")}</p> : null}
    {difference !== undefined ? <p>{t("提供商输入与本地输入估算的差额：{{value}} token。", { value: `${difference > 0 ? "+" : ""}${difference}` })}</p> : null}
    <TokenAccountingDetails accounting={accounting} />
  </details>;
}
