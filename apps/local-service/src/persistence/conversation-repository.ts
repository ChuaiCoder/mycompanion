import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { MacroVariableConflictError } from "../prompt/macro-variable-conflict.js";
import { worldInfoStateRevision, worldInfoSourcesMatch, WORLD_INFO_STATE_KEY, restoreWorldInfoStateForBranch } from "../world-info/world-info-effects.js";
import type {
  ChatMessage,
  CharacterDetail,
  ConversationDetail,
  ConversationListResponse,
  ConversationSummary,
  MessageGenerationMetadata,
  ModelCandidateSnapshot,
  StageSummary,
} from "@mycompanion/shared";
import { projectNativeCandidateMessage, NATIVE_CANDIDATE_INFO_KEY, messageGenerationMetadataSchema } from "@mycompanion/shared";
import { messageFromRow, type MessageRow } from "./message-row.js";
import { stageSummaryFromRow, type StageSummaryRow } from "./stage-summary-row.js";
import { activeBranchId, type ConversationRow } from "./conversation-row.js";
import { sourceFingerprint, summaryMessages } from "./message-fingerprint.js";

/** 候选回复切换冲突（消息流式中、序号失效）。路由映射为 409。 */
export class SwipeSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwipeSelectionError";
  }
}

function expandMacros(text: string, characterName: string): string {
  return text
    .replaceAll(/{{\s*char\s*}}/gi, characterName)
    .replaceAll(/{{\s*user\s*}}/gi, "User");
}

// 列表预览：消息原文可能是 markdown / HTML / 代码块，这里压成纯文本单行，
// 避免在故事列表里露出 ```html <html>… 这类原始标记。
function plainPreview(content: string, maxLength = 80): string {
  const text = content
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~>#-]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text) return text.length > maxLength ? text.slice(0, maxLength) : text;
  // 整条都是代码/标记时的兜底：给出一点原始上下文。
  const raw = content.replace(/\s+/g, " ").trim();
  return raw.length > 40 ? raw.slice(0, 40) : raw;
}

function summaryFromRow(row: ConversationRow): ConversationSummary {
  return {
    id: row.id,
    characterId: row.character_id,
    characterName: row.character_name,
    title: row.title,
    lastMessagePreview: plainPreview(row.last_message_preview),
    messageCount: row.message_count,
    activeBranchId: row.active_branch_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 故事核心域：故事 CRUD 与软删/清退、消息/分支/swipe、阶段摘要（FR-MEM-006/007）、
 * 世界书状态提交。记忆可达性同步经注入的 syncMemoryReachability 回到记忆域；
 * 事务经注入的 withTransaction 与装配层共享同一个 SAVEPOINT 实现，跨域原子性不变。
 */
export class ConversationRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly withTransaction: <T>(work: () => T) => T,
    private readonly syncMemoryReachability: (conversationId: string) => void,
  ) {}

  createConversation(character: CharacterDetail, greetingIndex?: number): ConversationDetail {
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const greeting = greetingIndex === undefined || greetingIndex === 0
      ? character.firstMessage
      : character.alternateGreetings[greetingIndex - 1] ?? character.firstMessage;
    const title = `${character.name} · ${new Intl.DateTimeFormat("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date())}`;

    // 每个新故事都有独立的根分支；开场白作为该分支的第一条角色消息。
    // 有备用开场白时，候选列表随消息落库（原生 swipe 选择的数据源）。
    this.withTransaction(() => {
      this.database.prepare(`
        INSERT INTO conversations (
          id, character_id, character_name, title, active_branch_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, character.id, character.name, title, id, timestamp, timestamp);
      if (greeting.trim()) {
        const alternates = character.alternateGreetings;
        const extensionData = JSON.stringify(alternates.length ? {
          swipes: [greeting, ...alternates.map(value => expandMacros(value, character.name))],
          swipe_id: 0,
          swipe_info: [greeting, ...alternates].map(() => ({ send_date: timestamp, extra: {} })),
        } : {});
        this.database.prepare(`
          INSERT INTO messages (
            id, conversation_id, branch_id, parent_message_id, role, content, status, extension_data_json, created_at
          ) VALUES (?, ?, ?, NULL, 'assistant', ?, 'complete', ?, ?)
        `).run(randomUUID(), id, id, expandMacros(greeting, character.name), extensionData, timestamp);
      }
    });
    const detail = this.getConversation(id);
    if (!detail) throw new Error("Conversation creation failed.");
    return detail;
  }

  // 取对话的当前分支 ID。
  private activeBranchId(conversationId: string): string | undefined {
    return activeBranchId(this.database, conversationId);
  }

  // 自动摘要开关（FR-MEM-006）：默认开启。
  isAutoSummaryEnabled(conversationId: string): boolean {
    const row = this.database.prepare(
      "SELECT auto_summary_enabled FROM conversation_settings WHERE conversation_id = ?",
    ).get(conversationId) as { auto_summary_enabled: number } | undefined;
    return row?.auto_summary_enabled !== 0;
  }

  setAutoSummaryEnabled(conversationId: string, enabled: boolean): void {
    this.database.prepare(`
      INSERT INTO conversation_settings (conversation_id, auto_summary_enabled)
      VALUES (?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET auto_summary_enabled = excluded.auto_summary_enabled
    `).run(conversationId, enabled ? 1 : 0);
  }

  // 阶段摘要（FR-MEM-006）。
  getSummary(conversationId: string): StageSummary | undefined {
    const branchId = this.activeBranchId(conversationId);
    if (!branchId) return undefined;
    const row = this.database.prepare(`
      SELECT * FROM stage_summaries WHERE conversation_id = ? AND branch_id = ?
    `).get(conversationId, branchId) as StageSummaryRow | undefined;
    if (!row) return undefined;
    const sources = this.#summarySourcePrefix(conversationId, row.covered_message_count);
    return { ...stageSummaryFromRow(row), valid: sources.length === row.covered_message_count
      && row.source_fingerprint === sourceFingerprint(sources)
      && isDeepStrictEqual(JSON.parse(row.source_message_ids_json), sources.map(message => message.id)) };
  }

  saveSummary(conversationId: string, content: string, coveredMessageCount: number, model: string): StageSummary {
    const branchId = this.activeBranchId(conversationId);
    if (!branchId) throw new Error("Summary story does not exist.");
    const sources = this.#summarySourcePrefix(conversationId, coveredMessageCount);
    const createdAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO stage_summaries (conversation_id, branch_id, source_message_ids_json, source_fingerprint,
        content, covered_message_count, model, previous_content, previous_source_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
      ON CONFLICT(conversation_id, branch_id) DO UPDATE SET
        source_message_ids_json = excluded.source_message_ids_json,
        source_fingerprint = excluded.source_fingerprint,
        content = excluded.content,
        covered_message_count = excluded.covered_message_count,
        model = excluded.model,
        previous_content = excluded.previous_content,
        previous_source_json = excluded.previous_source_json,
        created_at = excluded.created_at
    `).run(conversationId, branchId, JSON.stringify(sources.map(message => message.id)), sourceFingerprint(sources), content,
      sources.length, model, createdAt);
    const saved = this.getSummary(conversationId);
    if (!saved) throw new Error("Summary save failed.");
    return saved;
  }

  // 编辑摘要：保留旧内容用于恢复上一版本（FR-MEM-007）。
  editSummary(conversationId: string, content: string): StageSummary | undefined {
    const existing = this.getSummary(conversationId);
    if (!existing) return undefined;
    const branchId = this.activeBranchId(conversationId)!;
    const previous = this.database.prepare("SELECT * FROM stage_summaries WHERE conversation_id = ? AND branch_id = ?")
      .get(conversationId, branchId) as StageSummaryRow | undefined;
    if (!previous) return undefined;
    const sources = summaryMessages(this.listMessages(conversationId)).slice(0, existing.coveredMessageCount);
    this.database.prepare(`
      UPDATE stage_summaries SET content = ?, previous_content = ?, previous_source_json = ?,
        covered_message_count = ?, source_message_ids_json = ?, source_fingerprint = ?, created_at = ?
      WHERE conversation_id = ? AND branch_id = ?
    `).run(content, existing.content, JSON.stringify({ sourceMessageIds: JSON.parse(previous.source_message_ids_json),
      sourceFingerprint: previous.source_fingerprint, coveredMessageCount: previous.covered_message_count }),
      sources.length, JSON.stringify(sources.map(message => message.id)), sourceFingerprint(sources),
      new Date().toISOString(), conversationId, branchId);
    return this.getSummary(conversationId);
  }

  restoreSummary(conversationId: string): StageSummary | undefined {
    const existing = this.getSummary(conversationId);
    if (!existing || existing.previousContent === null) return existing;
    const branchId = this.activeBranchId(conversationId)!;
    const row = this.database.prepare("SELECT previous_source_json FROM stage_summaries WHERE conversation_id = ? AND branch_id = ?")
      .get(conversationId, branchId) as { previous_source_json: string | null };
    const previous = row.previous_source_json ? JSON.parse(row.previous_source_json) as {
      sourceMessageIds: string[]; sourceFingerprint: string; coveredMessageCount: number;
    } : { sourceMessageIds: [], sourceFingerprint: "", coveredMessageCount: existing.coveredMessageCount };
    this.database.prepare(`
      UPDATE stage_summaries SET content = previous_content, previous_content = NULL, previous_source_json = NULL,
        covered_message_count = ?, source_message_ids_json = ?, source_fingerprint = ?, created_at = ?
      WHERE conversation_id = ? AND branch_id = ?
    `).run(previous.coveredMessageCount, JSON.stringify(previous.sourceMessageIds), previous.sourceFingerprint,
      new Date().toISOString(), conversationId, branchId);
    return this.getSummary(conversationId);
  }

  /** 摘要资格消息的有序前缀：与 summaryMessages 的过滤条件一致，但不下场加载整段历史。 */
  #summarySourcePrefix(conversationId: string, count: number): ChatMessage[] {
    if (count <= 0) return [];
    // SQLite 的 trim() 默认只去空格；JS 的 String.prototype.trim() 去全部空白。
    // 两者必须对齐，否则一条纯换行的消息会进 SQL 前缀、不进 JS 列表，
    // 刚保存的摘要会立刻被判定失效。
    const rows = this.database.prepare(`
      SELECT messages.*, rowid AS message_sequence FROM messages
      WHERE conversation_id = ? AND branch_id = (SELECT active_branch_id FROM conversations WHERE id = ?)
        AND status = 'complete' AND trim(content, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)) != ''
        AND (json_extract(generation_json, '$.completionOutcome') IS NULL
          OR json_extract(generation_json, '$.completionOutcome') = 'complete')
      ORDER BY rowid ASC LIMIT ?
    `).all(conversationId, conversationId, count) as unknown as MessageRow[];
    return rows.map(messageFromRow);
  }

  #inheritSummary(conversationId: string, oldBranch: string, newBranch: string, prefix: ChatMessage[]): void {
    const row = this.database.prepare("SELECT * FROM stage_summaries WHERE conversation_id = ? AND branch_id = ?")
      .get(conversationId, oldBranch) as StageSummaryRow | undefined;
    if (!row) return;
    const sources = summaryMessages(prefix).slice(0, row.covered_message_count);
    if (sources.length !== row.covered_message_count || sourceFingerprint(sources) !== row.source_fingerprint
      || !isDeepStrictEqual(sources.map(message => message.id), JSON.parse(row.source_message_ids_json))) return;
    this.database.prepare(`INSERT INTO stage_summaries
      SELECT conversation_id, ?, source_message_ids_json, source_fingerprint, previous_source_json,
        content, covered_message_count, model, previous_content, created_at
      FROM stage_summaries WHERE conversation_id = ? AND branch_id = ?`).run(newBranch, conversationId, oldBranch);
  }

  listConversations(): ConversationListResponse {
    const rows = this.database.prepare(`
      SELECT c.*,
        COALESCE((SELECT substr(m.content, 1, 400) FROM messages m
          WHERE m.conversation_id = c.id AND m.branch_id = c.active_branch_id
          ORDER BY m.rowid DESC LIMIT 1), '') AS last_message_preview,
        (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id AND m.branch_id = c.active_branch_id) AS message_count
      FROM conversations c
      JOIN characters ch ON ch.id = c.character_id AND ch.deleted_at IS NULL
      WHERE c.deleted_at IS NULL
      ORDER BY c.updated_at DESC, c.id DESC
    `).all() as unknown as ConversationRow[];
    return { items: rows.map(summaryFromRow), total: rows.length };
  }

  /**
   * 软删除（FR-DATA-004）：只标记 deleted_at，消息、分支、摘要与记忆来源全部保留，
   * 因此恢复后原样可用。列表/详情在读取时按该列过滤，无需级联改写派生数据。
   * 返回删除时间；故事不存在或已删除时返回 undefined（幂等）。
   */
  softDeleteConversation(id: string): string | undefined {
    const timestamp = new Date().toISOString();
    const result = this.database.prepare(
      "UPDATE conversations SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
    ).run(timestamp, timestamp, id);
    return result.changes ? timestamp : undefined;
  }

  /** 撤销软删除；故事本来可见或不存在时返回 false。 */
  undeleteConversation(id: string): boolean {
    const result = this.database.prepare(
      "UPDATE conversations SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL",
    ).run(new Date().toISOString(), id);
    return result.changes > 0;
  }

  /**
   * 批量软删除：一个事务内完成，避免部分成功留下"删了一半"的状态。
   *
   * 与单条删除同语义（只打 deleted_at，内容全部保留、可恢复）。已删除或不存在的 id 不报错，
   * 而是回收到 `skipped`，让调用方知道哪些没生效，而不是把幂等写成"全部成功"。
   * 同一事务内取同一个时间戳，便于在界面上把它们视作同一次操作。
   */
  softDeleteConversations(ids: readonly string[]): { deleted: Array<{ id: string; deletedAt: string }>; skipped: string[] } {
    const unique = [...new Set(ids)];
    const timestamp = new Date().toISOString();
    const deleted: Array<{ id: string; deletedAt: string }> = [];
    const skipped: string[] = [];
    this.withTransaction(() => {
      const statement = this.database.prepare(
        "UPDATE conversations SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
      );
      for (const id of unique) {
        const result = statement.run(timestamp, timestamp, id);
        if (result.changes) deleted.push({ id, deletedAt: timestamp });
        else skipped.push(id);
      }
    });
    return { deleted, skipped };
  }

  /** 查询软删除状态，供路由区分「不存在」与「已删除」。 */
  conversationDeletedAt(id: string): string | null | undefined {
    const row = this.database
      .prepare("SELECT deleted_at FROM conversations WHERE id = ?")
      .get(id) as { deleted_at: string | null } | undefined;
    return row?.deleted_at;
  }

  /**
   * 彻底删除所有已软删除的故事，不可恢复。
   *
   * 软删除只打标记，内容会一直留在库里：实测一份库里有 141 个软删除故事、172 条消息，
   * 而界面上只剩 1 个可见。要让这些空间真正释放，就需要一次真正的删除。
   *
   * 只删 conversations 行——messages / memories / conversation_settings / stage_summaries
   * 都以 `ON DELETE CASCADE` 引用它，实测这些外键都带级联，因此不会有孤儿数据；
   * 手写一串子表删除反而容易漏表。整个过程在一个事务里，不允许"删了一半"。
   *
   * 返回真正删除的故事数；`VACUUM` 不在这里做（它不能在事务内执行），由调用方决定。
   */
  purgeDeletedConversations(): number {
    let removed = 0;
    this.withTransaction(() => {
      const result = this.database.prepare("DELETE FROM conversations WHERE deleted_at IS NOT NULL").run();
      removed = Number(result.changes ?? 0);
    });
    return removed;
  }

  /** 回收已释放页占用的磁盘空间；必须不在事务内执行。 */
  vacuum(): void {
    this.database.exec("VACUUM");
  }

  // 该角色关联的故事数（FR-DATA-004 删除前计数）。
  countConversationsForCharacter(characterId: string): number {
    const row = this.database
      .prepare("SELECT count(*) AS n FROM conversations WHERE character_id = ?")
      .get(characterId) as { n: number };
    return row.n;
  }

  /**
   * 读取故事详情。软删除的故事默认不可见（列表与详情一致），因此已删除的故事在只读
   * 路由上表现为 404。备份恢复等需要拿到已删除行的调用方显式传 `includeDeleted`。
   */
  getConversation(id: string, messageLimit?: number, options: { includeDeleted?: boolean } = {}): ConversationDetail | undefined {
    const row = this.database.prepare(`
      SELECT c.*,
        COALESCE((SELECT substr(m.content, 1, 400) FROM messages m
          WHERE m.conversation_id = c.id AND m.branch_id = c.active_branch_id
          ORDER BY m.rowid DESC LIMIT 1), '') AS last_message_preview,
        (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id AND m.branch_id = c.active_branch_id) AS message_count
      FROM conversations c WHERE c.id = ?${options.includeDeleted ? "" : " AND c.deleted_at IS NULL"}
    `).get(id) as ConversationRow | undefined;
    if (!row) return undefined;
    return { ...summaryFromRow(row), messages: this.listMessages(id, messageLimit), chatMetadata: JSON.parse(row.metadata_json) as Record<string, unknown>, chatHeader: JSON.parse(row.header_json) as Record<string, unknown> };
  }

  /** Merge only invocation-owned WI metadata inside the accepting savepoint.
   * Revision covers both public timedWorldInfo and private prefix checkpoints. */
  commitWorldInfoState(id: string, branchId: string, before: string, next: Record<string, unknown>, sources: string[]): void {
    // 单行读取代整段历史：分支归属与元数据修订校验只需要这两列。
    const row = this.database.prepare("SELECT active_branch_id, metadata_json FROM conversations WHERE id = ?")
      .get(id) as { active_branch_id: string; metadata_json: string } | undefined;
    if (!row || row.active_branch_id !== branchId) throw new MacroVariableConflictError("世界书上下文");
    // 前缀校验只需要前 sources.length 条消息的散列，长故事不再为此全量反序列化。
    const prefix = sources.length
      ? (this.database.prepare(`
          SELECT id, role, content, extension_data_json FROM messages
          WHERE conversation_id = ? AND branch_id = ? ORDER BY rowid ASC LIMIT ?
        `).all(id, branchId, sources.length) as unknown as Array<{ id: string; role: string; content: string; extension_data_json: string }>)
        .map(entry => ({ id: entry.id, role: entry.role, content: entry.content,
          extensionData: JSON.parse(entry.extension_data_json) as ChatMessage["extensionData"] }) as ChatMessage)
      : [];
    if (!worldInfoSourcesMatch(sources, prefix)) throw new MacroVariableConflictError("世界书上下文");
    const currentMetadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    if (worldInfoStateRevision(currentMetadata ?? {}) !== before) throw new MacroVariableConflictError("世界书计时状态");
    const metadata = { ...currentMetadata, timedWorldInfo: structuredClone(next.timedWorldInfo),
      [WORLD_INFO_STATE_KEY]: structuredClone(next[WORLD_INFO_STATE_KEY]) };
    this.database.prepare("UPDATE conversations SET metadata_json = ? WHERE id = ?").run(JSON.stringify(metadata), id);
  }

  /** 宏变量冲突检测只需要元数据：单行读取，不加载历史。 */
  getChatMetadata(conversationId: string): Record<string, unknown> | undefined {
    const row = this.database.prepare("SELECT metadata_json FROM conversations WHERE id = ?")
      .get(conversationId) as { metadata_json: string } | undefined;
    return row ? JSON.parse(row.metadata_json) as Record<string, unknown> : undefined;
  }

  /** 只读当前激活分支 id：给只需要分支归属、不需要消息历史的调用方。 */
  getActiveBranchId(conversationId: string): string | undefined {
    return this.activeBranchId(conversationId);
  }

  // 只返回当前激活分支的消息，按发生顺序（parent_message_id 链接的链）排序。
  // limit 仅用于给模型上下文取最近 N 条（UI 展示用完整列表，limit 传 undefined）。
  listMessages(conversationId: string, limit?: number): ChatMessage[] {
    const rows = limit === undefined
      ? this.database.prepare(`
          SELECT messages.*, rowid AS message_sequence FROM messages
          WHERE conversation_id = ? AND branch_id = (SELECT active_branch_id FROM conversations WHERE id = ?)
          ORDER BY rowid ASC
        `).all(conversationId, conversationId)
      : this.database.prepare(`
          SELECT * FROM (
            SELECT messages.*, rowid AS message_sequence FROM messages
            WHERE conversation_id = ? AND branch_id = (SELECT active_branch_id FROM conversations WHERE id = ?)
            ORDER BY rowid DESC LIMIT ?
          ) ORDER BY message_sequence ASC
        `).all(conversationId, conversationId, limit);
    return (rows as unknown as MessageRow[]).map(messageFromRow);
  }

  addMessage(
    conversationId: string,
    role: ChatMessage["role"],
    content: string,
    status: ChatMessage["status"] = "complete",
  ): ChatMessage {
    const branchId = this.activeBranchId(conversationId) ?? conversationId;
    // parent 为当前分支最后一条消息，维护消息链。
    const parentRow = this.database.prepare(`
      SELECT id FROM messages WHERE conversation_id = ? AND branch_id = ?
      ORDER BY rowid DESC LIMIT 1
    `).get(conversationId, branchId) as { id: string } | undefined;
    const message: ChatMessage = {
      id: randomUUID(),
      conversationId,
      branchId,
      parentMessageId: parentRow?.id ?? null,
      role,
      content,
      status,
      createdAt: new Date().toISOString(),
    };
    this.withTransaction(() => {
      this.database.prepare(`
        INSERT INTO messages (
          id, conversation_id, branch_id, parent_message_id, role, content, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        message.id,
        message.conversationId,
        message.branchId,
        message.parentMessageId,
        message.role,
        message.content,
        message.status,
        message.createdAt,
      );
      this.database.prepare("UPDATE conversations SET updated_at = ?, metadata_json = json_set(metadata_json, '$.tainted', json('true')) WHERE id = ?")
        .run(message.createdAt, conversationId);
    });
    return message;
  }

  // 流式生成的助手消息先以 'streaming' 落库（内容为空），结束/停止/失败时再定稿。
  createAssistantMessage(conversationId: string): ChatMessage {
    return this.addMessage(conversationId, "assistant", "", "streaming");
  }

  // Accept a continuation only after preflight. A changed branch/tail must not
  // turn a stale model request into an overwrite of an edited message.
  prepareContinueMessage(conversationId: string, expected: ChatMessage): ChatMessage {
    const current = this.getConversation(conversationId);
    const tail = current?.messages.at(-1);
    if (!tail || current?.activeBranchId !== expected.branchId || tail.id !== expected.id
      || tail.role !== "assistant" || tail.content !== expected.content || tail.status === "streaming") {
      throw new Error("续写期间末尾消息已改变，请重新打开消息后重试。");
    }
    this.database.prepare("UPDATE messages SET status = 'streaming' WHERE id = ? AND conversation_id = ? AND branch_id = ?")
      .run(tail.id, conversationId, tail.branchId);
    return { ...tail, status: "streaming" };
  }

  finalizeContinuedMessage(message: ChatMessage, status: "complete" | "stopped" | "failed", content: string,
    generation?: MessageGenerationMetadata): ChatMessage {
    return this.withTransaction(() => {
      const finalized = this.finalizeAssistantMessage(message, status, content, generation);
      this.syncMemoryReachability(message.conversationId);
      const extensionData = structuredClone(finalized.extensionData ?? {});
      const swipes = extensionData.swipes;
      const selected = extensionData.swipe_id;
      if (Array.isArray(swipes) && Number.isInteger(selected) && Number(selected) >= 0 && Number(selected) < swipes.length) {
        swipes[Number(selected)] = content;
        this.database.prepare("UPDATE messages SET extension_data_json = ? WHERE id = ? AND conversation_id = ? AND branch_id = ?")
          .run(JSON.stringify(extensionData), message.id, message.conversationId, message.branchId);
        return { ...finalized, extensionData };
      }
      return finalized;
    });
  }

  finalizeAssistantMessage(
    message: ChatMessage,
    status: "complete" | "stopped" | "failed",
    content: string,
    generation?: MessageGenerationMetadata,
    candidates?: ModelCandidateSnapshot[],
  ): ChatMessage {
    const finalized: ChatMessage = {
      ...message,
      status,
      content,
      ...(generation ? { generationMetadata: generation } : {}),
    };
    if(candidates?.length&&finalized.generationMetadata)
      finalized.generationMetadata={...finalized.generationMetadata,nativeCandidates:true};
    this.withTransaction(() => {
      // An extension can save variables/unknown fields while the provider runs.
      // Merge candidate-owned fields into the latest row inside this transaction.
      const latest=this.getMessage(message.conversationId,message.id,message.branchId)??message;
      const extensionData=structuredClone(latest.extensionData??{});
      if(candidates?.length){
        const record=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};
        const extra=record(extensionData.extra),oldInfos=Array.isArray(extensionData.swipe_info)?extensionData.swipe_info:[];
        const ordered=[...candidates].sort((a,b)=>a.index-b.index);
        const candidateContent=(candidate:ModelCandidateSnapshot)=>candidate.index===0&&status!=="failed"?content:candidate.content;
        extensionData.swipes=ordered.map(candidateContent);
        extensionData.swipe_id=ordered.findIndex(candidate=>candidate.index===0);
        extensionData.swipe_info=ordered.map(candidate=>{
          const old=record(oldInfos.find(info=>record(record(record(info).extra)[NATIVE_CANDIDATE_INFO_KEY]).index===candidate.index));
          const reason=candidate.finishReason??"eof",outcome=reason==="length"?"truncated":["stop","done","response"].includes(reason)?"complete":"incomplete";
          const candidateStatus=status!=="complete"?status:outcome==="incomplete"?"failed":"complete";
          const oldExtra=structuredClone(record(old.extra)),latestExtra=structuredClone(extra);
          const candidateExtra={...(candidate.index===0?{...oldExtra,...latestExtra}:{...latestExtra,...oldExtra}),[NATIVE_CANDIDATE_INFO_KEY]:{
            version:1,index:candidate.index,originalContent:candidateContent(candidate),status:candidateStatus,
            finishReason:reason,completionOutcome:outcome,responseState:structuredClone(candidate.responseState),
          }};
          return {...old,send_date:old.send_date??message.createdAt,extra:candidateExtra};
        });
        const selected=extensionData.swipe_id as number;
        if(selected>=0)extensionData.extra=structuredClone(record((extensionData.swipe_info as Record<string,unknown>[])[selected]).extra);
      }
      const projected=projectNativeCandidateMessage({...finalized,extensionData});
      this.database.prepare(`
        UPDATE messages SET status = ?, content = ?, generation_json = ?, extension_data_json = ? WHERE id = ? AND conversation_id = ? AND branch_id = ?
      `).run(projected.status, content, projected.generationMetadata ? JSON.stringify(projected.generationMetadata) : null, JSON.stringify(extensionData), message.id, message.conversationId, message.branchId);
      this.database.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), message.conversationId);
    });
    return this.getMessage(message.conversationId, message.id, message.branchId) ?? finalized;
  }

  // Fork at the edit point. Unchanged prefix IDs remain valid sources; the edited
  // message receives a new ID, and descendants stay accessible on the old branch.
  editMessage(conversationId: string, messageId: string, content: string): ChatMessage | undefined {
    const current = this.getConversation(conversationId);
    if (!current) return undefined;
    const index = current.messages.findIndex(message => message.id === messageId);
    const existing = current.messages[index];
    if (!existing) return undefined;
    if (existing.content === content) return existing;
    const branchId = randomUUID();
    const { generationMetadata: _generation, ...manual } = existing;
    const edited: ChatMessage = { ...manual, id: randomUUID(), branchId, content, status: "complete",
      parentMessageId: current.messages[index - 1]?.id ?? null };
    this.database.exec("SAVEPOINT edit_message_branch");
    try {
      const insert = this.database.prepare(`INSERT INTO messages
        (id, conversation_id, branch_id, parent_message_id, role, content, status, generation_json, extension_data_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const message of [...current.messages.slice(0, index), edited]) {
        insert.run(message.id, conversationId, branchId, message.parentMessageId, message.role, message.content, message.status,
          message.generationMetadata ? JSON.stringify(message.generationMetadata) : null, JSON.stringify(message.extensionData ?? {}), message.createdAt);
      }
      this.#inheritSummary(conversationId, current.activeBranchId, branchId, current.messages.slice(0, index));
      this.database.prepare("UPDATE conversations SET active_branch_id = ?, updated_at = ?, metadata_json = json_set(metadata_json, '$.tainted', json('true')) WHERE id = ?")
        .run(branchId, new Date().toISOString(), conversationId);
      this.syncMemoryReachability(conversationId);
      this.#restoreBranchWorldInfo(conversationId,current);
      this.database.exec("RELEASE SAVEPOINT edit_message_branch");
    } catch (error) {
      this.database.exec("ROLLBACK TO SAVEPOINT edit_message_branch; RELEASE SAVEPOINT edit_message_branch");
      throw error;
    }
    return edited;
  }

  // 选择候选回复（FR-CHAT）：swipe_id/内容/扩展数据/投影的服务端原子更新。
  // 语义与投影逻辑保持一致：原候选保留当前展示状态，新候选继承自己的 extra。
  selectMessageSwipe(conversationId: string, message: ChatMessage, swipeId: number, contentOverride?: string): ChatMessage {
    if (message.role !== "assistant" || message.status === "streaming") throw new SwipeSelectionError("此消息暂时不能切换候选回复。");
    const extensionData = structuredClone(message.extensionData ?? {});
    const swipes = extensionData.swipes;
    if (!Number.isInteger(swipeId) || !Array.isArray(swipes) || typeof swipes[swipeId] !== "string")
      throw new SwipeSelectionError("候选回复已改变，请重新选择。");
    const old = typeof extensionData.swipe_id === "number" ? extensionData.swipe_id : 0;
    if (old === swipeId) return message;
    const record = (value: unknown): Record<string, unknown> =>
      value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const infos = (Array.isArray(extensionData.swipe_info) ? extensionData.swipe_info : swipes.map(() => ({ send_date: message.createdAt, extra: {} }))) as Record<string, unknown>[];
    const conversation = this.getConversation(conversationId);
    if (typeof swipes[old] === "string") {
      if (conversation?.chatMetadata?.tainted || (conversation?.messages.length ?? 0) > 1) swipes[old] = message.content;
      const oldExtra = record(record(infos[old]).extra), currentExtra = record(structuredClone(extensionData.extra ?? {}));
      // Native host provenance remains attached to its own candidate.
      if (Object.hasOwn(oldExtra, NATIVE_CANDIDATE_INFO_KEY) && !Object.hasOwn(currentExtra, NATIVE_CANDIDATE_INFO_KEY))
        currentExtra[NATIVE_CANDIDATE_INFO_KEY] = structuredClone(oldExtra[NATIVE_CANDIDATE_INFO_KEY]);
      infos[old] = { ...record(infos[old]), send_date: extensionData.send_date ?? message.createdAt,
        gen_started: extensionData.gen_started, gen_finished: extensionData.gen_finished, extra: currentExtra };
    }
    const info = record(infos[swipeId]);
    // 调用方按需转换过候选内容时（输出正则），把转换结果写回该候选槽，
    // 避免只改消息正文、候选列表里仍留着未转换的原文。
    if (typeof contentOverride === "string" && contentOverride) swipes[swipeId] = contentOverride;
    extensionData.swipe_info = infos;
    extensionData.swipe_id = swipeId;
    extensionData.send_date = info.send_date;
    extensionData.gen_started = info.gen_started;
    extensionData.gen_finished = info.gen_finished;
    extensionData.extra = structuredClone(info.extra ?? {});
    let next: ChatMessage = { ...message, content: swipes[swipeId] as string, extensionData };
    const generation = messageGenerationMetadataSchema.safeParse(message.generationMetadata);
    if (generation.success) {
      const projected = projectNativeCandidateMessage({ content: next.content, status: message.status,
        generationMetadata: generation.data, extensionData });
      next = { ...next, status: projected.status,
        ...(projected.generationMetadata ? { generationMetadata: projected.generationMetadata } : {}) };
    }
    this.withTransaction(() => {
      this.database.prepare(`UPDATE messages SET content = ?, status = ?, generation_json = ?, extension_data_json = ?
        WHERE id = ? AND conversation_id = ? AND branch_id = ?`).run(
        next.content, next.status, next.generationMetadata ? JSON.stringify(next.generationMetadata) : null,
        JSON.stringify(extensionData), message.id, message.conversationId, message.branchId);
      this.database.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), conversationId);
      this.syncMemoryReachability(conversationId);
    });
    return this.getMessage(conversationId, message.id, message.branchId) ?? next;
  }

  // 删除当前分支中的一条消息。
  deleteMessage(conversationId: string, messageId: string): boolean {
    const branchId = this.activeBranchId(conversationId);
    if (!branchId) return false;
    const result = this.database.prepare(`
      DELETE FROM messages WHERE id = ? AND conversation_id = ? AND branch_id = ?
    `).run(messageId, conversationId, branchId);
    if (result.changes > 0) {
      this.database.prepare("UPDATE conversations SET updated_at = ?, metadata_json = json_set(metadata_json, '$.tainted', json('true')) WHERE id = ?")
        .run(new Date().toISOString(), conversationId);
      this.syncMemoryReachability(conversationId);
    }
    return result.changes > 0;
  }

  getMessage(conversationId: string, messageId: string, branchId: string): ChatMessage | undefined {
    const row = this.database.prepare(`
      SELECT * FROM messages WHERE id = ? AND conversation_id = ? AND branch_id = ?
    `).get(messageId, conversationId, branchId) as MessageRow | undefined;
    return row ? messageFromRow(row) : undefined;
  }

  /**
   * 重新生成最后一条助手回复：在“最后一个用户消息”处分叉出新的故事分支，
   * 把分叉点（最后一个用户消息，含）之前的消息复制到新分支，并切换
   * active_branch_id。原分支保持可访问。
   *
   * 调用方随后对新分支发起流式生成，新助手回复的 parent 即该用户消息。
   * 要求当前分支最后一条消息是助手回复（否则没有可重新生成的回复）。
   */
  prepareRegenerateLastAssistant(conversationId: string): {
    newBranchId: string;
    anchorUserId: string;
    createdBranch: boolean;
  } | undefined {
    const current = this.getConversation(conversationId);
    if (!current) return undefined;
    const last = current.messages.at(-1);
    if (!last || last.role !== "assistant") return undefined;
    const anchor = [...current.messages].reverse().find((message) => message.role === "user");
    if (!anchor) return undefined;

    const newBranchId = randomUUID();
    const timestamp = new Date().toISOString();

    this.withTransaction(() => {
      const anchorRow = this.database.prepare(`
        SELECT rowid FROM messages WHERE id = ? AND conversation_id = ? AND branch_id = ?
      `).get(anchor.id, conversationId, current.activeBranchId) as { rowid: number } | undefined;
      if (anchorRow) {
        this.database.prepare(`
          INSERT INTO messages (
            id, conversation_id, branch_id, parent_message_id, role, content, status, generation_json, extension_data_json, created_at
          )
          SELECT id, conversation_id, ?, parent_message_id, role, content, status, generation_json, extension_data_json, created_at
          FROM messages
          WHERE conversation_id = ? AND branch_id = ? AND rowid <= ?
          ORDER BY rowid ASC
        `).run(newBranchId, conversationId, current.activeBranchId, anchorRow.rowid);
      }
      this.database.prepare(`
        UPDATE conversations SET active_branch_id = ?, updated_at = ? WHERE id = ?
      `).run(newBranchId, timestamp, conversationId);
      this.#inheritSummary(conversationId, current.activeBranchId, newBranchId,
        current.messages.slice(0, current.messages.findIndex(message => message.id === anchor.id) + 1));
      this.syncMemoryReachability(conversationId);
    });
    return { newBranchId, anchorUserId: anchor.id, createdBranch: true };
  }

  // 切换当前分支到指定分支 ID（若分支中尚无消息则不切换）。
  activateBranch(conversationId: string, branchId: string): ConversationDetail | undefined {
    const countRow = this.database.prepare(`
      SELECT count(*) AS n FROM messages WHERE conversation_id = ? AND branch_id = ?
    `).get(conversationId, branchId) as { n: number } | undefined;
    if (!countRow || countRow.n === 0) return undefined;
    const previous=this.getConversation(conversationId);
    this.withTransaction(()=>{
      this.database.prepare(`
      UPDATE conversations SET active_branch_id = ?, updated_at = ? WHERE id = ?
    `).run(branchId, new Date().toISOString(), conversationId);
      this.syncMemoryReachability(conversationId);
      this.#restoreBranchWorldInfo(conversationId,previous);
    });
    return this.getConversation(conversationId);
  }

  #restoreBranchWorldInfo(conversationId:string,previous?:ConversationDetail):void {
    const current=this.getConversation(conversationId);if(!current)return;
    const restored=restoreWorldInfoStateForBranch(current.chatMetadata??{},current.activeBranchId,current.messages,
      previous?{branchId:previous.activeBranchId,messages:previous.messages}:undefined);
    if(restored)this.database.prepare("UPDATE conversations SET metadata_json = ? WHERE id = ?")
      .run(JSON.stringify({...current.chatMetadata,...restored}),conversationId);
  }
}
