import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  MemoryListQuery,
  MemoryRecord,
  StoryExportJson,
} from "@mycompanion/shared";

import {
  deleteMemory,
  listMemories,
  restoreMemory,
  updateMemory,
} from "../api";
import { memoryText } from "../diagnostic-translations";
import { MemoryItem, type MemoryPatch, type RestoreMode } from "./memory/MemoryItem";
import { RetrievalTester } from "./memory/RetrievalTester";
import { SummarySection } from "./memory/SummarySection";

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
 * 列表项、检索测试器、阶段摘要分别由 memory/ 下的子组件承担。
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

  const reads = useRef(0);
  const contextKey = `${conversationId}\0${sourceRevision ?? ""}`;
  const activeContext = useRef({ key: contextKey, revision: 0 });
  if (activeContext.current.key !== contextKey) activeContext.current = { key: contextKey, revision: activeContext.current.revision + 1 };
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
    setMemories(null);
    setFilters({});
    void loadMemories({});
    return () => { reads.current++; };
  }, [conversationId, loadMemories, sourceRevision]);

  const applyFilters = (patch: Partial<MemoryListQuery>): void => {
    const next = { ...filters, ...patch };
    setFilters(next);
    void loadMemories(next);
  };

  const handleUpdate = async (memory: MemoryRecord, patch: MemoryPatch): Promise<boolean> => {
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

  const handleRestore = async (memory: MemoryRecord, mode: RestoreMode = "previous_content"): Promise<void> => {
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
              <option value="character">{text("角色共享（旧数据）")}</option>
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
                <MemoryItem
                  key={memory.id}
                  memory={memory}
                  memories={memories}
                  isBusy={isBusy}
                  isEditing={editingId === memory.id}
                  editDraft={editDraft}
                  editorRef={editor}
                  navigationBusy={Boolean(navigationBusy)}
                  onOpenSource={onOpenSource}
                  onUpdate={(target, patch) => void handleUpdate(target, patch)}
                  onRestore={(target, mode) => void handleRestore(target, mode)}
                  onDelete={(target) => void handleDelete(target)}
                  onBeginEdit={beginEdit}
                  onCancelEdit={() => setEditingId(null)}
                  onEditDraft={setEditDraft}
                  onSaveEdit={(target) => void saveEdit(target)}
                />
              ))}
            </ul>
          )}
          {panelError ? <p role="alert" className="memory-panel__error">{text(panelError)}</p> : null}
        </>
      )}
      {runtimeError ? <p role="alert" className="memory-panel__error">{text(runtimeError)}</p> : null}

      <RetrievalTester conversationId={conversationId} sourceRevision={sourceRevision} />
      <SummarySection key={contextKey} conversationId={conversationId} onPanelError={setPanelError} />
    </section>
  );
}
