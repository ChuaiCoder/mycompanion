import type { MemoryRetrievalReport } from "@mycompanion/shared";
import { useTranslation } from "react-i18next";
import "../i18n";
import { memoryText } from "../diagnostic-translations";

export function MemoryRetrievalDiagnostics({ retrieval }: { retrieval: MemoryRetrievalReport["retrieval"] }) {
  const { i18n } = useTranslation(), en = i18n.language.startsWith("en"), text = (value:string) => memoryText(i18n.language,value);
  if (!retrieval) return null;
  return <details className="memory-retrieval-diagnostics">
    <summary>{text("高级检索诊断")}</summary>
    <dl>
      <dt>{text("本次检索方式")}</dt><dd>{text(retrieval.mode === "hybrid" ? "关键词与向量" : "关键词")}</dd>
      {retrieval.embeddingModel ? <><dt>{text("向量模型")}</dt><dd>{retrieval.embeddingModel}</dd></> : null}
      <dt>{text("索引进度")}</dt><dd>{en ? `${retrieval.indexedCount} indexed, ${retrieval.pendingCount} pending` : `已索引 ${retrieval.indexedCount} 条，待处理 ${retrieval.pendingCount} 条`}</dd>
      <dt>{text("相似度阈值")}</dt><dd>{retrieval.threshold}</dd>
    </dl>
    {retrieval.diagnostics.length ? <ul>{retrieval.diagnostics.map((message, index) => <li key={index}>{text(message)}</li>)}</ul> : null}
  </details>;
}
