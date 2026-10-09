import type { StageSummary } from "@mycompanion/shared";

/** stage_summaries 表行 → StageSummary 的共享解析（摘要域与备份聚合共用）。 */
export interface StageSummaryRow {
  conversation_id: string;
  branch_id: string;
  source_message_ids_json: string;
  source_fingerprint: string;
  previous_source_json: string | null;
  content: string;
  covered_message_count: number;
  model: string;
  previous_content: string | null;
  created_at: string;
}

export function stageSummaryFromRow(row: StageSummaryRow): StageSummary {
  return {
    id: row.conversation_id,
    conversationId: row.conversation_id,
    branchId: row.branch_id,
    sourceMessageIds: JSON.parse(row.source_message_ids_json) as string[],
    content: row.content,
    coveredMessageCount: row.covered_message_count,
    model: row.model,
    ...(row.previous_content !== null ? { previousContent: row.previous_content } : { previousContent: null }),
    createdAt: row.created_at,
  };
}
