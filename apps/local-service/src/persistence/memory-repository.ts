import type { DatabaseSync } from "node:sqlite";
import type { ChatMessage, MemoryRecord, MemoryScope, MemoryStatus, MemoryType } from "@mycompanion/shared";
import { classifyMemoryRelation, isCompleteSourceQuote, isProtectedMemory, quoteDirectlyNamesClaim, quoteProvesTransition } from "../memory/memory-conflict-core.js";
import { memoryFromRow, type MemoryRow } from "./memory-row.js";
import { messageFromRow, type MessageRow } from "./message-row.js";
import { activeBranchId } from "./conversation-row.js";
import { messageFingerprint, summaryMessages } from "./message-fingerprint.js";

/**
 * 长期记忆域（FR-MEM-001/002/003/004/007/008）：事件/事实、故事状态、目标、关系记忆的
 * 读写、可见性、取代链与分支回滚可达性。事务经注入的 withTransaction 与调用方共享同一个
 * SAVEPOINT 实现，保证跨域原子性不被破坏。
 */
export class MemoryRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly withTransaction: <T>(work: () => T) => T,
    private readonly listMessages: (conversationId: string, limit?: number) => ChatMessage[],
  ) {}

  // 当前分支可达的消息 ID 集合（FR-MEM-008 分支回滚判定用）。
  listReachableMessageIds(conversationId: string): Set<string> {
    const branchId = activeBranchId(this.database, conversationId);
    if (!branchId) return new Set();
    const rows = this.database.prepare(
      "SELECT id FROM messages WHERE conversation_id = ? AND branch_id = ?",
    ).all(conversationId, branchId) as Array<{ id: string }>;
    return new Set(rows.map((row) => row.id));
  }

  listMemories(
    conversationId: string,
    filters: { scope?: MemoryScope | undefined; type?: MemoryType | undefined; status?: MemoryStatus | undefined } = {},
  ): MemoryRecord[] {
    // 可见性：本故事线的记忆 + 本角色共享 + 用户全局。
    const clauses: string[] = [this.#memoryVisibilitySql];
    const params: Array<string | number> = [conversationId, conversationId, conversationId];
    if (filters.scope) {
      clauses.push("scope = ?");
      params.push(filters.scope);
    }
    if (filters.type) {
      clauses.push("type = ?");
      params.push(filters.type);
    }
    if (filters.status) {
      clauses.push("status = ?");
      params.push(filters.status);
    }
    const rows = this.database.prepare(`
      SELECT * FROM memories WHERE ${clauses.join(" AND ")} ORDER BY importance DESC, created_at DESC
    `).all(...params) as unknown as MemoryRow[];
    return rows.map((row) => memoryFromRow(row));
  }

  getMemory(memoryId: string): MemoryRecord | undefined {
    const row = this.database.prepare("SELECT * FROM memories WHERE id = ?")
      .get(memoryId) as MemoryRow | undefined;
    return row ? memoryFromRow(row) : undefined;
  }

  /**
   * 记忆库（跨故事清单）：每条记忆只出现一次，附归属故事，供「记忆」一级页面使用。
   * 归属优先保留出处：记忆自己所在的故事仍然可见时就用它（哪怕是用户事后改成角色级/
   * 全局的记忆，也不该被改挂到别的故事上）。只有原故事已被软删除时，才回退到该角色
   * 最近更新的故事，避免把记忆挂在用户看不到的故事名下。
   */
  listMemoryInventory(
    filters: { scope?: MemoryScope | undefined; type?: MemoryType | undefined; status?: MemoryStatus | undefined } = {},
  ): Array<{ memory: MemoryRecord; conversationId: string; conversationTitle: string }> {
    // 只列出**来源故事仍然活跃**的记忆。已删故事的故事级记忆在任何故事里都不可见
    // （可见性要求 conversation_id 匹配），列出来只会让人以为能改，点下去却 404。
    const clauses: string[] = [
      // 来源故事仍活跃 → 照常列出。
      // 用户级记忆例外：它跨故事共享、仍在参与检索，来源故事删了也必须能管理。
      // 其余（story/character）来源已删则隐藏——它们在任何故事里都已不可见。
      "(EXISTS (SELECT 1 FROM conversations c WHERE c.id = m.conversation_id AND c.deleted_at IS NULL) OR m.scope = 'user')",
    ];
    const params: string[] = [];
    if (filters.scope) { clauses.push("m.scope = ?"); params.push(filters.scope); }
    if (filters.type) { clauses.push("m.type = ?"); params.push(filters.type); }
    if (filters.status) { clauses.push("m.status = ?"); params.push(filters.status); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database.prepare(`
      SELECT m.*,
        COALESCE(
          NULLIF((SELECT c.id FROM conversations c WHERE c.id = m.conversation_id AND c.deleted_at IS NULL), ''),
          NULLIF((SELECT c.id FROM conversations c
            WHERE c.character_id = m.character_id AND c.deleted_at IS NULL
            ORDER BY c.updated_at DESC, c.id DESC LIMIT 1), '')
        ) AS owner_conversation_id
      FROM memories m ${where}
      ORDER BY m.importance DESC, m.created_at DESC
    `).all(...params) as unknown as Array<MemoryRow & { owner_conversation_id: string | null }>;

    const titles = new Map(
      (this.database.prepare("SELECT id, title FROM conversations WHERE deleted_at IS NULL").all() as Array<{ id: string; title: string }>)
        .map((row) => [row.id, row.title]),
    );
    const items: Array<{ memory: MemoryRecord; conversationId: string; conversationTitle: string }> = [];
    for (const row of rows) {
      const owner = row.owner_conversation_id ?? row.conversation_id;
      // 用户级记忆若连归属故事都找不到（该角色的故事全删了），就无处可管理，不列出。
      if (row.scope === "user" && !titles.has(owner)) continue;
      items.push({ memory: memoryFromRow(row), conversationId: owner, conversationTitle: titles.get(owner) ?? "" });
    }
    return items;
  }

  // 记忆可见性：每次开档独立。一个对话就是一次新的游戏，同一张角色卡的另一局
  // 不能看到这一局发生过什么，所以角色级不再跨对话注入（只认 story + user）。
  // 但它仍对**自己所在的那一局**可见：否则收窄规则之前产生的角色级记忆会彻底消失，
  // 用户在记忆面板里既看不到、也改不了删不掉（改删会 404）。
  //
  // 用户级记忆单独对待：它描述的是**玩家本人**（跨故事共享），与来源故事是否还存在无关。
  // 若跟着来源故事一起被隐藏，就会出现"仍在参与检索、却在记忆库里看不到也管不了"的
  // 幽灵状态——这正是要避免的。
  //
  // 三个参数依次是：当前对话（须存在且未删除）、story 来源、character 来源。
  // user 作用域不做来源校验：那条 conversation_id 只是"从哪一局产生的"记录，
  // 玩家偏好不因某一局被删而失效（也正因为它仍在参与检索，必须保持可管理）。
  readonly #memoryVisibilitySql = `EXISTS (SELECT 1 FROM conversations WHERE id = ? AND deleted_at IS NULL)
    AND ((scope = 'story' AND conversation_id = ?)
      OR (scope = 'character' AND conversation_id = ?)
      OR scope = 'user')`;

  getMemoryForConversation(memoryId: string, conversationId: string): MemoryRecord | undefined {
    const row = this.database.prepare(`SELECT * FROM memories WHERE id = ? AND ${this.#memoryVisibilitySql}`)
      .get(memoryId, conversationId, conversationId, conversationId) as MemoryRow | undefined;
    return row ? memoryFromRow(row) : undefined;
  }

  addMemory(record: MemoryRecord): MemoryRecord {
    const sources = this.listMessages(record.conversationId).filter(message => record.sourceMessageIds.includes(message.id));
    const fingerprints = record.sourceMessageFingerprints ?? Object.fromEntries(sources.map(message => [message.id, messageFingerprint(message)]));
    this.database.prepare(`
      INSERT INTO memories (
        id, conversation_id, character_id, type, content, scope, importance,
        status, pinned, source_message_ids_json, source_message_fingerprints_json, superseded_by, previous_content,
        created_at, last_used_at, provenance_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      JSON.stringify(fingerprints),
      record.supersededBy,
      record.previousContent,
      record.createdAt,
      record.lastUsedAt,
      JSON.stringify({ manuallyEdited: record.manuallyEdited ?? (record.previousContent !== null || record.sourceMessageIds.length === 0),
        ...(record.claim ? { claim: record.claim } : {}), ...(record.reconciliation ? { reconciliation: record.reconciliation } : {}) }),
    );
    return { ...record, sourceMessageFingerprints: fingerprints };
  }

  /**
   * 更新记忆（FR-MEM-007）：修改内容时保留旧内容用于“恢复上一版本”；
   * 提升到角色共享/用户全局必须由用户明确操作（FR-MEM-003）。
   */
  updateMemory(
    memoryId: string,
    patch: {
      content?: string | undefined;
      scope?: MemoryScope | undefined;
      pinned?: boolean | undefined;
      status?: "active" | "disabled" | "pending" | undefined;
      importance?: number | undefined;
    },
  ): MemoryRecord | undefined {
    const existing = this.getMemory(memoryId);
    if (!existing) return undefined;
    const nextContent = patch.content ?? existing.content;
    return this.withTransaction(() => {
      if (patch.status === "active" && existing.status === "superseded") this.#pendReplacementChain(existing);
      if (patch.status === "active" && existing.status === "pending") {
        for (const relatedId of existing.reconciliation?.relatedMemoryIds ?? []) {
          const related = this.getMemory(relatedId);
          if (related && related.id !== existing.id && related.status === "active"
            && this.getMemoryForConversation(related.id, existing.conversationId)) {
            this.database.prepare("UPDATE memories SET status = 'superseded', superseded_by = ? WHERE id = ?")
              .run(existing.id, related.id);
          }
        }
      }
      const provenance = { manuallyEdited: existing.manuallyEdited === true || nextContent !== existing.content
        || patch.scope !== undefined || patch.status === "active",
        // This remains original extraction evidence. manuallyEdited prevents treating
        // its old structured value as the semantics of the edited text.
        ...(existing.claim ? { claim: existing.claim } : {}),
        ...(existing.reconciliation ? { reconciliation: existing.reconciliation } : {}) };
      this.database.prepare(`
      UPDATE memories SET
        content = ?, scope = ?, pinned = ?, status = ?, importance = ?, previous_content = ?, provenance_json = ?,
        superseded_by = ?
      WHERE id = ?
    `).run(
      nextContent,
      patch.scope ?? existing.scope,
      (patch.pinned ?? existing.pinned) ? 1 : 0,
      patch.status ?? existing.status,
      patch.importance ?? existing.importance,
      nextContent !== existing.content ? existing.content : existing.previousContent,
      JSON.stringify(provenance),
      patch.status === "active" ? null : existing.supersededBy,
      memoryId,
    );
      return this.getMemory(memoryId);
    });
  }

  #pendReplacementChain(existing: MemoryRecord): void {
    const visited = new Set([existing.id]);
    let replacementId = existing.supersededBy;
    while (replacementId && !visited.has(replacementId)) {
      visited.add(replacementId);
      const replacement = this.getMemory(replacementId);
      if (!replacement || replacement.conversationId !== existing.conversationId) break;
      if (replacement.status === "active" || replacement.status === "orphaned" || replacement.status === "superseded") {
        this.database.prepare("UPDATE memories SET status = 'pending' WHERE id = ?").run(replacement.id);
      }
      replacementId = replacement.supersededBy;
    }
  }

  restoreMemory(memoryId: string, mode?: "supersession" | "previous_content"): MemoryRecord | undefined {
    const existing = this.getMemory(memoryId);
    if (!existing) return undefined;
    const selected = mode ?? (existing.status === "superseded" ? "supersession" : "previous_content");
    if (selected === "supersession" ? existing.status !== "superseded" : existing.previousContent === null) return existing;
    return this.withTransaction(() => {
      if (selected === "supersession") this.#pendReplacementChain(existing);
      this.database.prepare(`UPDATE memories SET content = ?, previous_content = ?, provenance_json = ?,
        status = ?, superseded_by = ? WHERE id = ?`).run(selected === "previous_content" ? existing.previousContent! : existing.content,
        selected === "previous_content" ? null : existing.previousContent,
        JSON.stringify({ manuallyEdited: true,
          ...(existing.claim ? { claim: existing.claim } : {}),
          ...(existing.reconciliation ? { reconciliation: existing.reconciliation } : {}) }),
        selected === "supersession" ? "active" : existing.status,
        selected === "supersession" ? null : existing.supersededBy, existing.id);
      this.syncMemoryReachability(existing.conversationId);
      return this.getMemory(memoryId);
    });
  }

  deleteMemory(memoryId: string): boolean {
    return this.database.prepare("DELETE FROM memories WHERE id = ?").run(memoryId).changes > 0;
  }

  /**
   * FR-MEM-004: overlap never authorizes replacement. The caller must compose this
   * decision and addMemory inside one transaction so links never point to a failed insert.
   */
  recordSupersession(newMemory: MemoryRecord): string[] {
    if (newMemory.status !== "active" || isProtectedMemory(newMemory)) return [];
    const messages = this.listMessages(newMemory.conversationId);
    const index = new Map(messages.map((message, position) => [message.id, position]));
    const source = newMemory.claim?.transition;
    const sourceMessage = source ? messages.find(message => message.id === source.sourceMessageId) : undefined;
    const verifiedTransition = Boolean(source && sourceMessage && newMemory.sourceMessageIds.includes(sourceMessage.id)
      && isCompleteSourceQuote(sourceMessage.content, source.quote)
      && quoteDirectlyNamesClaim(source.quote, newMemory.claim!, sourceMessage.role)
      && quoteProvesTransition(source.quote, source.from, newMemory.claim!.value));
    const relations = this.listMemories(newMemory.conversationId)
      .filter(candidate => candidate.status === "active" && candidate.id !== newMemory.id)
      .map(candidate => {
        const laterSources = candidate.sourceMessageIds.length > 0 && newMemory.sourceMessageIds.length > 0
          && candidate.sourceMessageIds.every(id => index.has(id)) && newMemory.sourceMessageIds.every(id => index.has(id))
          && Math.max(...candidate.sourceMessageIds.map(id => index.get(id)!)) < Math.min(...newMemory.sourceMessageIds.map(id => index.get(id)!));
        return { candidate, relation: classifyMemoryRelation(candidate, newMemory, { laterSources,
          verifiedTransition: verifiedTransition && source?.from === candidate.claim?.value }) };
      }).filter(item => item.relation.kind !== "unrelated");
    if (relations.length === 0) return [];
    const pending = relations.some(item => item.relation.action !== "supersede");
    const primary = relations.find(item => item.relation.kind === "conflict")
      ?? relations.find(item => item.relation.action === "pending") ?? relations[0]!;
    newMemory.reconciliation = { kind: primary.relation.kind, relatedMemoryIds: relations.map(item => item.candidate.id),
      reason: relations.map(item => `${item.candidate.id}: ${item.relation.reason}`).join("\n").slice(0, 2_000) };
    if (pending) { newMemory.status = "pending"; return []; }
    const affected = relations.map(item => item.candidate.id);
    for (const candidateId of affected) {
      this.database.prepare(`
        UPDATE memories SET status = 'superseded', superseded_by = ? WHERE id = ?
      `).run(newMemory.id, candidateId);
    }
    return affected;
  }

  /** 标记本轮注入的记忆（FR-MEM-002 最后使用时间）。 */
  markMemoriesUsed(memoryIds: string[]): void {
    if (memoryIds.length === 0) return;
    const statement = this.database.prepare(
      "UPDATE memories SET last_used_at = ? WHERE id = ?",
    );
    const now = new Date().toISOString();
    for (const id of memoryIds) statement.run(now, id);
  }

  /**
   * FR-MEM-008 分支回滚：来源消息全部不再可达的 active 记忆转 orphaned；
   * 已 orphaned 的记忆如果来源重新可达（回到原分支）则恢复 active。
   */
  syncMemoryReachability(conversationId: string): void {
    const rows = this.database.prepare(
      "SELECT * FROM memories WHERE conversation_id = ?",
    ).all(conversationId) as unknown as MemoryRow[];
    if (!rows.length) return;
    // 只加载被记忆引用的消息，而不是整段历史：可达性判断只需要这些 id 的指纹。
    // 长故事里这把「全量反序列化 + 全量 sha256」降成与被引用消息数成正比。
    const referencedIds = [...new Set(rows.flatMap(row => JSON.parse(row.source_message_ids_json) as string[]))];
    const reachable = new Map<string, string>();
    // 分块防止超出 SQLite 变量上限。
    for (let offset = 0; offset < referencedIds.length; offset += 500) {
      const chunk = referencedIds.slice(offset, offset + 500);
      const referenced = this.database.prepare(`
        SELECT messages.*, rowid AS message_sequence FROM messages
        WHERE conversation_id = ? AND branch_id = (SELECT active_branch_id FROM conversations WHERE id = ?)
          AND id IN (${chunk.map(() => "?").join(",")})
      `).all(conversationId, conversationId, ...chunk) as unknown as MessageRow[];
      for (const row of referenced) {
        const message = messageFromRow(row);
        reachable.set(message.id, messageFingerprint(message));
      }
    }
    const records = new Map(rows.map(row => [row.id, memoryFromRow(row)]));
    const sourceIsReachable = (memory: MemoryRecord) => memory.sourceMessageIds.length > 0
      && memory.sourceMessageIds.every(id => reachable.has(id)
        && (!memory.sourceMessageFingerprints?.[id] || memory.sourceMessageFingerprints[id] === reachable.get(id)));
    const hasApplicableReplacement = (memory: MemoryRecord, visited = new Set<string>()): boolean => {
      if (!memory.supersededBy || visited.has(memory.id)) return false;
      visited.add(memory.id);
      const replacement = records.get(memory.supersededBy);
      if (!replacement || replacement.status === "disabled" || replacement.status === "pending") return false;
      return sourceIsReachable(replacement) || hasApplicableReplacement(replacement, visited);
    };
    for (const row of rows) {
      const sources = JSON.parse(row.source_message_ids_json) as string[];
      const fingerprints = JSON.parse(row.source_message_fingerprints_json) as Record<string, string>;
      const allReachable = sources.length > 0 && sources.every(id => reachable.has(id)
        && (!fingerprints[id] || fingerprints[id] === reachable.get(id)));
      const record = records.get(row.id)!;
      if (record.supersededBy && !isProtectedMemory(record)
        && (row.status === "active" || row.status === "orphaned" || row.status === "superseded")) {
        const nextStatus = hasApplicableReplacement(record) ? "superseded" : allReachable ? "active" : "orphaned";
        if (nextStatus !== row.status) this.database.prepare("UPDATE memories SET status = ? WHERE id = ?").run(nextStatus, row.id);
        continue;
      }
      if (row.status === "orphaned" && allReachable) {
        this.database.prepare(`
          UPDATE memories SET status = 'active' WHERE id = ?
        `).run(row.id);
      } else if (row.status === "active" && sources.length > 0 && !allReachable) {
        this.database.prepare(`
          UPDATE memories SET status = 'orphaned' WHERE id = ?
        `).run(row.id);
      }
    }
  }

  /** Async derivation may finish after edit/switch; verify captured sources before saving. */
  isMessageSnapshotCurrent(conversationId: string, branchId: string, sources: ChatMessage[], prefix = false): boolean {
    if (activeBranchId(this.database, conversationId) !== branchId) return false;
    if (prefix) {
      const current = this.listMessages(conversationId);
      const candidates = summaryMessages(current).slice(0, sources.length);
      return candidates.length === sources.length && candidates.every((message, index) => messageFingerprint(message) === messageFingerprint(sources[index]!));
    }
    // 非前缀模式只需按 id 取回被引用的消息，不必反序列化整段历史。
    if (!sources.length) return true;
    const ids = [...new Set(sources.map(source => source.id))];
    // 原实现里每个 id 最多命中一次，重复 id 必然导致长度不等。
    if (ids.length !== sources.length) return false;
    const current = (this.database.prepare(`
      SELECT messages.*, rowid AS message_sequence FROM messages
      WHERE conversation_id = ? AND branch_id = (SELECT active_branch_id FROM conversations WHERE id = ?)
        AND id IN (${ids.map(() => "?").join(",")})
      ORDER BY rowid ASC
    `).all(conversationId, conversationId, ...ids) as unknown as MessageRow[]).map(messageFromRow);
    return current.length === sources.length && current.every((message, index) => messageFingerprint(message) === messageFingerprint(sources[index]!));
  }

  // 该角色关联的记忆数（story/character 作用域都记在此角色下）。
  countMemoriesForCharacter(characterId: string): number {
    const row = this.database
      .prepare("SELECT count(*) AS n FROM memories WHERE character_id = ?")
      .get(characterId) as { n: number };
    return row.n;
  }
}
