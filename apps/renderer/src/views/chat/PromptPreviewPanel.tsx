import { useCallback, useEffect, useState } from "react";

import type { PromptPreviewResponse } from "@mycompanion/shared";

import { promptPreview } from "../../api";
import { Icon } from "../../components";
import { TokenAccountingDetails } from "../TokenAccountingDetails";

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
          setError("提示词预览加载失败。");
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
        提示词预览
        <span>
          {open
            ? <>约 {preview?.totalTokens ?? "…"} token{preview && preview.redactions > 0 ? ` · 已脱敏 ${preview.redactions} 处` : ""}{isLoading ? " · 更新中" : ""}</>
            : "发送前查看完整提示词（已脱敏）"}
        </span>
      </summary>
      {error ? <p className="prompt-preview__error">{error}</p> : null}
      {preview ? (
        <div className="prompt-preview__body">
          <TokenAccountingDetails accounting={preview.tokenAccounting} />
          <ul className="prompt-preview__regions">
            {preview.regions.map((region) => (
              <li key={region.key} className="prompt-preview__region">
                <strong>{region.label}</strong>
                <small>约 {region.tokens} token</small>
              </li>
            ))}
            <li className="prompt-preview__region">
              <strong>近期对话</strong>
              <small>{preview.recentMessageCount} 条进入上下文</small>
            </li>
            {preview.diagnostics.map((line) => (
              <li key={line} className="prompt-preview__region prompt-preview__region--dropped">
                <strong>被裁剪</strong>
                <small>{line}</small>
              </li>
            ))}
          </ul>
          {preview.messages.map((message, index) => {
            const expandedKey = `message-${index}`;
            const isExpanded = !!expanded[expandedKey];
            return (
              <details className="prompt-preview__message" key={expandedKey} open={isExpanded}>
                <summary onClick={(event) => { event.preventDefault(); toggleRegion(index); }}>
                  <strong>{message.role === "system" ? "系统提示词" : message.role === "user" ? "用户" : "助手"}</strong>
                  <small>{isExpanded ? "收起" : "展开"}</small>
                </summary>
                {isExpanded ? <pre className="prompt-preview__content">{message.content}</pre> : null}
              </details>
            );
          })}
        </div>
      ) : null}
      {isGenerating ? <p className="prompt-preview__hint">生成中，预览仅反映发送前的草稿。</p> : null}
    </details>
  );
}
