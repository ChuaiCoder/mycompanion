import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { MemoryRecord, StoryExportJson } from "@mycompanion/shared";

import { fetchStoryExport } from "../../api";
import { uiLocale } from "../../i18n";
import { memoryText } from "../../diagnostic-translations";

export interface MemorySourcesProps {
  memory: MemoryRecord;
  navigationBusy: boolean;
  replacement: MemoryRecord | undefined;
  onOpenSource?: ((conversationId: string, message: StoryExportJson["messages"][number]) => void) | undefined;
}

export function MemorySources({ memory, replacement, navigationBusy, onOpenSource }: MemorySourcesProps) {
  const { t, i18n } = useTranslation();
  const text = (value: string) => memoryText(i18n.language, value);
  const [open, setOpen] = useState(false);
  const [story, setStory] = useState<StoryExportJson | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open || !memory.sourceMessageIds.length) return;
    const controller = new AbortController(); setStory(null); setError("");
    void fetchStoryExport(memory.conversationId, controller.signal).then(value => { if (!controller.signal.aborted) setStory(value); }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "无法读取来源故事。");
    });
    return () => controller.abort();
  }, [open, memory.conversationId, memory.sourceMessageIds.join("/")]);
  return <details className="memory-sources" open={open}>
    <summary onClick={event => { event.preventDefault(); setOpen(value => !value); }}>{t("来源与变更（{{count}} 条）", { count: memory.sourceMessageIds.length })}</summary>
    <p>{text("这条记忆从以下对话提取；可查看原文后使用“编辑”更正。")}</p>
    {memory.status === "orphaned" ? <p>{text("来源不在当前分支；打开仍存在的来源分支可查看原文。")}</p> : null}
    {memory.supersededBy ? <p>{text("已被另一条记忆取代：")}{replacement?.content ?? text("替代记忆不在当前列表中，可切换状态筛选查看。")}</p> : null}
    {memory.previousContent !== null ? <p>{text("上次内容：")}{memory.previousContent}</p> : null}
    {!memory.sourceMessageIds.length ? <p>{text("未记录来源消息。")}</p> : error ? <p role="alert">{text("来源无法访问：")}{text(error)}</p> : !story ? <p role="status">{text("正在读取来源…")}</p> : <>
      <p>{text("来源故事：")}{story.conversation.title}</p>
      <ol>{memory.sourceMessageIds.map(id => {
        const message = story.messages.find(item => item.id === id);
        return <li key={id}>{message ? <>
          <p><strong>{message.role === "user" ? text("用户") : story.conversation.characterName}</strong> · {new Date(message.createdAt).toLocaleString(uiLocale())}</p>
          <pre>{message.content}</pre>
          <button type="button" disabled={navigationBusy || !onOpenSource} onClick={() => onOpenSource?.(memory.conversationId, message)}>{text("跳到原始消息")}</button>
        </> : <p>{text("来源消息已删除或不可访问。")}</p>}</li>;
      })}</ol>
    </>}
  </details>;
}
