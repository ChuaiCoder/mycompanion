import type { MemoryRecord } from "@mycompanion/shared";

/** memories 表行 → MemoryRecord 的共享解析（记忆域与备份聚合共用）。 */
export interface MemoryRow {
  id: string;
  conversation_id: string;
  character_id: string;
  type: MemoryRecord["type"];
  content: string;
  scope: MemoryRecord["scope"];
  importance: number;
  status: MemoryRecord["status"];
  pinned: number;
  source_message_ids_json: string;
  source_message_fingerprints_json: string;
  superseded_by: string | null;
  previous_content: string | null;
  created_at: string;
  last_used_at: string | null;
  provenance_json: string;
}

export function memoryFromRow(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    characterId: row.character_id,
    type: row.type,
    content: row.content,
    scope: row.scope,
    importance: row.importance,
    status: row.status,
    pinned: Boolean(row.pinned),
    sourceMessageIds: JSON.parse(row.source_message_ids_json) as string[],
    sourceMessageFingerprints: JSON.parse(row.source_message_fingerprints_json) as Record<string, string>,
    supersededBy: row.superseded_by,
    previousContent: row.previous_content,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    ...JSON.parse(row.provenance_json) as Pick<MemoryRecord, "manuallyEdited" | "claim" | "reconciliation">,
  };
}
