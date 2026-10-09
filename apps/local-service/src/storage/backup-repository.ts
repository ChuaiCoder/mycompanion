import type { DatabaseSync } from "node:sqlite";
import type {
  BackupPayload,
  ChatMessage,
  ConversationDetail,
  MemoryRecord,
  MessageGenerationMetadata,
} from "@mycompanion/shared";
import { messageFromRow, type MessageRow } from "../persistence/message-row.js";
import { memoryFromRow, type MemoryRow } from "../persistence/memory-row.js";
import type { StageSummaryRow } from "../persistence/stage-summary-row.js";
import { activeBranchId, type ConversationRow } from "../persistence/conversation-row.js";

/**
 * 备份恢复聚合（FR-DATA-003）：全量导出角色关联数据、覆盖恢复整条故事、
 * 以及恢复预览用的存在性检查。与 storage/backup.ts 的序列化/校验层同域；
 * 序列化（含 base64 / 校验）仍由调用方负责。
 */
export class BackupRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly getConversation: (id: string) => ConversationDetail | undefined,
  ) {}

  /**
   * 备份聚合（FR-DATA-003）：全量读取角色关联的数据，供备份包组装。
   * 这里返回原始行，序列化（含 base64 / 校验）由调用方负责。
   */
  listConversationsForBackup(): Array<{
    id: string;
    characterId: string;
    characterName: string;
    title: string;
    activeBranchId: string;
    createdAt: string;
    updatedAt: string;
    /** 软删除时间。备份必须带上它，否则恢复后已删故事会重新出现。 */
    deletedAt?: string;
    messages: ChatMessage[];
    chatMetadata: Record<string, unknown>;
    chatHeader: Record<string, unknown>;
  }> {
    const conversations = this.database
      .prepare("SELECT * FROM conversations ORDER BY created_at")
      .all() as unknown as ConversationRow[];
    return conversations.map((row) => ({
      id: row.id,
      characterId: row.character_id,
      characterName: row.character_name,
      title: row.title,
      activeBranchId: row.active_branch_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
      // 备份包含全部分支的完整消息树（不止激活分支）。
      messages: this.listAllBranchMessages(row.id),
      chatMetadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
      chatHeader: JSON.parse(row.header_json) as Record<string, unknown>,
    }));
  }

  // 一个对话所有分支的消息（备份用，含 branch_id / parent 链接）。
  listAllBranchMessages(conversationId: string): ChatMessage[] {
    const rows = this.database.prepare(`
      SELECT messages.*, rowid AS message_sequence FROM messages
      WHERE conversation_id = ?
      ORDER BY rowid ASC
    `).all(conversationId) as unknown as MessageRow[];
    return rows.map(messageFromRow);
  }

  listMemoriesForBackup(): MemoryRecord[] {
    const rows = this.database.prepare("SELECT * FROM memories ORDER BY created_at").all() as unknown as MemoryRow[];
    return rows.map((row) => memoryFromRow(row));
  }

  listStageSummariesForBackup(): BackupPayload["stageSummaries"] {
    const rows = this.database
      .prepare("SELECT * FROM stage_summaries ORDER BY created_at")
      .all() as unknown as StageSummaryRow[];
    return rows.map((row) => ({
      conversationId: row.conversation_id,
      branchId: row.branch_id,
      sourceMessageIds: JSON.parse(row.source_message_ids_json) as string[],
      sourceFingerprint: row.source_fingerprint,
      previousSource: row.previous_source_json ? JSON.parse(row.previous_source_json) as NonNullable<BackupPayload["stageSummaries"][number]["previousSource"]> : null,
      content: row.content,
      coveredMessageCount: row.covered_message_count,
      model: row.model,
      previousContent: row.previous_content,
      createdAt: row.created_at,
    }));
  }

  listConversationSettingsForBackup(): Array<{ conversationId: string; autoSummaryEnabled: boolean }> {
    const rows = this.database
      .prepare("SELECT * FROM conversation_settings ORDER BY conversation_id")
      .all() as unknown as Array<{ conversation_id: string; auto_summary_enabled: number }>;
    return rows.map((row) => ({
      conversationId: row.conversation_id,
      autoSummaryEnabled: Boolean(row.auto_summary_enabled),
    }));
  }

  // 备份恢复（FR-DATA-003）：整条故事覆盖写入（旧消息/摘要/设置先清空）。
  restoreConversation(entry: {
    id: string;
    characterId: string;
    characterName: string;
    title: string;
    activeBranchId: string;
    createdAt: string;
    updatedAt: string;
    /** 备份里的软删除时间；缺省表示这条故事是活跃的（旧备份即如此）。 */
    deletedAt?: string | undefined;
    chatMetadata?: Record<string, unknown> | undefined;
    chatHeader?: Record<string, unknown> | undefined;
    messages: Array<{
      id: string;
      branchId: string;
      parentMessageId: string | null;
      role: ChatMessage["role"];
      content: string;
      status: ChatMessage["status"];
      createdAt: string;
      extensionData?: Record<string, unknown> | undefined;
      generationMetadata?: MessageGenerationMetadata | undefined;
    }>;
  }): number {
    const previous = this.getConversation(entry.id);
    const previousMessages = new Map(this.listAllBranchMessages(entry.id).map(message => [`${message.branchId}/${message.id}`, message]));
    this.database.exec("SAVEPOINT restore_conversation");
    try {
      this.database.prepare(`
        INSERT INTO conversations (id, character_id, character_name, title, active_branch_id, created_at, updated_at, metadata_json, header_json, deleted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          character_name = excluded.character_name,
          title = excluded.title,
          active_branch_id = excluded.active_branch_id,
          updated_at = excluded.updated_at,
          metadata_json = excluded.metadata_json,
          header_json = excluded.header_json,
          deleted_at = excluded.deleted_at
      `).run(entry.id, entry.characterId, entry.characterName, entry.title, entry.activeBranchId, entry.createdAt, entry.updatedAt, JSON.stringify(entry.chatMetadata ?? previous?.chatMetadata ?? {}), JSON.stringify(entry.chatHeader ?? previous?.chatHeader ?? {}), entry.deletedAt ?? null);
      // 覆盖恢复：清掉该对话的旧消息/摘要/设置，再写入备份的完整消息树（全部分支）。
      this.database.prepare("DELETE FROM messages WHERE conversation_id = ?").run(entry.id);
      this.database.prepare("DELETE FROM stage_summaries WHERE conversation_id = ?").run(entry.id);
      this.database.prepare("DELETE FROM conversation_settings WHERE conversation_id = ?").run(entry.id);
      this.database.prepare("DELETE FROM memories WHERE conversation_id = ?").run(entry.id);
      const insert = this.database.prepare(`
        INSERT INTO messages (id, conversation_id, branch_id, parent_message_id, role, content, status, created_at, extension_data_json, generation_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id, branch_id) DO UPDATE SET
          parent_message_id = excluded.parent_message_id,
          content = excluded.content,
          status = excluded.status,
          created_at = excluded.created_at,
          extension_data_json = excluded.extension_data_json,
          generation_json = excluded.generation_json
      `);
      for (const message of entry.messages) {
        insert.run(message.id, entry.id, message.branchId, message.parentMessageId, message.role, message.content, message.status, message.createdAt,
          JSON.stringify(message.extensionData ?? previousMessages.get(`${message.branchId}/${message.id}`)?.extensionData ?? {}),
          JSON.stringify(message.generationMetadata ?? previousMessages.get(`${message.branchId}/${message.id}`)?.generationMetadata ?? null));
      }
      this.database.exec("RELEASE restore_conversation");
    } catch (error) {
      this.database.exec("ROLLBACK TO restore_conversation; RELEASE restore_conversation");
      throw error;
    }
    return entry.messages.length;
  }

  // 恢复单条记忆：同 ID 覆盖，否则插入。（FR-DATA-003）
  upsertMemoryForBackup(record: MemoryRecord): void {
    this.database.prepare(`
      INSERT INTO memories (
        id, conversation_id, character_id, type, content, scope, importance,
        status, pinned, source_message_ids_json, source_message_fingerprints_json, superseded_by, previous_content,
        created_at, last_used_at, provenance_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        character_id = excluded.character_id,
        type = excluded.type,
        content = excluded.content,
        scope = excluded.scope,
        importance = excluded.importance,
        status = excluded.status,
        pinned = excluded.pinned,
        source_message_ids_json = excluded.source_message_ids_json,
        source_message_fingerprints_json = excluded.source_message_fingerprints_json,
        superseded_by = excluded.superseded_by,
        previous_content = excluded.previous_content,
        created_at = excluded.created_at,
        last_used_at = excluded.last_used_at,
        provenance_json = excluded.provenance_json
    `).run(
      record.id,
      record.conversationId,
      record.characterId,
      record.type,
      record.content,
      record.scope,
      record.importance,
      record.status,
      record.pinned ? 1 : 0,
      JSON.stringify(record.sourceMessageIds),
      JSON.stringify(record.sourceMessageFingerprints ?? {}),
      record.supersededBy,
      record.previousContent,
      record.createdAt,
      record.lastUsedAt,
      JSON.stringify({ manuallyEdited: record.manuallyEdited ?? (record.previousContent !== null || record.sourceMessageIds.length === 0),
        ...(record.claim ? { claim: record.claim } : {}), ...(record.reconciliation ? { reconciliation: record.reconciliation } : {}) }),
    );
  }

  restoreStageSummary(summary: BackupPayload["stageSummaries"][number]): void {
    const branchId = summary.branchId ?? activeBranchId(this.database, summary.conversationId);
    if (!branchId) throw new Error("Restored summary story does not exist.");
    this.database.prepare(`
      INSERT INTO stage_summaries (conversation_id, branch_id, source_message_ids_json, source_fingerprint,
        previous_source_json, content, covered_message_count, model, previous_content, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id, branch_id) DO UPDATE SET
        source_message_ids_json = excluded.source_message_ids_json,
        source_fingerprint = excluded.source_fingerprint,
        previous_source_json = excluded.previous_source_json,
        content = excluded.content,
        covered_message_count = excluded.covered_message_count,
        model = excluded.model,
        previous_content = excluded.previous_content,
        created_at = excluded.created_at
    `).run(summary.conversationId, branchId, JSON.stringify(summary.sourceMessageIds ?? []), summary.sourceFingerprint ?? "",
      summary.previousSource ? JSON.stringify(summary.previousSource) : null, summary.content,
      summary.coveredMessageCount, summary.model, summary.previousContent, summary.createdAt);
  }

  /** 读取某故事的自动摘要开关；没有记录时返回 undefined（与"已关闭"区分开）。 */
  getConversationSetting(conversationId: string): { conversationId: string; autoSummaryEnabled: boolean } | undefined {
    const row = this.database
      .prepare("SELECT conversation_id, auto_summary_enabled FROM conversation_settings WHERE conversation_id = ?")
      .get(conversationId) as { conversation_id: string; auto_summary_enabled: number } | undefined;
    return row ? { conversationId: row.conversation_id, autoSummaryEnabled: row.auto_summary_enabled === 1 } : undefined;
  }

  restoreConversationSetting(setting: { conversationId: string; autoSummaryEnabled: boolean }): void {
    this.database.prepare(`
      INSERT INTO conversation_settings (conversation_id, auto_summary_enabled) VALUES (?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET auto_summary_enabled = excluded.auto_summary_enabled
    `).run(setting.conversationId, setting.autoSummaryEnabled ? 1 : 0);
  }

  restorePlugin(plugin: { id: string; manifest: Record<string, unknown>; enabled: boolean; installedAt: string }): void {
    this.database.prepare(`
      INSERT INTO plugins (id, manifest_json, enabled, installed_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        manifest_json = excluded.manifest_json,
        enabled = excluded.enabled,
        installed_at = excluded.installed_at
    `).run(plugin.id, JSON.stringify(plugin.manifest), plugin.enabled ? 1 : 0, plugin.installedAt);
  }

  // 备份恢复存在性检查（FR-DATA-003 预览）。
  conversationExists(id: string): boolean {
    return this.database.prepare("SELECT 1 FROM conversations WHERE id = ?").get(id) !== undefined;
  }
  memoryExists(id: string): boolean {
    return this.database.prepare("SELECT 1 FROM memories WHERE id = ?").get(id) !== undefined;
  }
  stageSummaryExists(conversationId: string, branchId = activeBranchId(this.database, conversationId)): boolean {
    return this.database.prepare("SELECT 1 FROM stage_summaries WHERE conversation_id = ? AND branch_id = ?")
      .get(conversationId, branchId ?? "") !== undefined;
  }
  pluginExists(id: string): boolean {
    return this.database.prepare("SELECT 1 FROM plugins WHERE id = ?").get(id) !== undefined;
  }
  // 声明式插件的原始 manifest（备份用）。
  getPluginManifest(id: string): Record<string, unknown> | undefined {
    const row = this.database
      .prepare("SELECT manifest_json FROM plugins WHERE id = ?")
      .get(id) as { manifest_json: string } | undefined;
    return row ? (JSON.parse(row.manifest_json) as Record<string, unknown>) : undefined;
  }
}
