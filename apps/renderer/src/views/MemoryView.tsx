import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { MemoryListQuery, MemoryRecord } from "@mycompanion/shared";
import { useTranslation } from "react-i18next";

import { deleteMemory, listMemoryInventory, restoreMemory, updateMemory } from "../api";
import { Notice } from "../components";
import { memoryText } from "../diagnostic-translations";
import { MemoryItem, type MemoryPatch, type RestoreMode } from "./memory/MemoryItem";

export interface MemoryViewProps {
  online: boolean;
  /** 打开某条记忆的来源：切回故事页并由该故事定位到原消息。 */
  onOpenSource: (conversationId: string, messageId: string, revision: number) => void;
}

interface InventoryRow {
  memory: MemoryRecord;
  conversationId: string;
  conversationTitle: string;
}

/**
 * 记忆库（FR-MEM-005/007）：一级页面，一次列出所有故事里的记忆。
 *
 * 与故事页的 MemoryPanel 的分工：这里做"跨故事浏览 + 定位 + 固定/停用/恢复/删除"；
 * 检索测试器与阶段摘要留在故事页侧栏，因为它们依赖具体故事的上下文与草稿。
 * 每条记忆只出现一次（归属故事由后端给出），不会因为一条角色级/全局记忆对多条故事
 * 可见就重复列出。
 */
export function MemoryView({ online, onOpenSource }: MemoryViewProps) {
  const [filters, setFilters] = useState<MemoryListQuery>({});
  const [items, setItems] = useState<InventoryRow[] | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const reads = useRef(0);
  const editor = useRef<HTMLTextAreaElement>(null);
  const { i18n } = useTranslation();
  const text = (value: string) => memoryText(i18n.language, value);

  const load = useCallback(async (next: MemoryListQuery) => {
    const revision = ++reads.current;
    setIsBusy(true);
    setError(null);
    try {
      const payload = await listMemoryInventory(next);
      if (revision === reads.current) setItems(payload.items);
    } catch {
      if (revision === reads.current) setError("无法读取记忆，请重试。");
    } finally {
      if (revision === reads.current) setIsBusy(false);
    }
  }, []);

  useEffect(() => {
    void load({});
    return () => { reads.current++; };
  }, [load]);

  useEffect(() => {
    if (editingId) editor.current?.focus();
  }, [editingId]);

  const applyFilters = (patch: Partial<MemoryListQuery>): void => {
    const next = { ...filters, ...patch };
    setFilters(next);
    void load(next);
  };

  /** 按归属故事分组；同一故事的记忆放在一起，组内保持后端给的顺序。 */
  const groups = useMemo(() => {
    const grouped = new Map<string, { conversationId: string; conversationTitle: string; items: MemoryRecord[] }>();
    for (const row of items ?? []) {
      const key = row.conversationId;
      const group = grouped.get(key) ?? { conversationId: key, conversationTitle: row.conversationTitle, items: [] };
      group.items.push(row.memory);
      grouped.set(key, group);
    }
    return [...grouped.values()];
  }, [items]);

  const active = (items ?? []).length;

  /**
   * 变更要走**归属故事**，而不是记忆自带的 conversation_id。
   * 来源故事被删除时两者会分叉（归属回退到该角色的另一条故事），后端按归属校验可见性，
   * 沿用旧 id 会 404 —— 表现就是"记忆库里有、却改不了删不掉"。
   */
  const ownerOf = (memory: MemoryRecord): string =>
    (items ?? []).find(row => row.memory.id === memory.id)?.conversationId ?? memory.conversationId;

  const replace = (memory: MemoryRecord): void => {
    setItems((current) => current ? current.map(row => row.memory.id === memory.id ? { ...row, memory } : row) : current);
  };

  const handleUpdate = async (memory: MemoryRecord, patch: MemoryPatch): Promise<boolean> => {
    const revision = reads.current;
    setIsBusy(true);
    setError(null);
    try {
      replace(await updateMemory(ownerOf(memory), memory.id, patch));
      return true;
    } catch {
      if (revision === reads.current) setError("无法更新记忆，请重试。");
      return false;
    } finally {
      if (revision === reads.current) setIsBusy(false);
    }
  };

  const handleRestore = async (memory: MemoryRecord, mode: RestoreMode = "previous_content"): Promise<void> => {
    setIsBusy(true);
    setError(null);
    try {
      replace(await restoreMemory(ownerOf(memory), memory.id, mode));
    } catch {
      setError("无法恢复上一版本，请重试。");
    } finally {
      setIsBusy(false);
    }
  };

  const handleDelete = async (memory: MemoryRecord): Promise<void> => {
    if (!window.confirm(`删除这条记忆（${memory.content}）？此操作不可撤销。`)) return;
    setIsBusy(true);
    setError(null);
    try {
      await deleteMemory(ownerOf(memory), memory.id);
      setItems((current) => current ? current.filter(row => row.memory.id !== memory.id) : current);
    } catch {
      setError("无法删除记忆，请重试。");
    } finally {
      setIsBusy(false);
    }
  };

  const saveEdit = async (memory: MemoryRecord): Promise<void> => {
    const content = editDraft.trim();
    if (!content) return;
    // 只有真正保存成功才关闭编辑器；失败时保留用户刚输入的内容。
    if (await handleUpdate(memory, { content })) setEditingId(null);
  };

  return (
    <main className="memory-workspace" aria-labelledby="memory-library-title">
      <header className="memory-page-head">
        <div>
          <p className="eyebrow">MYCOMPANION · 记忆库</p>
          <h1 id="memory-library-title">记忆</h1>
          <p>系统从对话里自动提取的事实、状态、目标与关系。按故事分组；固定记忆会优先进入上下文。</p>
        </div>
        <div className="memory-page-stat"><strong>{items === null ? "…" : active}</strong><span>条记忆</span></div>
      </header>

      {error ? <Notice tone="error">{text(error)}</Notice> : null}
      {!online ? <Notice tone="error">{text("服务未连接，无法读取记忆。")}</Notice> : null}

      <div className="memory-panel__filters memory-page-filters">
        <select aria-label={text("按范围筛选")} onChange={(event) => applyFilters({ scope: (event.target.value || undefined) as MemoryListQuery["scope"] })} value={filters.scope ?? ""}>
          <option value="">{text("全部范围")}</option>
          <option value="story">{text("本故事")}</option>
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

      {items === null ? (
        <p role="status" className="panel-empty">{text("正在读取记忆…")}</p>
      ) : active === 0 ? (
        <div className="memory-page-empty">
          <span aria-hidden="true">🧠</span>
          <strong>还没有记忆</strong>
          <p>在故事里继续对话，系统会自动提取；这里会按故事汇总显示。</p>
        </div>
      ) : (
        groups.map(group => (
          <section className="memory-page-group" key={group.conversationId} aria-labelledby={`memory-group-${group.conversationId}`}>
            <header className="memory-page-group__head">
              <h2 id={`memory-group-${group.conversationId}`}>{group.conversationTitle || "（故事已删除）"}</h2>
              <small>{group.items.length} 条</small>
            </header>
            <ul className="memory-list">
              {group.items.map(memory => (
                <MemoryItem
                  key={memory.id}
                  memory={memory}
                  memories={group.items}
                  isBusy={isBusy}
                  isEditing={editingId === memory.id}
                  editDraft={editDraft}
                  editorRef={editor}
                  navigationBusy={isBusy}
                  onOpenSource={(conversationId, message) => onOpenSource(conversationId, message.id, 1)}
                  onUpdate={(target, patch) => void handleUpdate(target, patch)}
                  onRestore={(target, mode) => void handleRestore(target, mode)}
                  onDelete={(target) => void handleDelete(target)}
                  onBeginEdit={(target) => { setEditingId(target.id); setEditDraft(target.content); }}
                  onCancelEdit={() => setEditingId(null)}
                  onEditDraft={setEditDraft}
                  onSaveEdit={(target) => void saveEdit(target)}
                />
              ))}
            </ul>
          </section>
        ))
      )}
      {isBusy ? <p role="status" className="visually-hidden-input">正在更新</p> : null}
    </main>
  );
}
