import { useState } from "react";
import { useTranslation } from "react-i18next";
import "../i18n";
import type { ChatMessage, ModelToolRound } from "@mycompanion/shared";
import { MessageTokenUsage } from "./TokenAccountingDetails";
import { ModelMedia } from "./ModelMedia";

function ToolRound({ round, index, metadata }: { round: ModelToolRound; index: number; metadata: NonNullable<ChatMessage["generationMetadata"]> }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return <details className="tool-round" data-tool-round={index} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t("第 {{round}} 轮 · {{count}} 次工具调用", { round: index + 1, count: round.invocations.length })}</summary>
    {open ? <>
      {round.content ? <div><strong>{t("调用前的模型文本")}</strong><pre>{round.content}</pre></div> : null}
      {round.responseState.reasoning ? <details><summary>{t("推理文本")}</summary><pre>{round.responseState.reasoning}</pre></details> : null}
      <ModelMedia media={round.responseState.media} />
      {round.invocations.map(invocation => <details className="tool-invocation" key={invocation.id}>
        <summary>{invocation.displayName || invocation.name}{invocation.error ? t(" · 失败") : ""}</summary>
        <strong>{t("参数")}</strong><pre>{invocation.parameters}</pre>
        <strong>{t("结果")}</strong><pre>{invocation.result}</pre>
      </details>)}
      <MessageTokenUsage metadata={{ model: round.responseState.model ?? metadata.model, temperature: metadata.temperature, maxTokens: metadata.maxTokens,
        ...(round.usage ? { usage: round.usage } : {}), ...(round.tokenAccounting ? { tokenAccounting: round.tokenAccounting } : {}) }} />
    </> : null}
  </details>;
}

export function GenerationDetails({ metadata }: { metadata: ChatMessage["generationMetadata"] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!metadata) return null;
  const rounds = metadata.toolRounds;
  return <div className="generation-details">
    <ModelMedia media={metadata.responseState?.media} />
    {metadata.responseState?.reasoning ? <details className="model-reasoning"><summary>{t("模型推理文本")}</summary><pre>{metadata.responseState.reasoning}</pre></details> : null}
    {rounds?.length ? <details className="tool-rounds" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>{t("工具过程 · {{count}} 轮", { count: rounds.length })}</summary>
      {open ? rounds.map((round, index) => <ToolRound key={index} round={round} index={index} metadata={metadata} />) : null}
    </details> : null}
  </div>;
}
