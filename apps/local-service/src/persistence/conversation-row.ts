import type { DatabaseSync } from "node:sqlite";

/** conversations 表行结构与当前分支查询（运行时仓储与备份聚合共用）。 */
export interface ConversationRow {
  id: string;
  character_id: string;
  character_name: string;
  title: string;
  last_message_preview: string;
  message_count: number;
  active_branch_id: string;
  created_at: string;
  updated_at: string;
  metadata_json: string;
  header_json: string;
  /** 软删除时间（迁移后新增列；旧库升级时由 ALTER TABLE 补齐）。 */
  deleted_at?: string | null;
}

// 取对话的当前分支 ID。
export function activeBranchId(database: DatabaseSync, conversationId: string): string | undefined {
  const row = database.prepare(
    "SELECT active_branch_id FROM conversations WHERE id = ?",
  ).get(conversationId) as { active_branch_id: string } | undefined;
  return row?.active_branch_id;
}
