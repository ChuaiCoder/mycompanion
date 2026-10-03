import { useEffect, useRef, useState, type ChangeEvent } from "react";

import type { CharacterCardPreviewResponse, CharacterDetail } from "@mycompanion/shared";

import { ApiRequestError, commitCharacterCard, previewCharacterCard, fetchCharacter } from "../api";
import { createIdempotencyKey } from "../components";
export interface ImportQueueItem { id: string; fileName: string; status: "waiting" | "previewing" | "ready" | "failed" | "saved" | "opened" | "skipped"; error: string }
interface QueuedFile extends ImportQueueItem { file: File; keys: Map<string, string> }

// 角色卡导入：文件选择 → 预览 → 幂等提交，以及导入相关的提示状态。
// onPreviewStart：首个文件开始读取预览时回调。预览 UI 位于角色库视图，
// 对话优先的布局下需要借此把用户带过去看检查结果。
export function useCharacterImport(deps: {
  onCommitted: (character: CharacterDetail) => void;
  onPreviewStart?: () => void;
}) {
  const { onCommitted, onPreviewStart } = deps;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewHeadingRef = useRef<HTMLHeadingElement>(null);
  const [preview, setPreview] = useState<CharacterCardPreviewResponse | null>(null);
  const [draftFile, setDraftFile] = useState<File | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [importErrorDetails, setImportErrorDetails] = useState<string[]>([]);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [batchItems, setBatchItems] = useState<ImportQueueItem[]>([]);
  const queue = useRef<QueuedFile[]>([]), active = useRef<QueuedFile | null>(null), revision = useRef(0);
  const publish = () => setBatchItems(queue.current.map(({ id, fileName, status, error }) => ({ id, fileName, status, error })));

  useEffect(() => {
    if (preview) previewHeadingRef.current?.focus();
  }, [preview]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "i") {
        event.preventDefault();
        if (!isImporting && !isSaving) fileInputRef.current?.click();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [isImporting, isSaving]);

  const openFilePicker = (): void => fileInputRef.current?.click();

  const clearPreview = (): void => {
    setPreview(null);
    setDraftFile(null);
    setIdempotencyKey("");
  };
  const clearImportState = (): void => { revision.current++; active.current = null; queue.current = []; publish(); clearPreview(); setIsImporting(false); };
  const fail = (error: unknown, fallback: string) => {
    const message = error instanceof ApiRequestError ? error.message : fallback;
    setImportError(message); setImportErrorDetails(error instanceof ApiRequestError ? error.details : []);
    if (active.current) { active.current.error = message; active.current.status = "failed"; publish(); }
  };
  const advance = async (): Promise<void> => {
    const next = queue.current.find(item => item.status === "waiting");
    if (next) await loadItem(next); else { active.current = null; clearPreview(); setIsImporting(false); }
  };
  async function loadItem(item: QueuedFile): Promise<void> {
    const token = ++revision.current; active.current = item; item.status = "previewing"; item.error = ""; publish();
    setIsImporting(true); setImportError(null); setImportErrorDetails([]); clearPreview();
    onPreviewStart?.();
    try {
      const nextPreview = await previewCharacterCard(item.file);
      if (token !== revision.current) return;
      item.status = "ready"; publish(); setPreview(nextPreview); setDraftFile(item.file); setIdempotencyKey(item.id);
    } catch (error) {
      if (token !== revision.current) return;
      fail(error, "角色卡预览失败，请重试这个文件。"); await advance();
    } finally { if (token === revision.current) setIsImporting(false); }
  }

  const handleCardFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (!files.length) return;

    setIsImporting(true);
    setImportError(null);
    setImportErrorDetails([]);
    setSuccessMessage(null);
    clearImportState();

    queue.current = files.map(file => ({ id: createIdempotencyKey(), fileName: file.name, file, keys: new Map(), status: "waiting", error: "" })); publish(); await advance();
  };

  const handleCommit = async (mode: "copy" | "replace" = "copy", targetId?: string, expectedUpdatedAt?: string): Promise<void> => {
    if (!draftFile || !preview || !idempotencyKey) return;
    if (mode === "replace" && (!targetId || !expectedUpdatedAt)) { setImportError("请选择要替换的既有角色。"); return; }
    const options = mode === "replace" && targetId && expectedUpdatedAt ? { mode, targetId, expectedUpdatedAt } : undefined;

    setIsSaving(true);
    setImportError(null);
    setImportErrorDetails([]);
    setSuccessMessage(null);
    const token = revision.current, item = active.current;
    const choice = JSON.stringify([mode, targetId, expectedUpdatedAt]);
    if (item && !item.keys.has(choice)) item.keys.set(choice, createIdempotencyKey());
    try {
      const character = await commitCharacterCard(draftFile, item?.keys.get(choice) ?? idempotencyKey, undefined, options);
      if (token !== revision.current) return;
      onCommitted(character);
      if (item) { item.status = "saved"; item.error = ""; publish(); }
      clearPreview();
      setSuccessMessage(`“${character.name}”已保存，可以从角色列表继续使用。`);
      await advance();
    } catch (error) {
      if (token !== revision.current) return;
      fail(error, "保存角色失败，请重试这个文件。");
      if (queue.current.length > 1) { clearPreview(); await advance(); }
    } finally {
      setIsSaving(false);
    }
  };
  const handleOpenDuplicate = async (id: string): Promise<void> => {
    const token = revision.current; setIsSaving(true); setImportError(null);
    try {
      const character = await fetchCharacter(id); if (token !== revision.current) return;
      onCommitted(character); if (active.current) { active.current.status = "opened"; active.current.error = ""; publish(); }
      clearPreview(); setSuccessMessage(`已打开既有角色“${character.name}”。`); await advance();
    } catch (error) { if (token === revision.current) fail(error, "无法打开既有角色，请重试。"); }
    finally { setIsSaving(false); }
  };
  const handleSkipFile = async (): Promise<void> => { if (isImporting || isSaving) return; if (active.current) { active.current.status = "skipped"; publish(); } clearPreview(); await advance(); };
  const handleRetryFile = async (id: string): Promise<void> => { if (isImporting || isSaving || preview) return; const item = queue.current.find(value => value.id === id); if (item?.status === "failed") await loadItem(item); };
  const handleRefreshPreview = async (): Promise<void> => { if (!isImporting && !isSaving && active.current) await loadItem(active.current); };

  return {
    fileInputRef,
    previewHeadingRef,
    preview,
    draftFile,
    importError,
    importErrorDetails,
    successMessage,
    setSuccessMessage,
    isImporting,
    isSaving,
    openFilePicker,
    clearImportState,
    handleCardFile,
    handleCommit,
    batchItems, handleSkipFile, handleRetryFile, handleOpenDuplicate, handleRefreshPreview,
  };
}
