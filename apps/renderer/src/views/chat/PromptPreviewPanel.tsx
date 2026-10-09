import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { PromptPreviewResponse } from "@mycompanion/shared";

import { promptPreview } from "../../api";
import { Icon } from "../../components";
import { TokenAccountingDetails } from "../TokenAccountingDetails";

/** 折叠态的一行摘要：压平换行、截断，让同角色的多条消息能被区分开。 */
function contentSnippet(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 140)}…` : flat;
}

/* 图例按区域 key 归并，标签也应描述区域而不是后端的内部标识符（main、
   charDescription 等）。已知 key 用固定中文名；未认识的 key 回落到后端标签。 */
const REGION_LABELS: Record<string, string> = {
  character_core: "角色核心",
  example_dialogue: "示例对话",
  worldbook_constant: "常驻世界书",
  worldbook: "世界书",
  memory: "检索记忆",
  memory_pinned: "固定记忆",
  stage_summary: "阶段摘要",
  plugins: "插件",
  extension_prompts: "其他注入",
  post_history: "历史后指令",
  current_input: "当前输入",
};
const regionLabel = (key: string, fallback: string): string => REGION_LABELS[key] ?? fallback;

// 发送前的完整提示词预览（默认收起，展开才请求；与真实请求相同组装，凭据已脱敏）。
export function PromptPreviewPanel({
  conversationId,
  sourceRevision,
  draft,
  isGenerating,
}: {
  conversationId: string;
  sourceRevision: string;
  draft: string;
  isGenerating: boolean;
}) {
  const { t } = useTranslation();
  const roleLabel = (role: string): string => role === "system" ? t("系统提示词") : role === "user" ? t("用户") : t("助手");
  // 默认收起（发送前按需展开）；收起时不发起预览请求。
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<PromptPreviewResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setPreview(null); setError(null); setExpanded({});
  }, [conversationId, sourceRevision]);

  // 草稿变化后自动刷新（防抖）；与真实请求相同组装，凭据已脱敏。
  // 面板收起时不请求。
  useEffect(() => {
    if (!open || isGenerating) { setIsLoading(false); return; }
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);
    const timer = setTimeout(() => {
      promptPreview(conversationId, draft, controller.signal)
        .then((result) => { if (!controller.signal.aborted) setPreview(result); })
        .catch((cause: unknown) => {
          if (controller.signal.aborted || cause instanceof DOMException && cause.name === "AbortError") return;
          setError(t("提示词预览加载失败。"));
        })
        .finally(() => {
          if (!controller.signal.aborted) setIsLoading(false);
        });
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, conversationId, sourceRevision, draft, isGenerating]);

  const toggleRegion = useCallback((messageIndex: number) => {
    setExpanded((current) => ({
      ...current,
      [`message-${messageIndex}`]: !current[`message-${messageIndex}`],
    }));
  }, []);

  return (
    <details className="prompt-preview" open={open}>
      <summary onClick={(event) => { event.preventDefault(); setOpen((value) => !value); }}>
        <Icon name="book" size={14} />
        {t("提示词预览")}
        <span>
          {open
            ? <>{t("约 {{tokens}} token", { tokens: preview?.totalTokens ?? "…" })}{isLoading ? t(" · 更新中") : ""}</>
            : t("发送前查看完整提示词（已脱敏）")}
        </span>
      </summary>
      {error ? <p className="prompt-preview__error">{error}</p> : null}
      {preview ? (
        <div className="prompt-preview__body">
          {/* 区域用量条：把 token 花在哪一段画出来，避免只看到一串数字。
              只统计后端明确归类的区域——不把"总量减去已知"的差额算作某个区域，
              那样会把未计入的正文伪装成"近期对话"（曾实测占到 95%）。 */}
          {(() => {
            const byKey = new Map<string, { key: string; label: string; tokens: number }>();
            for (const region of preview.regions) {
              if (region.tokens <= 0) continue;
              const existing = byKey.get(region.key);
              // 同一 key 可能对应多条提示词（如 main 与 charDescription 都归 character_core），
              // 合并计数，避免同名图例重复、占比被拆小。
              if (existing) existing.tokens += region.tokens;
              else byKey.set(region.key, { key: region.key, label: region.label, tokens: region.tokens });
            }
            const parts = [...byKey.values()];
            const sum = parts.reduce((total, part) => total + part.tokens, 0);
            if (!sum) return null;
            return (
              <div className="prompt-preview__breakdown">
                <div className="prompt-preview__bar" aria-hidden="true">
                  {parts.map(part => (
                    <span
                      className={`prompt-preview__bar-seg prompt-preview__bar-seg--${part.key}`}
                      key={part.key}
                      style={{ flexGrow: part.tokens }}
                      title={`${t(regionLabel(part.key, part.label))}：${t("约 {{tokens}} token", { tokens: part.tokens })}`}
                    />
                  ))}
                </div>
                <ul className="prompt-preview__legend">
                  {parts.map(part => (
                    <li className="prompt-preview__legend-item" key={part.key}>
                      <i aria-hidden="true" style={{ background: `var(--region-${part.key}, var(--text-faint))` }} />
                      <span>{t(regionLabel(part.key, part.label))}</span>
                      {/* 只给绝对用量：后端仅归类了部分区域（其余是近期对话正文），
                          百分比会让人误以为占满整个提示词。 */}
                      <small>{t("约 {{tokens}} token", { tokens: part.tokens })}</small>
                    </li>
                  ))}
                </ul>
                {/* 条数无法从 token 反推，单独给出；占比只对上面已归类的区域成立。 */}
                <p className="prompt-preview__legend-note">{t("近期原始对话 {{count}} 条进入上下文", { count: preview.recentMessageCount })}</p>
              </div>
            );
          })()}
          <TokenAccountingDetails accounting={preview.tokenAccounting} />
          {/* 被裁剪的内容必须仍然可见（FR-PROMPT-003），单独成一个告警块。 */}
          {preview.diagnostics.length ? (
            <ul className="prompt-preview__diagnostics">
              {preview.diagnostics.map((line) => (
                <li key={line}><strong>{t("被裁剪")}</strong><small>{line}</small></li>
              ))}
            </ul>
          ) : null}
          <div className="prompt-preview__messages">
            <div className="prompt-preview__messages-head">
              <span>{t("最终请求消息")}</span>
              <small>{t("{{count}} 条", { count: preview.messages.length })}</small>
            </div>
            {preview.messages.map((message, index) => {
              const expandedKey = `message-${index}`;
              const isExpanded = !!expanded[expandedKey];
              const snippet = contentSnippet(message.content);
              return (
                <details className="prompt-preview__message" key={expandedKey} open={isExpanded}>
                  <summary onClick={(event) => { event.preventDefault(); toggleRegion(index); }}>
                    <span className={`prompt-preview__role prompt-preview__role--${message.role}`}>{roleLabel(message.role)}</span>
                    <span className="prompt-preview__snippet">{message.name ? `${message.name} · ` : ""}{snippet || t("（空内容）")}</span>
                    <small>{isExpanded ? t("收起") : t("展开")}</small>
                  </summary>
                  {isExpanded ? <pre className="prompt-preview__content">{message.content}</pre> : null}
                </details>
              );
            })}
          </div>
        </div>
      ) : null}
      {isGenerating ? <p className="prompt-preview__hint">{t("生成中，预览仅反映发送前的草稿。")}</p> : null}
    </details>
  );
}
