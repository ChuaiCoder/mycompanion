import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "../../i18n";

import type { StageSummary } from "@mycompanion/shared";

import { getSummary, restoreSummary, saveSummary, setAutoSummary } from "../../api";
import { memoryText } from "../../diagnostic-translations";

export interface SummarySectionProps {
  conversationId: string;
  /** 保存/开关/恢复失败时上报给面板级错误区；调用方传入 null 表示清除。 */
  onPanelError: (message: string | null) => void;
}

/** 阶段摘要（FR-MEM-008）：摘要编辑、恢复上一版本、自动摘要开关。 */
export function SummarySection({ conversationId, onPanelError }: SummarySectionProps) {
  const { t, i18n } = useTranslation();
  const text = (value: string) => memoryText(i18n.language, value);
  const [autoSummaryEnabled, setAutoSummaryEnabled] = useState<boolean | null>(null);
  const [summary, setSummary] = useState<StageSummary | null>(null);
  const [summaryDraft, setSummaryDraft] = useState("");
  const [isSummaryBusy, setIsSummaryBusy] = useState(false);
  const [summaryLoadError, setSummaryLoadError] = useState(false);
  const [reloadRevision, setReloadRevision] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getSummary(conversationId)
      .then((value) => {
        if (cancelled) return;
        setAutoSummaryEnabled(value.autoSummaryEnabled);
        setSummary(value.summary);
        setSummaryDraft(value.summary?.content ?? "");
      })
      .catch(() => { if (!cancelled) setSummaryLoadError(true); });
    return () => { cancelled = true; };
  }, [conversationId, reloadRevision]);

  const handleToggleAutoSummary = async (): Promise<void> => {
    if (autoSummaryEnabled === null) return;
    const next = !autoSummaryEnabled;
    setAutoSummaryEnabled(next);
    onPanelError(null);
    try {
      await setAutoSummary(conversationId, next);
    } catch {
      if (mounted.current) {
        setAutoSummaryEnabled(!next);
        onPanelError("无法更改自动摘要开关，请重试。");
      }
    }
  };

  const handleSaveSummary = async (): Promise<void> => {
    const content = summaryDraft.trim();
    if (!content || content === summary?.content) return;
    setIsSummaryBusy(true);
    onPanelError(null);
    try {
      const saved = await saveSummary(conversationId, content);
      if (mounted.current) setSummary(saved);
    } catch {
      if (mounted.current) onPanelError("无法保存摘要，请重试。");
    } finally {
      if (mounted.current) setIsSummaryBusy(false);
    }
  };

  const handleRestoreSummary = async (): Promise<void> => {
    setIsSummaryBusy(true);
    onPanelError(null);
    try {
      const restored = await restoreSummary(conversationId);
      if (!mounted.current) return;
      setSummary(restored);
      setSummaryDraft(restored.content);
    } catch {
      if (mounted.current) onPanelError("无法恢复摘要上一版本，请重试。");
    } finally {
      if (mounted.current) setIsSummaryBusy(false);
    }
  };

  return (
    <div className="memory-panel__section">
      <div className="memory-panel__summary-header">
        <h3>{text("阶段摘要")}</h3>
        {autoSummaryEnabled !== null ? (
          <button
            aria-pressed={autoSummaryEnabled}
            className="button button--quiet button--small"
            onClick={() => void handleToggleAutoSummary()}
            type="button"
          >
            {text("自动摘要：")}{text(autoSummaryEnabled ? "开" : "关")}
          </button>
        ) : null}
      </div>
      <p>{text("摘要压缩较早的剧情以节省上下文；摘要失败不会阻塞聊天。")}{summary ? t("覆盖 {{count}} 条消息 · 模型 {{model}}", { count: summary.coveredMessageCount, model: summary.model }) : text("尚未生成；对话足够长后自动生成。")}</p>
      {summaryLoadError ? <div><p role="alert">{text("无法读取阶段摘要，请重试。")}</p><button type="button" onClick={() => setReloadRevision(value => value + 1)}>{text("重试读取阶段摘要")}</button></div> : null}
      {summary?.valid === false ? <p role="status">{text("来源已改变，需重新生成或校正；这份摘要暂不用于对话。")}</p> : null}
      <textarea
        aria-label={text("阶段摘要内容")}
        onChange={(event) => setSummaryDraft(event.target.value)}
        rows={4}
        value={summaryDraft}
      />
      <div className="memory-panel__actions">
        <button className="button button--primary button--small" disabled={isSummaryBusy || !summaryDraft.trim() || summaryDraft.trim() === summary?.content} onClick={() => void handleSaveSummary()} type="button">
          {text("保存摘要")}
        </button>
        <button className="button button--quiet button--small" disabled={isSummaryBusy || !summary?.previousContent} onClick={() => void handleRestoreSummary()} type="button">
          {text("恢复上一版本")}
        </button>
      </div>
    </div>
  );
}
