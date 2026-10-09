import type { ChatMessage, MessageGenerationMetadata } from "@mycompanion/shared";
import { projectNativeCandidateMessage } from "@mycompanion/shared";

/** messages 表行 → ChatMessage 的共享解析（运行时读取与备份聚合共用）。 */
export interface MessageRow {
  id: string;
  conversation_id: string;
  branch_id: string;
  parent_message_id: string | null;
  role: ChatMessage["role"];
  content: string;
  status: ChatMessage["status"];
  generation_json: string | null;
  created_at: string;
  extension_data_json: string;
}

function parseGeneration(json: string | null): MessageGenerationMetadata | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as MessageGenerationMetadata;
  } catch {
    return undefined;
  }
}

export function messageFromRow(row: MessageRow): ChatMessage {
  const generation = parseGeneration(row.generation_json);
  return projectNativeCandidateMessage({
    id: row.id,
    conversationId: row.conversation_id,
    branchId: row.branch_id,
    parentMessageId: row.parent_message_id,
    role: row.role,
    content: row.content,
    status: row.status,
    ...(generation ? { generationMetadata: generation } : {}),
    ...(row.extension_data_json && row.extension_data_json !== "{}" ? { extensionData: JSON.parse(row.extension_data_json) as Record<string, unknown> } : {}),
    createdAt: row.created_at,
  });
}
