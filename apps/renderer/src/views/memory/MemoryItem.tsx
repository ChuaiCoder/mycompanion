import type { RefObject } from "react";
import { useTranslation } from "react-i18next";

import type { MemoryRecord } from "@mycompanion/shared";

import type { updateMemory } from "../../api";
import { memoryText } from "../../diagnostic-translations";
import { relationText, scopeText, statusText, typeText } from "./memory-labels";
import { MemorySources, type MemorySourcesProps } from "./MemorySources";

export type MemoryPatch = Parameters<typeof updateMemory>[2];
export type RestoreMode = "supersession" | "previous_content";

export interface MemoryItemProps {
  memory: MemoryRecord;
  memories: MemoryRecord[];
  isBusy: boolean;
  isEditing: boolean;
  editDraft: string;
  editorRef: RefObject<HTMLTextAreaElement | null>;
  navigationBusy: boolean;
  onOpenSource: MemorySourcesProps["onOpenSource"];
  onUpdate: (memory: MemoryRecord, patch: MemoryPatch) => void;
  onRestore: (memory: MemoryRecord, mode?: RestoreMode) => void;
  onDelete: (memory: MemoryRecord) => void;
  onBeginEdit: (memory: MemoryRecord) => void;
  onCancelEdit: () => void;
  onEditDraft: (value: string) => void;
  onSaveEdit: (memory: MemoryRecord) => void;
}

/** 单条记忆：头部操作、行内编辑器、人工更正/调和信息、来源与变更。 */
export function MemoryItem({ memory, memories, isBusy, isEditing, editDraft, editorRef, navigationBusy, onOpenSource, onUpdate, onRestore, onDelete, onBeginEdit, onCancelEdit, onEditDraft, onSaveEdit }: MemoryItemProps) {
  const { i18n } = useTranslation();
  const text = (value: string) => memoryText(i18n.language, value);
  return (
    <li className={`memory-item ${memory.status !== "active" ? `memory-item--${memory.status}` : ""}`}>
      <div className="memory-item__header">
        <strong>{text(typeText[memory.type])}</strong>
        <span>{text(statusText[memory.status])} · {text(scopeText[memory.scope])} · {text("重要度")} {memory.importance}</span>
        <span className="memory-item__actions">
          <button
            aria-pressed={memory.pinned}
            className="button button--quiet button--small"
            disabled={isBusy}
            onClick={() => onUpdate(memory, { pinned: !memory.pinned })}
            type="button"
          >
            {text(memory.pinned ? "取消固定" : "固定")}
          </button>
          {memory.status === "pending" ? <button className="button button--primary button--small" disabled={isBusy} onClick={() => onUpdate(memory, { status: "active" })} type="button">{text("采用并替代关联记忆")}</button> : null}
          {memory.status === "superseded" ? <button className="button button--quiet button--small" disabled={isBusy} onClick={() => onRestore(memory, "supersession")} type="button">{text("恢复这条记忆")}</button> : null}
          <button
            className="button button--quiet button--small"
            disabled={isBusy || memory.status === "pending" || memory.status === "superseded" || memory.status === "orphaned"}
            onClick={() => onUpdate(memory, { status: memory.status === "active" ? "disabled" : "active" })}
            type="button"
          >
            {text(memory.status === "active" ? "停用" : "启用")}
          </button>
          {memory.previousContent !== null ? (
            <button className="button button--quiet button--small" disabled={isBusy} onClick={() => onRestore(memory)} type="button">
              {text("恢复上一版本")}
            </button>
          ) : null}
          <button className="button button--quiet button--small memory-item__delete" disabled={isBusy} onClick={() => onDelete(memory)} type="button">
            {text("删除")}
          </button>
        </span>
      </div>
      {isEditing ? (
        <div className="memory-item__editor">
          <textarea ref={editorRef} aria-label={text("编辑记忆")} onChange={(event) => onEditDraft(event.target.value)} rows={3} value={editDraft} readOnly={isBusy} />
          <div className="memory-item__editor-actions">
            <button className="button button--primary button--small" disabled={isBusy || !editDraft.trim()} onClick={() => onSaveEdit(memory)} type="button">{text("保存")}</button>
            <button className="button button--quiet button--small" disabled={isBusy} onClick={onCancelEdit} type="button">{text("取消")}</button>
          </div>
        </div>
      ) : (
        <>
          <code className="memory-item__content">{memory.content}</code>
          <button data-memory-edit={memory.id} className="button button--quiet button--small" disabled={isBusy} onClick={() => onBeginEdit(memory)} type="button">
            {text("编辑")}
          </button>
        </>
      )}
      {memory.manuallyEdited ? <p className="memory-provenance">{text("已由你手动更正或采用，自动提取会保留这条记忆。")}</p> : null}
      {memory.reconciliation ? <div className="memory-reconciliation"><p><strong>{text(relationText[memory.reconciliation.kind])}</strong> · {memory.reconciliation.reason}</p>{memory.status === "pending" ? <p>{text("尚未用于对话。采用后，关联的生效记忆会保留为被替代版本。")}</p> : null}{memory.reconciliation.relatedMemoryIds.length ? <ul>{memory.reconciliation.relatedMemoryIds.map(id => {
        const related = memories.find(item => item.id === id);
        return <li key={id}>{related ? <><strong>{related.content}</strong><span> · {text(statusText[related.status])}{related.pinned ? text(" · 已固定") : ""}{related.manuallyEdited ? text(" · 人工更正") : ""}</span></> : text("关联记忆不在当前列表，可切换筛选查看。")}</li>;
      })}</ul> : null}{memory.claim?.transition ? <p>{text("原提取依据中的变化原文：")}<q>{memory.claim.transition.quote}</q></p> : null}</div> : null}
      <MemorySources memory={memory} replacement={memories.find(item => item.id === memory.supersededBy)} navigationBusy={navigationBusy} onOpenSource={onOpenSource} />
    </li>
  );
}
