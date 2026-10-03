import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  MemoryListQuery,
  MemoryRecord,
  MemoryRetrievalReport,
  StageSummary,
  StoryExportJson,
} from "@mycompanion/shared";

import {
  deleteMemory,
  getSummary,
  listMemories,
  restoreMemory,
  restoreSummary,
  saveSummary,
  setAutoSummary,
  testMemory,
  updateMemory,
  fetchStoryExport,
} from "../api";
import { Icon } from "../components";
import { uiLocale } from "../i18n";
import { memoryText } from "../diagnostic-translations";
import { MemoryRetrievalDiagnostics } from "./MemoryRetrievalDiagnostics";

const typeText: Record<MemoryRecord["type"], string> = {
  fact: "事实",
  state: "状态",
  goal: "目标",
  relationship: "关系",
};

const scopeText: Record<MemoryRecord["scope"], string> = {
  story: "本故事",
  character: "角色共享",
  user: "用户全局",
};

const statusText: Record<MemoryRecord["status"], string> = {
  active: "生效中",
  pending: "待确认",
  superseded: "已被取代",
  disabled: "已停用",
  orphaned: "来源不可达",
};
const relationText: Record<NonNullable<MemoryRecord["reconciliation"]>["kind"], string> = {
  duplicate: "重复表述", conflict: "互相矛盾", temporal_update: "状态随时间变化", unrelated: "独立事实", uncertain: "关系未确定",
};

export interface MemoryPanelProps {
  conversationId: string;
  conversationTitle: string;
  runtimeError: string | null;
  sourceRevision?: string;
  navigationBusy?: boolean;
  onOpenSource?: ((conversationId: string, message: StoryExportJson["messages"][number]) => void) | undefined;
}

/**
 * 记忆中心（FR-MEM-005/006/007/008）：
 * 本故事可见记忆（故事 + 角色共享 + 用户全局）的筛选、固定/停用、
 * 编辑与恢复上一版本、删除；检索测试器；阶段摘要的编辑与自动摘要开关。
 */
export function MemoryPanel({ conversationId, conversationTitle, runtimeError, navigationBusy, onOpenSource, sourceRevision }: MemoryPanelProps) {
  const { i18n } = useTranslation();
  const en = i18n.language.startsWith("en"), text = (value: string) => memoryText(i18n.language, value);
  const [filters, setFilters] = useState<MemoryListQuery>({});
  const [memories, setMemories] = useState<MemoryRecord[] | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const [testInput, setTestInput] = useState(() => text("我们现在在哪里？"));
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<MemoryRetrievalReport | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const [autoSummaryEnabled, setAutoSummaryEnabled] = useState<boolean | null>(null);
  const [summary, setSummary] = useState<StageSummary | null>(null);
  const [summaryDraft, setSummaryDraft] = useState("");
  const [isSummaryBusy, setIsSummaryBusy] = useState(false);
  const [summaryLoadError, setSummaryLoadError] = useState(false);
  const [reloadRevision, setReloadRevision] = useState(0);
  const reads = useRef(0);
  const contextKey = `${conversationId}\0${sourceRevision ?? ""}`;
  const activeContext = useRef({ key: contextKey, revision: 0 });
  if (activeContext.current.key !== contextKey) activeContext.current = { key: contextKey, revision: activeContext.current.revision + 1 };
  const tests = useRef(0);
  const editor = useRef<HTMLTextAreaElement>(null);
  const panel = useRef<HTMLElement>(null);
  const returnFocus = useRef<string | null>(null);

  useEffect(() => {
    if (editingId) editor.current?.focus();
    else if (returnFocus.current && !isBusy) {
      const button = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("[data-memory-edit]") ?? []).find(value => value.dataset.memoryEdit === returnFocus.current);
      if (button && !button.disabled) { button.focus(); returnFocus.current = null; }
    }
  }, [editingId, isBusy, memories]);

  useEffect(() => {
    setEditingId(null);
    returnFocus.current = null;
  }, [conversationId]);

  const loadMemories = useCallback(async (nextFilters: MemoryListQuery) => {
    const revision = ++reads.current;
    setIsBusy(true);
    setPanelError(null);
    try {
      const items = await listMemories(conversationId, nextFilters);
      if (revision === reads.current) setMemories(items);
    } catch {
      if (revision === reads.current) setPanelError("无法读取记忆，请重试。");
    } finally {
      if (revision === reads.current) setIsBusy(false);
    }
  }, [conversationId]);

  useEffect(() => {
    let cancelled = false;
    setMemories(null);
    setTestResult(null);
    setTestError(null);
    setIsTesting(false);
    tests.current++;
    setAutoSummaryEnabled(null);
    setSummary(null);
    setSummaryDraft("");
    setSummaryLoadError(false);
    setIsSummaryBusy(false);
    setFilters({});
    void loadMemories({});
    void getSummary(conversationId)
      .then((value) => {
        if (cancelled) return;
        setAutoSummaryEnabled(value.autoSummaryEnabled);
        setSummary(value.summary);
        setSummaryDraft(value.summary?.content ?? "");
      })
      .catch(() => { if (!cancelled) setSummaryLoadError(true); });
    return () => { cancelled = true; reads.current++; };
  }, [conversationId, loadMemories, sourceRevision, reloadRevision]);

  const applyFilters = (patch: Partial<MemoryListQuery>): void => {
    const next = { ...filters, ...patch };
    setFilters(next);
    void loadMemories(next);
  };

  const handleUpdate = async (memory: MemoryRecord, patch: Parameters<typeof updateMemory>[2]): Promise<boolean> => {
    const origin = activeContext.current.revision;
    setIsBusy(true);
    setPanelError(null);
    try {
      const updated = await updateMemory(conversationId, memory.id, patch);
      if (origin !== activeContext.current.revision) return false;
      setMemories((current) => current ? current.map((item) => item.id === updated.id ? updated : item) : current);
      await loadMemories(filters);
      return origin === activeContext.current.revision;
    } catch {
      if (origin === activeContext.current.revision) setPanelError("无法更新记忆，请重试。");
      return false;
    } finally {
      if (origin === activeContext.current.revision) setIsBusy(false);
    }
  };

  const beginEdit = (memory: MemoryRecord): void => {
    returnFocus.current = memory.id;
    setEditingId(memory.id);
    setEditDraft(memory.content);
  };

  const saveEdit = async (memory: MemoryRecord): Promise<void> => {
    const content = editDraft.trim();
    if (!content) return;
    if (await handleUpdate(memory, { content })) setEditingId(null);
  };

  const handleRestore = async (memory: MemoryRecord, mode: "supersession" | "previous_content" = "previous_content"): Promise<void> => {
    const origin = activeContext.current.revision;
    setIsBusy(true);
    setPanelError(null);
    try {
      const restored = await restoreMemory(conversationId, memory.id, mode);
      if (origin !== activeContext.current.revision) return;
      setMemories((current) => current ? current.map((item) => item.id === restored.id ? restored : item) : current);
      await loadMemories(filters);
    } catch {
      if (origin === activeContext.current.revision) setPanelError("无法恢复上一版本，请重试。");
    } finally {
      if (origin === activeContext.current.revision) setIsBusy(false);
    }
  };

  const handleDelete = async (memory: MemoryRecord): Promise<void> => {
    if (!window.confirm(en ? `Delete this memory (${memory.content})? This cannot be undone.` : `删除这条记忆（${memory.content}）？此操作不可撤销。`)) return;
    const origin = activeContext.current.revision;
    setIsBusy(true);
    setPanelError(null);
    try {
      await deleteMemory(conversationId, memory.id);
      if (origin !== activeContext.current.revision) return;
      setMemories((current) => current ? current.filter((item) => item.id !== memory.id) : current);
    } catch {
      if (origin === activeContext.current.revision) setPanelError("无法删除记忆，请重试。");
    } finally {
      if (origin === activeContext.current.revision) setIsBusy(false);
    }
  };

  const handleTest = async (): Promise<void> => {
    const origin = activeContext.current.revision, revision = ++tests.current;
    setIsTesting(true);
    setTestError(null);
    try {
      const result = await testMemory(conversationId, testInput);
      if (origin === activeContext.current.revision && revision === tests.current) setTestResult(result);
    } catch {
      if (origin === activeContext.current.revision && revision === tests.current) setTestError("记忆检索测试失败，请重试。");
    } finally {
      if (origin === activeContext.current.revision && revision === tests.current) setIsTesting(false);
    }
  };

  const handleToggleAutoSummary = async (): Promise<void> => {
    if (autoSummaryEnabled === null) return;
    const origin = activeContext.current.revision;
    const next = !autoSummaryEnabled;
    setAutoSummaryEnabled(next);
    setPanelError(null);
    try {
      await setAutoSummary(conversationId, next);
    } catch {
      if (origin === activeContext.current.revision) {
        setAutoSummaryEnabled(!next);
        setPanelError("无法更改自动摘要开关，请重试。");
      }
    }
  };

  const handleSaveSummary = async (): Promise<void> => {
    const origin = activeContext.current.revision;
    const content = summaryDraft.trim();
    if (!content || content === summary?.content) return;
    setIsSummaryBusy(true);
    setPanelError(null);
    try {
      const saved = await saveSummary(conversationId, content);
      if (origin === activeContext.current.revision) setSummary(saved);
    } catch {
      if (origin === activeContext.current.revision) setPanelError("无法保存摘要，请重试。");
    } finally {
      if (origin === activeContext.current.revision) setIsSummaryBusy(false);
    }
  };

  const handleRestoreSummary = async (): Promise<void> => {
    const origin = activeContext.current.revision;
    setIsSummaryBusy(true);
    setPanelError(null);
    try {
      const restored = await restoreSummary(conversationId);
      if (origin !== activeContext.current.revision) return;
      setSummary(restored);
      setSummaryDraft(restored.content);
    } catch {
      if (origin === activeContext.current.revision) setPanelError("无法恢复摘要上一版本，请重试。");
    } finally {
      if (origin === activeContext.current.revision) setIsSummaryBusy(false);
    }
  };

  return (
    <section ref={panel} className="document-section memory-panel" aria-labelledby="memory-panel-title">
      <h2 id="memory-panel-title">{text("记忆")}</h2>
      <p>{text("系统会自动从对话中提取值得记住的信息（写入“本故事”范围），并可在相关对话出现时注入提示词。分支回滚会使来源不可达的记忆暂停注入，回到原分支自动恢复。")}</p>
      {memories === null ? (
        panelError ? <div><p role="alert" className="memory-panel__error">{text(panelError)}</p><button type="button" onClick={() => void loadMemories(filters)} disabled={isBusy}>{text("重试读取记忆")}</button></div> : <p role="status">{text("正在读取记忆…")}</p>
      ) : (
        <>
          <div className="memory-panel__filters">
            <select aria-label={text("按范围筛选")} onChange={(event) => applyFilters({ scope: (event.target.value || undefined) as MemoryListQuery["scope"] })} value={filters.scope ?? ""}>
              <option value="">{text("全部范围")}</option>
              <option value="story">{text("本故事")}</option>
              <option value="character">{text("角色共享")}</option>
              <option value="user">{text("用户全局")}</option>
            </select>
            <select aria-label={text("按类型筛选")} onChange={(event) => applyFilters({ type: (event.target.value || undefined) as MemoryListQuery["type"] })} value={filters.type ?? ""}>
              <option value="">{text("全部类型")}</option>
              <option value="fact">{text("事实")}</option>
              <option value="state">{text("状态")}</option>
              <option value="goal">{text("目标")}</option>
              <option value="relationship">{text("关系")}</option>
            </select>
            <select aria-label={text("按状态筛选")} onChange={(event) => applyFilters({ status: (event.target.value || undefined) as MemoryListQuery["status"] })} value={filters.status ?? ""}>
              <option value="">{text("全部状态")}</option>
              <option value="active">{text("生效中")}</option>
              <option value="pending">{text("待确认")}</option>
              <option value="superseded">{text("已被取代")}</option>
              <option value="disabled">{text("已停用")}</option>
              <option value="orphaned">{text("来源不可达")}</option>
            </select>
          </div>
          {memories.length === 0 ? (
            <p className="panel-empty">{text("这个故事还没有记忆；继续对话后会自动提取。")}</p>
          ) : (
            <ul className="memory-list">
              {memories.map((memory) => (
                <li key={memory.id} className={`memory-item ${memory.status !== "active" ? `memory-item--${memory.status}` : ""}`}>
                  <div className="memory-item__header">
                    <strong>{text(typeText[memory.type])}</strong>
                    <span>{text(statusText[memory.status])} · {text(scopeText[memory.scope])} · {text("重要度")} {memory.importance}</span>
                    <span className="memory-item__actions">
                      <button
                        aria-pressed={memory.pinned}
                        className="button button--quiet button--small"
                        disabled={isBusy}
                        onClick={() => void handleUpdate(memory, { pinned: !memory.pinned })}
                        type="button"
                      >
                        {text(memory.pinned ? "取消固定" : "固定")}
                      </button>
                      {memory.status === "pending" ? <button className="button button--primary button--small" disabled={isBusy} onClick={() => void handleUpdate(memory, { status: "active" })} type="button">{text("采用并替代关联记忆")}</button> : null}
                      {memory.status === "superseded" ? <button className="button button--quiet button--small" disabled={isBusy} onClick={() => void handleRestore(memory, "supersession")} type="button">{text("恢复这条记忆")}</button> : null}
                      <button
                        className="button button--quiet button--small"
                        disabled={isBusy || memory.status === "pending" || memory.status === "superseded" || memory.status === "orphaned"}
                        onClick={() => void handleUpdate(memory, { status: memory.status === "active" ? "disabled" : "active" })}
                        type="button"
                      >
                        {text(memory.status === "active" ? "停用" : "启用")}
                      </button>
                      {memory.previousContent !== null ? (
                        <button className="button button--quiet button--small" disabled={isBusy} onClick={() => void handleRestore(memory)} type="button">
                          {text("恢复上一版本")}
                        </button>
                      ) : null}
                      <button className="button button--quiet button--small memory-item__delete" disabled={isBusy} onClick={() => void handleDelete(memory)} type="button">
                        {text("删除")}
                      </button>
                    </span>
                  </div>
                  {editingId === memory.id ? (
                    <div className="memory-item__editor">
                      <textarea ref={editor} aria-label={text("编辑记忆")} onChange={(event) => setEditDraft(event.target.value)} rows={3} value={editDraft} readOnly={isBusy} />
                      <div className="memory-item__editor-actions">
                        <button className="button button--primary button--small" disabled={isBusy || !editDraft.trim()} onClick={() => void saveEdit(memory)} type="button">{text("保存")}</button>
                        <button className="button button--quiet button--small" disabled={isBusy} onClick={() => setEditingId(null)} type="button">{text("取消")}</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <code className="memory-item__content">{memory.content}</code>
                      <button data-memory-edit={memory.id} className="button button--quiet button--small" disabled={isBusy} onClick={() => beginEdit(memory)} type="button">
                        {text("编辑")}
                      </button>
                    </>
                  )}
                  {memory.manuallyEdited ? <p className="memory-provenance">{text("已由你手动更正或采用，自动提取会保留这条记忆。")}</p> : null}
                  {memory.reconciliation ? <div className="memory-reconciliation"><p><strong>{text(relationText[memory.reconciliation.kind])}</strong> · {memory.reconciliation.reason}</p>{memory.status === "pending" ? <p>{text("尚未用于对话。采用后，关联的生效记忆会保留为被替代版本。")}</p> : null}{memory.reconciliation.relatedMemoryIds.length ? <ul>{memory.reconciliation.relatedMemoryIds.map(id => {
                    const related = memories.find(item => item.id === id);
                    return <li key={id}>{related ? <><strong>{related.content}</strong><span> · {text(statusText[related.status])}{related.pinned ? text(" · 已固定") : ""}{related.manuallyEdited ? text(" · 人工更正") : ""}</span></> : text("关联记忆不在当前列表，可切换筛选查看。")}</li>;
                  })}</ul> : null}{memory.claim?.transition ? <p>{text("原提取依据中的变化原文：")}<q>{memory.claim.transition.quote}</q></p> : null}</div> : null}
                  <MemorySources memory={memory} replacement={memories.find(item => item.id === memory.supersededBy)} navigationBusy={Boolean(navigationBusy)} onOpenSource={onOpenSource} />
                </li>
              ))}
            </ul>
          )}
          {panelError ? <p role="alert" className="memory-panel__error">{text(panelError)}</p> : null}
        </>
      )}
      {runtimeError ? <p role="alert" className="memory-panel__error">{text(runtimeError)}</p> : null}

      <div className="memory-panel__section" aria-busy={isTesting}>
        <h3>{text("检索测试器")}</h3>
        <p>{text("对示例文本跑一次检索，看看哪些记忆会被注入，不会修改真实聊天。")}</p>
        <textarea aria-label={text("检索测试文本")} onChange={(event) => setTestInput(event.target.value)} rows={3} value={testInput} />
        <button className="button button--primary button--small" disabled={isTesting} onClick={() => void handleTest()} type="button">
          <Icon name="sparkles" size={14} />
          {text(isTesting ? "正在检索…" : "运行检索")}
        </button>
        <p role="status">{isTesting ? text("正在检索…") : testError ? "" : testResult ? (en ? `Retrieval complete: ${testResult.injectedCount} memories included.` : `检索完成：注入 ${testResult.injectedCount} 条记忆。`) : ""}</p>
        {testError ? <p role="alert">{text(testError)}</p> : null}
        {testResult ? (
          <div className="memory-panel__test-result">
            {testResult.results.length === 0 ? <p className="panel-empty">{text("还没有可检索的记忆。")}</p> : testResult.results.map((result) => (
              <div key={result.memoryId} className={`memory-test-result ${result.injected ? "memory-test-result--injected" : "memory-test-result--skipped"}`}>
                <strong>{result.content ? `…${result.content.slice(0, 24)}` : text("（无内容）")}</strong>
                <span>{text(result.injected ? "已注入" : "未注入")} · {text("得分")} {result.score}</span>
                {result.diagnostics.length > 0 ? <small>{result.diagnostics.map(text).join(en ? "; " : "；")}</small> : null}
              </div>
            ))}
            <p>{en ? `Included before recent messages (${testResult.injectedCount} memories; ${testResult.budgetTokens} token budget).` : `注入位置：近期消息之前（${testResult.injectedCount} 条 · 预算 ${testResult.budgetTokens} token）`}</p>
            <p>{text("注入内容：")}<code className="memory-item__content">{testResult.block || text("（本轮没有注入）")}</code></p>
            <MemoryRetrievalDiagnostics retrieval={testResult.retrieval} />
          </div>
        ) : null}
      </div>

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
        <p>{text("摘要压缩较早的剧情以节省上下文；摘要失败不会阻塞聊天。")}{summary ? (en ? `Covers ${summary.coveredMessageCount} messages; model ${summary.model}.` : `覆盖 ${summary.coveredMessageCount} 条消息 · 模型 ${summary.model}`) : text("尚未生成；对话足够长后自动生成。")}</p>
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
    </section>
  );
}

function MemorySources({ memory, replacement, navigationBusy, onOpenSource }: {
  memory: MemoryRecord; navigationBusy: boolean;
  replacement: MemoryRecord | undefined;
  onOpenSource: MemoryPanelProps["onOpenSource"];
}) {
  const { i18n } = useTranslation();
  const en = i18n.language.startsWith("en"), text = (value: string) => memoryText(i18n.language, value);
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
    <summary onClick={event => { event.preventDefault(); setOpen(value => !value); }}>{en ? `Sources and changes (${memory.sourceMessageIds.length} messages)` : `来源与变更（${memory.sourceMessageIds.length} 条）`}</summary>
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
