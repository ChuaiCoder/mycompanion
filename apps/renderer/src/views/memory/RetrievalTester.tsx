import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "../../i18n";

import type { MemoryRetrievalReport } from "@mycompanion/shared";

import { testMemory } from "../../api";
import { Icon } from "../../components";
import { memoryText } from "../../diagnostic-translations";
import { MemoryRetrievalDiagnostics } from "../MemoryRetrievalDiagnostics";

export interface RetrievalTesterProps {
  conversationId: string;
  sourceRevision?: string | undefined;
}

/** 检索测试器（FR-MEM-007）：对示例文本试跑检索，展示注入结果与诊断，不改真实聊天。 */
export function RetrievalTester({ conversationId, sourceRevision }: RetrievalTesterProps) {
  const { t, i18n } = useTranslation();
  const text = (value: string) => memoryText(i18n.language, value);
  const [testInput, setTestInput] = useState(() => text("我们现在在哪里？"));
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<MemoryRetrievalReport | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const tests = useRef(0);

  // 切换故事或来源变化时清空上一轮结果；输入草稿刻意保留，方便跨故事对比。
  useEffect(() => {
    setTestResult(null);
    setTestError(null);
    setIsTesting(false);
    tests.current++;
  }, [conversationId, sourceRevision]);

  const handleTest = async (): Promise<void> => {
    const revision = ++tests.current;
    setIsTesting(true);
    setTestError(null);
    try {
      const result = await testMemory(conversationId, testInput);
      if (revision === tests.current) setTestResult(result);
    } catch {
      if (revision === tests.current) setTestError("记忆检索测试失败，请重试。");
    } finally {
      if (revision === tests.current) setIsTesting(false);
    }
  };

  return (
    <div className="memory-panel__section" aria-busy={isTesting}>
      <h3>{text("检索测试器")}</h3>
      <p>{text("对示例文本跑一次检索，看看哪些记忆会被注入，不会修改真实聊天。")}</p>
      <textarea aria-label={text("检索测试文本")} onChange={(event) => setTestInput(event.target.value)} rows={3} value={testInput} />
      <button className="button button--primary button--small" disabled={isTesting} onClick={() => void handleTest()} type="button">
        <Icon name="sparkles" size={14} />
        {text(isTesting ? "正在检索…" : "运行检索")}
      </button>
      <p role="status">{isTesting ? text("正在检索…") : testError ? "" : testResult ? t("检索完成：注入 {{count}} 条记忆。", { count: testResult.injectedCount }) : ""}</p>
      {testError ? <p role="alert">{text(testError)}</p> : null}
      {testResult ? (
        <div className="memory-panel__test-result">
          {testResult.results.length === 0 ? <p className="panel-empty">{text("还没有可检索的记忆。")}</p> : testResult.results.map((result) => (
            <div key={result.memoryId} className={`memory-test-result ${result.injected ? "memory-test-result--injected" : "memory-test-result--skipped"}`}>
              <strong>{result.content ? `…${result.content.slice(0, 24)}` : text("（无内容）")}</strong>
              <span>{text(result.injected ? "已注入" : "未注入")} · {text("得分")} {result.score}</span>
              {result.diagnostics.length > 0 ? <small>{result.diagnostics.map(text).join(t("；"))}</small> : null}
            </div>
          ))}
          <p>{t("注入位置：近期消息之前（{{count}} 条 · 预算 {{budget}} token）", { count: testResult.injectedCount, budget: testResult.budgetTokens })}</p>
          <p>{text("注入内容：")}<code className="memory-item__content">{testResult.block || text("（本轮没有注入）")}</code></p>
          <MemoryRetrievalDiagnostics retrieval={testResult.retrieval} />
        </div>
      ) : null}
    </div>
  );
}
