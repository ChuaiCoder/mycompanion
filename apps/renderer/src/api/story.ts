import {
  storyExportJsonSchema,
  backupPayloadSchemaShared,
  backupRestorePreviewResponseSchema,
  backupRestoreResponseSchema,
  type BackupPayload,
  type BackupRestorePreviewResponse,
  type BackupRestoreResponse,
  type StoryExportJson,
} from "@mycompanion/shared";

import { readApiPayload } from "./core";

// 故事导出（FR-DATA-002）：Markdown 或 JSON。
export function storyExportUrl(id: string, format: "markdown" | "json"): string {
  return `/api/conversations/${encodeURIComponent(id)}/export?format=${format}`;
}

export async function fetchStoryExport(id: string, signal?: AbortSignal): Promise<StoryExportJson> {
  const response = await fetch(storyExportUrl(id, "json"), { headers: { Accept: "application/json" }, ...(signal ? { signal } : {}) });
  return storyExportJsonSchema.parse(await readApiPayload(response));
}

// 完整备份（FR-DATA-003）：导出 / 恢复预览 / 恢复。
export async function fetchBackup(): Promise<BackupPayload> {
  const response = await fetch("/api/backup", { headers: { Accept: "application/json" } });
  return backupPayloadSchemaShared.parse(await readApiPayload(response));
}

export async function previewBackupRestore(
  backup: BackupPayload,
  strategy: "overwrite" | "skip",
): Promise<BackupRestorePreviewResponse> {
  const response = await fetch("/api/backup/restore/preview", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ backup, strategy }),
  });
  if (response.status === 422) return backupRestorePreviewResponseSchema.parse(await response.json());
  return backupRestorePreviewResponseSchema.parse(await readApiPayload(response));
}

export async function applyBackupRestore(
  backup: BackupPayload,
  strategy: "overwrite" | "skip",
): Promise<BackupRestoreResponse> {
  const response = await fetch("/api/backup/restore", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ backup, strategy }),
  });
  return backupRestoreResponseSchema.parse(await readApiPayload(response));
}
