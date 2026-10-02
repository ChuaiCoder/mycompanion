import { useCallback, useEffect, useRef, useState } from "react";

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
  const [filters, setFilters] = useState<MemoryListQuery>({});
  const [memories, setMemories] = useState<MemoryRecord[] | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const [testInput, setTestInput] = useState("我们现在在哪里？");
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<MemoryRetrievalReport | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const [autoSummaryEnabled, setAutoSummaryEnabled] = useState<boolean | null>(null);
  const [summary, setSummary] = useState<StageSummary | null>(null);
  const [summaryDraft, setSummaryDraft] = useState("");
  const [isSummaryBusy, setIsSummaryBusy] = useState(false);
  const reads = useRef(0);

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
    setFilters({});
    void loadMemories({});
    void getSummary(conversationId)
      .then((value) => {
        if (cancelled) return;
        setAutoSummaryEnabled(value.autoSummaryEnabled);
        setSummary(value.summary);
        setSummaryDraft(value.summary?.content ?? "");
      })
      .catch(() => { if (!cancelled) setAutoSummaryEnabled(null); });
    return () => { cancelled = true; reads.current++; };
  }, [conversationId, loadMemories, sourceRevision]);

  const applyFilters = (patch: Partial<MemoryListQuery>): void => {
    const next = { ...filters, ...patch };
    setFilters(next);
    void loadMemories(next);
  };

  const handleUpdate = async (memory: MemoryRecord, patch: Parameters<typeof updateMemory>[2]): Promise<void> => {
    setIsBusy(true);
    setPanelError(null);
    try {
      const updated = await updateMemory(conversationId, memory.id, patch);
      setMemories((current) => current ? current.map((item) => item.id === updated.id ? updated : item) : current);
      await loadMemories(filters);
    } catch {
      setPanelError("无法更新记忆，请重试。");
    } finally {
      setIsBusy(false);
    }
  };

  const beginEdit = (memory: MemoryRecord): void => {
    setEditingId(memory.id);
    setEditDraft(memory.content);
  };

  const saveEdit = async (memory: MemoryRecord): Promise<void> => {
    const content = editDraft.trim();
    if (!content) return;
    setEditingId(null);
    await handleUpdate(memory, { content });
  };

  const handleRestore = async (memory: MemoryRecord, mode: "supersession" | "previous_content" = "previous_content"): Promise<void> => {
    setIsBusy(true);
    setPanelError(null);
    try {
      const restored = await restoreMemory(conversationId, memory.id, mode);
      setMemories((current) => current ? current.map((item) => item.id === restored.id ? restored : item) : current);
      await loadMemories(filters);
    } catch {
      setPanelError("无法恢复上一版本，请重试。");
    } finally {
      setIsBusy(false);
    }
  };

  const handleDelete = async (memory: MemoryRecord): Promise<void> => {
    if (!window.confirm(`删除这条记忆（${memory.content}）？此操作不可撤销。`)) return;
    setIsBusy(true);
    setPanelError(null);
    try {
      await deleteMemory(conversationId, memory.id);
      setMemories((current) => current ? current.filter((item) => item.id !== memory.id) : current);
    } catch {
      setPanelError("无法删除记忆，请重试。");
    } finally {
      setIsBusy(false);
    }
  };

  const handleTest = async (): Promise<void> => {
    setIsTesting(true);
    setTestError(null);
    try {
      setTestResult(await testMemory(conversationId, testInput));
    } catch {
      setTestError("记忆检索测试失败，请重试。");
    } finally {
      setIsTesting(false);
    }
  };

  const handleToggleAutoSummary = async (): Promise<void> => {
    if (autoSummaryEnabled === null) return;
    const next = !autoSummaryEnabled;
    setAutoSummaryEnabled(next);
    setPanelError(null);
    try {
      await setAutoSummary(conversationId, next);
    } catch {
      setAutoSummaryEnabled(!next);
      setPanelError("无法更改自动摘要开关，请重试。");
    }
  };

  const handleSaveSummary = async (): Promise<void> => {
    const content = summaryDraft.trim();
    if (!content || content === summary?.content) return;
    setIsSummaryBusy(true);
    setPanelError(null);
    try {
      setSummary(await saveSummary(conversationId, content));
    } catch {
      setPanelError("无法保存摘要，请重试。");
    } finally {
      setIsSummaryBusy(false);
    }
  };

  const handleRestoreSummary = async (): Promise<void> => {
    setIsSummaryBusy(true);
    setPanelError(null);
    try {
      const restored = await restoreSummary(conversationId);
      setSummary(restored);
      setSummaryDraft(restored.content);
    } catch {
      setPanelError("无法恢复摘要上一版本，请重试。");
    } finally {
      setIsSummaryBusy(false);
    }
  };

  return (
    <section className="document-section memory-panel" aria-labelledby="memory-panel-title">
      <h2 id="memory-panel-title">记忆</h2>
      <p>
        系统会自动从对话中提取值得记住的信息（写入“本故事”范围），并可在相关对话出现时注入提示词。
        分支回滚会使来源不可达的记忆暂停注入，回到原分支自动恢复。
      </p>
      {memories === null ? (
        <p>{panelError ?? "正在读取记忆…"}</p>
      ) : (
        <>
          <div className="memory-panel__filters">
            <select aria-label="按范围筛选" onChange={(event) => applyFilters({ scope: (event.target.value || undefined) as MemoryListQuery["scope"] })} value={filters.scope ?? ""}>
              <option value="">全部范围</option>
              <option value="story">本故事</option>
              <option value="character">角色共享</option>
              <option value="user">用户全局</option>
            </select>
            <select aria-label="按类型筛选" onChange={(event) => applyFilters({ type: (event.target.value || undefined) as MemoryListQuery["type"] })} value={filters.type ?? ""}>
              <option value="">全部类型</option>
              <option value="fact">事实</option>
              <option value="state">状态</option>
              <option value="goal">目标</option>
              <option value="relationship">关系</option>
            </select>
            <select aria-label="按状态筛选" onChange={(event) => applyFilters({ status: (event.target.value || undefined) as MemoryListQuery["status"] })} value={filters.status ?? ""}>
              <option value="">全部状态</option>
              <option value="active">生效中</option>
              <option value="pending">待确认</option>
              <option value="superseded">已被取代</option>
              <option value="disabled">已停用</option>
              <option value="orphaned">来源不可达</option>
            </select>
          </div>
          {memories.length === 0 ? (
            <p className="panel-empty">这个故事还没有记忆；继续对话后会自动提取。</p>
          ) : (
            <ul className="memory-list">
              {memories.map((memory) => (
                <li key={memory.id} className={`memory-item ${memory.status !== "active" ? `memory-item--${memory.status}` : ""}`}>
                  <div className="memory-item__header">
                    <strong>{typeText[memory.type]}</strong>
                    <span>{statusText[memory.status]} · {scopeText[memory.scope]} · 重要度 {memory.importance}</span>
                    <span className="memory-item__actions">
                      <button
                        aria-pressed={memory.pinned}
                        className="button button--quiet button--small"
                        disabled={isBusy}
                        onClick={() => void handleUpdate(memory, { pinned: !memory.pinned })}
                        type="button"
                      >
                        {memory.pinned ? "取消固定" : "固定"}
                      </button>
                      {memory.status === "pending" ? <button className="button button--primary button--small" disabled={isBusy} onClick={() => void handleUpdate(memory, { status: "active" })} type="button">采用并替代关联记忆</button> : null}
                      {memory.status === "superseded" ? <button className="button button--quiet button--small" disabled={isBusy} onClick={() => void handleRestore(memory, "supersession")} type="button">恢复这条记忆</button> : null}
                      <button
                        className="button button--quiet button--small"
                        disabled={isBusy || memory.status === "pending" || memory.status === "superseded" || memory.status === "orphaned"}
                        onClick={() => void handleUpdate(memory, { status: memory.status === "active" ? "disabled" : "active" })}
                        type="button"
                      >
                        {memory.status === "active" ? "停用" : "启用"}
                      </button>
                      {memory.previousContent !== null ? (
                        <button className="button button--quiet button--small" disabled={isBusy} onClick={() => void handleRestore(memory)} type="button">
                          恢复上一版本
                        </button>
                      ) : null}
                      <button className="button button--quiet button--small memory-item__delete" disabled={isBusy} onClick={() => void handleDelete(memory)} type="button">
                        删除
                      </button>
                    </span>
                  </div>
                  {editingId === memory.id ? (
                    <div className="memory-item__editor">
                      <textarea aria-label="编辑记忆" onChange={(event) => setEditDraft(event.target.value)} rows={3} value={editDraft} />
                      <div className="memory-item__editor-actions">
                        <button className="button button--primary button--small" disabled={!editDraft.trim()} onClick={() => void saveEdit(memory)} type="button">保存</button>
                        <button className="button button--quiet button--small" onClick={() => setEditingId(null)} type="button">取消</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <code className="memory-item__content">{memory.content}</code>
                      <button className="button button--quiet button--small" disabled={isBusy} onClick={() => beginEdit(memory)} type="button">
                        编辑
                      </button>
                    </>
                  )}
                  {memory.manuallyEdited ? <p className="memory-provenance">已由你手动更正或采用，自动提取会保留这条记忆。</p> : null}
                  {memory.reconciliation ? <div className="memory-reconciliation"><p><strong>{relationText[memory.reconciliation.kind]}</strong> · {memory.reconciliation.reason}</p>{memory.status === "pending" ? <p>尚未用于对话。采用后，关联的生效记忆会保留为被替代版本。</p> : null}{memory.reconciliation.relatedMemoryIds.length ? <ul>{memory.reconciliation.relatedMemoryIds.map(id => {
                    const related = memories.find(item => item.id === id);
                    return <li key={id}>{related ? <><strong>{related.content}</strong><span> · {statusText[related.status]}{related.pinned ? " · 已固定" : ""}{related.manuallyEdited ? " · 人工更正" : ""}</span></> : "关联记忆不在当前列表，可切换筛选查看。"}</li>;
                  })}</ul> : null}{memory.claim?.transition ? <p>原提取依据中的变化原文：<q>{memory.claim.transition.quote}</q></p> : null}</div> : null}
                  <MemorySources memory={memory} replacement={memories.find(item => item.id === memory.supersededBy)} navigationBusy={Boolean(navigationBusy)} onOpenSource={onOpenSource} />
                </li>
              ))}
            </ul>
          )}
          {panelError ? <p role="alert" className="memory-panel__error">{panelError}</p> : null}
          {runtimeError ? <p role="alert" className="memory-panel__error">{runtimeError}</p> : null}
        </>
      )}

      <div className="memory-panel__section">
        <h3>检索测试器</h3>
        <p>对示例文本跑一次检索，看看哪些记忆会被注入，不会修改真实聊天。</p>
        <textarea aria-label="检索测试文本" onChange={(event) => setTestInput(event.target.value)} rows={3} value={testInput} />
        <button className="button button--primary button--small" disabled={isTesting} onClick={() => void handleTest()} type="button">
          <Icon name="sparkles" size={14} />
          {isTesting ? "正在检索…" : "运行检索"}
        </button>
        {testError ? <p role="alert">{testError}</p> : null}
        {testResult ? (
          <div className="memory-panel__test-result">
            {testResult.results.length === 0 ? <p className="panel-empty">还没有可检索的记忆。</p> : testResult.results.map((result) => (
              <div key={result.memoryId} className={`memory-test-result ${result.injected ? "memory-test-result--injected" : "memory-test-result--skipped"}`}>
                <strong>{result.content ? `…${result.content.slice(0, 24)}` : "（无内容）"}</strong>
                <span>{result.injected ? "已注入" : "未注入"} · 得分 {result.score}</span>
                {result.diagnostics.length > 0 ? <small>{result.diagnostics.join("；")}</small> : null}
              </div>
            ))}
            <p>注入位置：近期消息之前（{testResult.injectedCount} 条 · 预算 {testResult.budgetTokens} token）</p>
            <p>注入内容：<code className="memory-item__content">{testResult.block || "（本轮没有注入）"}</code></p>
          </div>
        ) : null}
      </div>

      <div className="memory-panel__section">
        <div className="memory-panel__summary-header">
          <h3>阶段摘要</h3>
          {autoSummaryEnabled !== null ? (
            <button
              aria-pressed={autoSummaryEnabled}
              className="button button--quiet button--small"
              onClick={() => void handleToggleAutoSummary()}
              type="button"
            >
              自动摘要：{autoSummaryEnabled ? "开" : "关"}
            </button>
          ) : null}
        </div>
        <p>摘要压缩较早的剧情以节省上下文；摘要失败不会阻塞聊天。{summary ? `覆盖 ${summary.coveredMessageCount} 条消息 · 模型 ${summary.model}` : "尚未生成；对话足够长后自动生成。"}</p>
        {summary?.valid === false ? <p role="status">来源已改变，需重新生成或校正；这份摘要暂不用于对话。</p> : null}
        <textarea
          aria-label="阶段摘要内容"
          onChange={(event) => setSummaryDraft(event.target.value)}
          rows={4}
          value={summaryDraft}
        />
        <div className="memory-panel__actions">
          <button className="button button--primary button--small" disabled={isSummaryBusy || !summaryDraft.trim() || summaryDraft.trim() === summary?.content} onClick={() => void handleSaveSummary()} type="button">
            保存摘要
          </button>
          <button className="button button--quiet button--small" disabled={isSummaryBusy || !summary?.previousContent} onClick={() => void handleRestoreSummary()} type="button">
            恢复上一版本
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
    <summary onClick={event => { event.preventDefault(); setOpen(value => !value); }}>来源与变更（{memory.sourceMessageIds.length} 条）</summary>
    <p>这条记忆从以下对话提取；可查看原文后使用“编辑”更正。</p>
    {memory.status === "orphaned" ? <p>来源不在当前分支；打开仍存在的来源分支可查看原文。</p> : null}
    {memory.supersededBy ? <p>已被另一条记忆取代：{replacement?.content ?? "替代记忆不在当前列表中，可切换状态筛选查看。"}</p> : null}
    {memory.previousContent !== null ? <p>上次内容：{memory.previousContent}</p> : null}
    {!memory.sourceMessageIds.length ? <p>未记录来源消息。</p> : error ? <p role="alert">来源无法访问：{error}</p> : !story ? <p>正在读取来源…</p> : <>
      <p>来源故事：{story.conversation.title}</p>
      <ol>{memory.sourceMessageIds.map(id => {
        const message = story.messages.find(item => item.id === id);
        return <li key={id}>{message ? <>
          <p><strong>{message.role === "user" ? "用户" : story.conversation.characterName}</strong> · {new Date(message.createdAt).toLocaleString(uiLocale())}</p>
          <pre>{message.content}</pre>
          <button type="button" disabled={navigationBusy || !onOpenSource} onClick={() => onOpenSource?.(memory.conversationId, message)}>跳到原始消息</button>
        </> : <p>来源消息已删除或不可访问。</p>}</li>;
      })}</ol>
    </>}
  </details>;
}
