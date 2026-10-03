import type { ChatMessage, TokenAccounting } from "@mycompanion/shared";
import { useTranslation } from "react-i18next";
import "../i18n";
import { tokenReasonText } from "../diagnostic-translations";

export function TokenAccountingDetails({ accounting }: { accounting?: TokenAccounting | undefined }) {
  const { i18n } = useTranslation(), en = i18n.language.startsWith("en");
  if (!accounting) return null;
  return <details className="token-accounting-details">
    <summary>{en ? "Token estimate details" : "Token 估算详情"}</summary>
    <p>{en ? `Local input estimate: ${accounting.promptTokens} token; model ${accounting.model}.` : `本地输入估算：${accounting.promptTokens} token；模型 ${accounting.model}。`}</p>
    <p>{en ? (accounting.textEstimated ? "Text uses a compatibility estimate." : `Text uses the ${accounting.encoding} tokenizer.`) + " Message framing is still estimated."
      : (accounting.textEstimated ? "文本使用兼容估算。" : `文本使用 ${accounting.encoding} 分词计算。`) + " 消息框架仍为估算。"}</p>
    {accounting.mediaEstimated ? <p>{en ? `Media estimate: ${accounting.mediaTokens} token.` : `媒体估算：${accounting.mediaTokens} token。`}</p> : null}
    {!accounting.complete ? <p>{en ? "Some request content is not counted; this estimate is incomplete." : "部分请求内容未计入，当前估算不完整。"}</p> : null}
    <ul>{accounting.reasons.map(reason => <li key={reason}>{tokenReasonText(reason,i18n.language)}</li>)}</ul>
  </details>;
}

export function MessageTokenUsage({ metadata }: { metadata: ChatMessage["generationMetadata"] }) {
  const { i18n } = useTranslation(), en = i18n.language.startsWith("en");
  const usage = metadata?.usage, accounting = metadata?.tokenAccounting;
  if (!usage && !accounting) return null;
  const difference = usage?.inputTokens !== undefined && accounting ? usage.inputTokens - accounting.promptTokens : undefined;
  return <details className="message-token-usage">
    <summary>{usage ? en ? "Provider-reported usage" : "提供商报告用量" : en ? "Token estimate" : "Token 估算"}</summary>
    {usage ? <dl>
      {usage.inputTokens !== undefined ? <><dt>{en ? "Input" : "输入"}</dt><dd>{usage.inputTokens} token</dd></> : null}
      {usage.outputTokens !== undefined ? <><dt>{en ? "Output" : "输出"}</dt><dd>{usage.outputTokens} token</dd></> : null}
      {usage.totalTokens !== undefined ? <><dt>{en ? "Total" : "总用量"}</dt><dd>{usage.totalTokens} token</dd></> : null}
      {usage.cachedInputTokens !== undefined ? <><dt>{en ? "Cached input" : "缓存输入"}</dt><dd>{usage.cachedInputTokens} token</dd></> : null}
      {usage.nonCachedInputTokens !== undefined ? <><dt>{en ? "Non-cached input" : "非缓存输入"}</dt><dd>{usage.nonCachedInputTokens} token</dd></> : null}
      {usage.cacheCreationInputTokens !== undefined ? <><dt>{en ? "Cache creation input" : "写入缓存"}</dt><dd>{usage.cacheCreationInputTokens} token</dd></> : null}
      {usage.candidatesOutputTokens !== undefined ? <><dt>{en ? "Candidate output" : "候选输出"}</dt><dd>{usage.candidatesOutputTokens} token</dd></> : null}
      {usage.toolInputTokens !== undefined ? <><dt>{en ? "Tool result input" : "工具结果输入"}</dt><dd>{usage.toolInputTokens} token</dd></> : null}
      {usage.reasoningTokens !== undefined ? <><dt>{en ? "Reasoning output" : "推理输出"}</dt><dd>{usage.reasoningTokens} token</dd></> : null}
    </dl> : null}
    {usage?.reasoningTokens !== undefined ? <p>{en ? "Reasoning is already included in the provider's output count and is not added to the total again." : "推理输出包含在提供商输出中，不再加到总用量。"}</p> : null}
    {difference !== undefined ? <p>{en ? "Provider input minus the local input estimate: " : "提供商输入与本地输入估算的差额："}{difference > 0 ? "+" : ""}{difference} token{en ? "." : "。"}</p> : null}
    <TokenAccountingDetails accounting={accounting} />
  </details>;
}
