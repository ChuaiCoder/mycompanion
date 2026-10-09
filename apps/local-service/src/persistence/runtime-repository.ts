import { randomUUID } from "node:crypto";
import type { MacroVariableChange } from "../prompt/prompt-macros.js";
import { DatabaseSync } from "node:sqlite";
import { ensureMigrationTable } from "./migrations.js";
import { WorldInfoRepository } from "../world-info/world-info-repository.js";
import { RetainedCharacterChatsRepository } from "../chat/retained-character-chats.js";
import { PersonaAvatarRepository } from "../character/persona-avatars.js";
import { VectorStore } from "../providers/vector-store.js";
import { VectorCollectionRepository } from "../providers/vector-collections.js";
import { ProviderRepository } from "../providers/provider-repository.js";
import { PluginRepository } from "./plugin-repository.js";
import { ExtensionSettingsRepository } from "./extension-settings-repository.js";
import { BackupRepository } from "../storage/backup-repository.js";
import { MemoryRepository } from "./memory-repository.js";
import { ConversationRepository } from "./conversation-repository.js";

import type {
  BackupPayload,
  ChatMessage,
  ConversationDetail,
  ConversationListResponse,
  InstalledPlugin,
  MemoryRecord,
  MemoryScope,
  MemoryStatus,
  MemoryType,
  MessageGenerationMetadata,
  ModelCandidateSnapshot,
  PluginListResponse,
  PluginManifest,
  ProviderSettings,
  ProviderTask,
  StageSummary,
  UpdateProviderSettings,
} from "@mycompanion/shared";
import type { CharacterDetail } from "@mycompanion/shared";

/** 模型上下文上限的默认值；旧数据库与未保存过设置的行都按此回退。 */
export const DEFAULT_CONTEXT_LIMIT_TOKENS = 32_768;

// 候选回复切换冲突（消息流式中、序号失效）。路由映射为 409。实现位于 conversation-repository.ts。
export { SwipeSelectionError } from "./conversation-repository.js";

/**
 * 装配层：持有数据库连接、建表与迁移、withTransaction 原语，
 * 并构造各子仓储（worldInfo/providers/plugins/memory/backup/extensionSettings/conversations）。
 * 公开方法均为同名同签名的薄委托，调用方零改动。
 */
export class RuntimeRepository {
  readonly #database: DatabaseSync;
  readonly worldInfo: WorldInfoRepository;
  readonly retainedChats: RetainedCharacterChatsRepository;
  readonly avatars: PersonaAvatarRepository;
  readonly vectors: VectorStore;
  readonly vectorCollections: VectorCollectionRepository;
  readonly providers: ProviderRepository;
  readonly plugins: PluginRepository;
  readonly extensionSettings: ExtensionSettingsRepository;
  readonly backup: BackupRepository;
  readonly memory: MemoryRepository;
  readonly conversations: ConversationRepository;

  /** All backup sections share this connection; inner savepoints stay rollbackable. */
  withBackupTransaction<T>(work: () => T): T {
    return this.withTransaction(work);
  }

  /** Synchronous nested writes compose without committing their caller's work. */
  withTransaction<T>(work: () => T): T {
    const savepoint = `runtime_write_${randomUUID().replaceAll("-", "")}`;
    this.#database.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = work();
      this.#database.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      try {
        this.#database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.#database.exec(`RELEASE SAVEPOINT ${savepoint}`);
      } catch {
        // SQLITE_FULL/IOERR may already have rolled back the transaction.
        // Preserve the original failure rather than replacing it with a missing savepoint.
      }
      throw error;
    }
  }

  constructor(database: DatabaseSync) {
    this.#database = database;
    this.worldInfo = new WorldInfoRepository(database);
    this.retainedChats = new RetainedCharacterChatsRepository(database, this);
    this.avatars = new PersonaAvatarRepository(database);
    this.vectors = new VectorStore(database);
    this.vectorCollections = new VectorCollectionRepository(database, this.vectors);
    this.#migrateSchema();
    // 版本化迁移登记表：今后结构变更走 migrations.ts 的 applyMigration；
    // 下面的探测式迁移是版本表出现之前的基线，原样保留。
    ensureMigrationTable(this.#database);
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS provider_settings (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        kind TEXT NOT NULL,
        base_url TEXT NOT NULL,
        model TEXT NOT NULL,
        api_key_ciphertext TEXT,
        temperature REAL NOT NULL,
        max_tokens INTEGER NOT NULL,
        context_limit_tokens INTEGER,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        character_name TEXT NOT NULL,
        title TEXT NOT NULL,
        active_branch_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        header_json TEXT NOT NULL DEFAULT '{}',
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        branch_id TEXT NOT NULL,
        parent_message_id TEXT,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('streaming', 'complete', 'stopped', 'failed')),
        generation_json TEXT,
        extension_data_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        PRIMARY KEY (id, branch_id)
      );

      CREATE INDEX IF NOT EXISTS conversations_updated_at_idx
        ON conversations(updated_at DESC);
      CREATE INDEX IF NOT EXISTS messages_conversation_idx
        ON messages(conversation_id, branch_id, parent_message_id);

      CREATE TABLE IF NOT EXISTS plugins (
        id TEXT PRIMARY KEY,
        manifest_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        installed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS code_plugins (
        id TEXT PRIMARY KEY,
        manifest_json TEXT NOT NULL,
        normalized_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        installed_at TEXT NOT NULL,
        contributions_json TEXT NOT NULL DEFAULT '{"systemPrompt":"","commands":[]}'
      );

      CREATE TABLE IF NOT EXISTS extension_settings (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        settings_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS code_plugin_files (
        plugin_id TEXT NOT NULL REFERENCES code_plugins(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        content BLOB NOT NULL,
        PRIMARY KEY (plugin_id, path)
      );

      -- 长期记忆（FR-MEM-001/002/003）：事件/事实、故事状态、目标、关系。
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('fact', 'state', 'goal', 'relationship')),
        content TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('story', 'character', 'user')) DEFAULT 'story',
        importance INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'pending', 'superseded', 'disabled', 'orphaned')),
        pinned INTEGER NOT NULL DEFAULT 0,
        source_message_ids_json TEXT NOT NULL DEFAULT '[]',
        superseded_by TEXT,
        previous_content TEXT,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );

      CREATE INDEX IF NOT EXISTS memories_conversation_idx
        ON memories(conversation_id, character_id);

      -- 每个对话的设置（FR-MEM-006：自动摘要开关，默认开启）。
      CREATE TABLE IF NOT EXISTS conversation_settings (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        auto_summary_enabled INTEGER NOT NULL DEFAULT 1
      );

      -- 阶段摘要（FR-MEM-006）：每对话一条，保存覆盖范围与生成模型。
      CREATE TABLE IF NOT EXISTS stage_summaries (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        branch_id TEXT NOT NULL,
        source_message_ids_json TEXT NOT NULL DEFAULT '[]',
        source_fingerprint TEXT NOT NULL DEFAULT '',
        previous_source_json TEXT,
        content TEXT NOT NULL,
        covered_message_count INTEGER NOT NULL DEFAULT 0,
        model TEXT NOT NULL,
        previous_content TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (conversation_id, branch_id)
      );
    `);
    this.#migrateDerivedState();
    this.providers = new ProviderRepository(database);
    this.plugins = new PluginRepository(database);
    this.extensionSettings = new ExtensionSettingsRepository(database,
      (work) => this.withTransaction(work), (id) => this.conversations.getChatMetadata(id));
    this.backup = new BackupRepository(database, (id) => this.getConversation(id));
    this.memory = new MemoryRepository(database,
      (work) => this.withTransaction(work), (id, limit) => this.listMessages(id, limit));
    this.conversations = new ConversationRepository(database,
      (work) => this.withTransaction(work), (id) => this.syncMemoryReachability(id));
    this.#recoverStaleStreamingMessages();
  }

  #migrateDerivedState(): void {
    const memoryColumns = this.#database.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
    if (!memoryColumns.some(column => column.name === "source_message_fingerprints_json")) {
      this.#database.exec("ALTER TABLE memories ADD COLUMN source_message_fingerprints_json TEXT NOT NULL DEFAULT '{}'");
    }
    if (!memoryColumns.some(column => column.name === "provenance_json")) {
      this.#database.exec("ALTER TABLE memories ADD COLUMN provenance_json TEXT NOT NULL DEFAULT '{}'");
      this.#database.exec(`UPDATE memories SET provenance_json = '{"manuallyEdited":true}'
        WHERE previous_content IS NOT NULL OR source_message_ids_json = '[]'`);
    }
    const summaryColumns = this.#database.prepare("PRAGMA table_info(stage_summaries)").all() as Array<{ name: string }>;
    if (summaryColumns.some(column => column.name === "branch_id")) return;
    // Legacy summaries have no provable source revision. Preserve their content
    // for explicit review/edit, but never treat them as verified model context.
    this.#database.exec("SAVEPOINT migrate_derived_state");
    try {
      this.#database.exec(`ALTER TABLE stage_summaries RENAME TO stage_summaries_legacy;
        CREATE TABLE stage_summaries (
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          branch_id TEXT NOT NULL, source_message_ids_json TEXT NOT NULL DEFAULT '[]',
          source_fingerprint TEXT NOT NULL DEFAULT '', previous_source_json TEXT,
          content TEXT NOT NULL, covered_message_count INTEGER NOT NULL DEFAULT 0,
          model TEXT NOT NULL, previous_content TEXT, created_at TEXT NOT NULL,
          PRIMARY KEY (conversation_id, branch_id));
        INSERT INTO stage_summaries (conversation_id, branch_id, content, covered_message_count, model, previous_content, created_at)
          SELECT s.conversation_id, c.active_branch_id, s.content, s.covered_message_count, s.model, s.previous_content, s.created_at
          FROM stage_summaries_legacy s JOIN conversations c ON c.id = s.conversation_id;
        DROP TABLE stage_summaries_legacy; RELEASE SAVEPOINT migrate_derived_state;`);
    } catch (error) {
      this.#database.exec("ROLLBACK TO SAVEPOINT migrate_derived_state; RELEASE SAVEPOINT migrate_derived_state");
      throw error;
    }
  }

  /**
   * 数据库结构迁移。
   * 1) 放宽 messages.status 到四态（streaming/complete/stopped/failed）；
   * 2) 为旧表补齐 branch_id / parent_message_id / generation_json 列；
   * 3) 为 conversations 补 active_branch_id。
   * 旧数据保持可访问：既有消息归入以对话 ID 命名的根分支。
   */
  #migrateSchema(): void {
    const hasMessagesColumn = (name: string): boolean =>
      this.#database.prepare("PRAGMA table_info(messages)").all()
        .some((row) => (row as { name: string }).name === name);

    if (hasMessagesColumn("status")) {
      const oldSql = this.#database
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
        .get() as { sql?: string } | undefined;
      const needsRebuild =
        (oldSql?.sql ?? "").includes("status IN ('complete', 'failed')") ||
        !hasMessagesColumn("branch_id") ||
        !hasMessagesColumn("parent_message_id") ||
        !hasMessagesColumn("generation_json");
      if (needsRebuild) {
        this.#database.exec(`
          BEGIN IMMEDIATE;
          CREATE TABLE messages_new (
            id TEXT NOT NULL,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            branch_id TEXT NOT NULL,
            parent_message_id TEXT,
            role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
            content TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('streaming', 'complete', 'stopped', 'failed')),
            generation_json TEXT,
            created_at TEXT NOT NULL,
            PRIMARY KEY (id, branch_id)
          );
          INSERT INTO messages_new (id, conversation_id, branch_id, parent_message_id, role, content, status, generation_json, created_at)
            SELECT id, conversation_id, conversation_id, NULL, role, content, status, NULL, created_at FROM messages;
          DROP TABLE messages;
          ALTER TABLE messages_new RENAME TO messages;
          COMMIT;
        `);
        this.#database.exec(`
          CREATE INDEX IF NOT EXISTS messages_conversation_idx
            ON messages(conversation_id, branch_id, parent_message_id);
        `);
      }
    }

    const hasConversationColumn = (name: string): boolean =>
      this.#database.prepare("PRAGMA table_info(conversations)").all()
        .some((row) => (row as { name: string }).name === name);
    const conversationsExists = this.#database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversations'")
      .get() !== undefined;
    if (conversationsExists && !hasConversationColumn("active_branch_id")) {
      this.#database.prepare(
        "ALTER TABLE conversations ADD COLUMN active_branch_id TEXT NOT NULL DEFAULT ''",
      ).run();
    }
    // 旧库回填：分支功能前的会话 active_branch_id 为 ''（消息侧已归入以对话 ID
    // 命名的根分支），空值会使列表/详情的 UUID 校验整体失败。统一回填为对话 ID。
    if (conversationsExists) {
      this.#database.prepare(
        "UPDATE conversations SET active_branch_id = id WHERE active_branch_id = ''",
      ).run();
    }
    if (conversationsExists && !hasConversationColumn("metadata_json")) {
      this.#database.exec("ALTER TABLE conversations ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
    }
    if (conversationsExists && !hasConversationColumn("header_json")) {
      this.#database.exec("ALTER TABLE conversations ADD COLUMN header_json TEXT NOT NULL DEFAULT '{}'");
    }
    // 软删除（FR-DATA-004）：为空表示故事可见；非空为删除时间，可恢复。
    if (conversationsExists && !hasConversationColumn("deleted_at")) {
      this.#database.exec("ALTER TABLE conversations ADD COLUMN deleted_at TEXT");
    }
    if (hasMessagesColumn("id") && !hasMessagesColumn("extension_data_json")) {
      this.#database.exec("ALTER TABLE messages ADD COLUMN extension_data_json TEXT NOT NULL DEFAULT '{}'");
    }

    // 4) 为旧 provider_settings 补 context_limit_tokens（FR-PROMPT-003）。
    const hasProviderColumn = (name: string): boolean =>
      this.#database.prepare("PRAGMA table_info(provider_settings)").all()
        .some((row) => (row as { name: string }).name === name);
    const providerExists = this.#database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'provider_settings'")
      .get() !== undefined;
    if (providerExists && !hasProviderColumn("context_limit_tokens")) {
      this.#database.prepare(
        "ALTER TABLE provider_settings ADD COLUMN context_limit_tokens INTEGER",
      ).run();
    }
  }

  /**
   * 服务进程可能在流式生成期间退出。重启后把仍停留在 'streaming' 的助手消息
   * 标记为 'stopped'（保留已接收文本），避免状态永久悬挂。
   */
  #recoverStaleStreamingMessages(): void {
    this.#database.prepare(`
      UPDATE messages SET status = 'stopped'
      WHERE status = 'streaming' AND role = 'assistant'
    `).run();
  }

  hasExtensionSettings(): boolean {
    return this.extensionSettings.has();
  }

  getExtensionSettings(): Record<string, unknown> {
    return this.extensionSettings.get();
  }

  saveExtensionSettings(settings: Record<string, unknown>): void {
    this.extensionSettings.save(settings);
  }

  commitMacroVariables(id: string | null, changes: MacroVariableChange[]): void {
    this.extensionSettings.commitMacroVariables(id, changes);
  }

  getProvider(): ProviderSettings {
    return this.resolveTaskProvider("chat")!.settings;
  }

  resolveTaskProvider(task: ProviderTask): { profileId: string; settings: ProviderSettings } | undefined {
    return this.providers.resolve(task);
  }

  getEncryptedApiKey(profileId?: string): string | undefined {
    return this.providers.encryptedKey(profileId ?? this.providers.assignments().chat);
  }

  saveProvider(settings: UpdateProviderSettings, encryptedApiKey?: string): ProviderSettings {
    const selected = this.providers.resolve("chat")!;
    return this.providers.save(selected.profileId, this.providers.get(selected.profileId)!.name, settings, encryptedApiKey).settings;
  }

  createConversation(character: CharacterDetail, greetingIndex?: number): ConversationDetail {
    return this.conversations.createConversation(character, greetingIndex);
  }

  // 当前分支可达的消息 ID 集合（FR-MEM-008 分支回滚判定用）。
  listReachableMessageIds(conversationId: string): Set<string> {
    return this.memory.listReachableMessageIds(conversationId);
  }

  // 自动摘要开关（FR-MEM-006）：默认开启。
  isAutoSummaryEnabled(conversationId: string): boolean {
    return this.conversations.isAutoSummaryEnabled(conversationId);
  }

  setAutoSummaryEnabled(conversationId: string, enabled: boolean): void {
    this.conversations.setAutoSummaryEnabled(conversationId, enabled);
  }

  // 阶段摘要（FR-MEM-006）。
  getSummary(conversationId: string): StageSummary | undefined {
    return this.conversations.getSummary(conversationId);
  }

  saveSummary(conversationId: string, content: string, coveredMessageCount: number, model: string): StageSummary {
    return this.conversations.saveSummary(conversationId, content, coveredMessageCount, model);
  }

  // 编辑摘要：保留旧内容用于恢复上一版本（FR-MEM-007）。
  editSummary(conversationId: string, content: string): StageSummary | undefined {
    return this.conversations.editSummary(conversationId, content);
  }

  restoreSummary(conversationId: string): StageSummary | undefined {
    return this.conversations.restoreSummary(conversationId);
  }

  /** Async derivation may finish after edit/switch; verify captured sources before saving. */
  isMessageSnapshotCurrent(conversationId: string, branchId: string, sources: ChatMessage[], prefix = false): boolean {
    return this.memory.isMessageSnapshotCurrent(conversationId, branchId, sources, prefix);
  }

  // ---- 长期记忆（FR-MEM-001/002/003/004/007/008）：实现位于 persistence/memory-repository.ts ----

  listMemories(
    conversationId: string,
    filters: { scope?: MemoryScope | undefined; type?: MemoryType | undefined; status?: MemoryStatus | undefined } = {},
  ): MemoryRecord[] {
    return this.memory.listMemories(conversationId, filters);
  }

  getMemory(memoryId: string): MemoryRecord | undefined {
    return this.memory.getMemory(memoryId);
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
    return this.memory.listMemoryInventory(filters);
  }

  getMemoryForConversation(memoryId: string, conversationId: string): MemoryRecord | undefined {
    return this.memory.getMemoryForConversation(memoryId, conversationId);
  }

  addMemory(record: MemoryRecord): MemoryRecord {
    return this.memory.addMemory(record);
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
    return this.memory.updateMemory(memoryId, patch);
  }

  restoreMemory(memoryId: string, mode?: "supersession" | "previous_content"): MemoryRecord | undefined {
    return this.memory.restoreMemory(memoryId, mode);
  }

  deleteMemory(memoryId: string): boolean {
    return this.memory.deleteMemory(memoryId);
  }

  /**
   * FR-MEM-004: overlap never authorizes replacement. The caller must compose this
   * decision and addMemory inside one transaction so links never point to a failed insert.
   */
  recordSupersession(newMemory: MemoryRecord): string[] {
    return this.memory.recordSupersession(newMemory);
  }

  /** 标记本轮注入的记忆（FR-MEM-002 最后使用时间）。 */
  markMemoriesUsed(memoryIds: string[]): void {
    this.memory.markMemoriesUsed(memoryIds);
  }

  /**
   * FR-MEM-008 分支回滚：来源消息全部不再可达的 active 记忆转 orphaned；
   * 已 orphaned 的记忆如果来源重新可达（回到原分支）则恢复 active。
   */
  syncMemoryReachability(conversationId: string): void {
    this.memory.syncMemoryReachability(conversationId);
  }

  listConversations(): ConversationListResponse {
    return this.conversations.listConversations();
  }

  /**
   * 软删除（FR-DATA-004）：只标记 deleted_at，消息、分支、摘要与记忆来源全部保留，
   * 因此恢复后原样可用。列表/详情在读取时按该列过滤，无需级联改写派生数据。
   * 返回删除时间；故事不存在或已删除时返回 undefined（幂等）。
   */
  softDeleteConversation(id: string): string | undefined {
    return this.conversations.softDeleteConversation(id);
  }

  /** 撤销软删除；故事本来可见或不存在时返回 false。 */
  undeleteConversation(id: string): boolean {
    return this.conversations.undeleteConversation(id);
  }

  /**
   * 批量软删除：一个事务内完成，避免部分成功留下"删了一半"的状态。
   *
   * 与单条删除同语义（只打 deleted_at，内容全部保留、可恢复）。已删除或不存在的 id 不报错，
   * 而是回收到 `skipped`，让调用方知道哪些没生效，而不是把幂等写成"全部成功"。
   * 同一事务内取同一个时间戳，便于在界面上把它们视作同一次操作。
   */
  softDeleteConversations(ids: readonly string[]): { deleted: Array<{ id: string; deletedAt: string }>; skipped: string[] } {
    return this.conversations.softDeleteConversations(ids);
  }

  /** 查询软删除状态，供路由区分「不存在」与「已删除」。 */
  conversationDeletedAt(id: string): string | null | undefined {
    return this.conversations.conversationDeletedAt(id);
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
    return this.conversations.purgeDeletedConversations();
  }

  /** 回收已释放页占用的磁盘空间；必须不在事务内执行。 */
  vacuum(): void {
    this.conversations.vacuum();
  }

  /**
   * 备份聚合（FR-DATA-003）：全量读取角色关联的数据，供备份包组装。
   * 这里返回原始行，序列化（含 base64 / 校验）由调用方负责。
   */
  listConversationsForBackup(): ReturnType<BackupRepository["listConversationsForBackup"]> {
    return this.backup.listConversationsForBackup();
  }

  // 一个对话所有分支的消息（备份用，含 branch_id / parent 链接）。
  listAllBranchMessages(conversationId: string): ChatMessage[] {
    return this.backup.listAllBranchMessages(conversationId);
  }

  listMemoriesForBackup(): MemoryRecord[] {
    return this.backup.listMemoriesForBackup();
  }

  listStageSummariesForBackup(): BackupPayload["stageSummaries"] {
    return this.backup.listStageSummariesForBackup();
  }

  listConversationSettingsForBackup(): Array<{ conversationId: string; autoSummaryEnabled: boolean }> {
    return this.backup.listConversationSettingsForBackup();
  }

  // 备份恢复（FR-DATA-003）：整条故事覆盖写入（旧消息/摘要/设置先清空）。
  restoreConversation(entry: Parameters<BackupRepository["restoreConversation"]>[0]): number {
    return this.backup.restoreConversation(entry);
  }

  // 恢复单条记忆：同 ID 覆盖，否则插入。（FR-DATA-003）
  upsertMemoryForBackup(record: MemoryRecord): void {
    this.backup.upsertMemoryForBackup(record);
  }

  restoreStageSummary(summary: BackupPayload["stageSummaries"][number]): void {
    this.backup.restoreStageSummary(summary);
  }

  /** 读取某故事的自动摘要开关；没有记录时返回 undefined（与"已关闭"区分开）。 */
  getConversationSetting(conversationId: string): { conversationId: string; autoSummaryEnabled: boolean } | undefined {
    return this.backup.getConversationSetting(conversationId);
  }

  restoreConversationSetting(setting: { conversationId: string; autoSummaryEnabled: boolean }): void {
    this.backup.restoreConversationSetting(setting);
  }

  restorePlugin(plugin: { id: string; manifest: Record<string, unknown>; enabled: boolean; installedAt: string }): void {
    this.backup.restorePlugin(plugin);
  }

  // 备份恢复存在性检查（FR-DATA-003 预览）。
  conversationExists(id: string): boolean {
    return this.backup.conversationExists(id);
  }
  memoryExists(id: string): boolean {
    return this.backup.memoryExists(id);
  }
  stageSummaryExists(conversationId: string, branchId?: string): boolean {
    return this.backup.stageSummaryExists(conversationId, branchId);
  }
  pluginExists(id: string): boolean {
    return this.backup.pluginExists(id);
  }
  // 声明式插件的原始 manifest（备份用）。
  getPluginManifest(id: string): Record<string, unknown> | undefined {
    return this.backup.getPluginManifest(id);
  }

  // 该角色关联的故事数（FR-DATA-004 删除前计数）。
  countConversationsForCharacter(characterId: string): number {
    return this.conversations.countConversationsForCharacter(characterId);
  }

  // 该角色关联的记忆数（story/character 作用域都记在此角色下）。
  countMemoriesForCharacter(characterId: string): number {
    return this.memory.countMemoriesForCharacter(characterId);
  }

  /**
   * 读取故事详情。软删除的故事默认不可见（列表与详情一致），因此已删除的故事在只读
   * 路由上表现为 404。备份恢复等需要拿到已删除行的调用方显式传 `includeDeleted`。
   */
  getConversation(id: string, messageLimit?: number, options: { includeDeleted?: boolean } = {}): ConversationDetail | undefined {
    return this.conversations.getConversation(id, messageLimit, options);
  }

  /** 只读元数据（单行）：冲突检测等不需要消息历史的场景。 */
  getChatMetadata(id: string): Record<string, unknown> | undefined {
    return this.conversations.getChatMetadata(id);
  }

  /** 只读当前激活分支 id：给只需要分支归属的调用方。 */
  getActiveBranchId(id: string): string | undefined {
    return this.conversations.getActiveBranchId(id);
  }

  /** Merge only invocation-owned WI metadata inside the accepting savepoint.
   * Revision covers both public timedWorldInfo and private prefix checkpoints. */
  commitWorldInfoState(id: string, branchId: string, before: string, next: Record<string, unknown>, sources: string[]): void {
    this.conversations.commitWorldInfoState(id, branchId, before, next, sources);
  }

  // 只返回当前激活分支的消息，按发生顺序（parent_message_id 链接的链）排序。
  // limit 仅用于给模型上下文取最近 N 条（UI 展示用完整列表，limit 传 undefined）。
  listMessages(conversationId: string, limit?: number): ChatMessage[] {
    return this.conversations.listMessages(conversationId, limit);
  }

  addMessage(
    conversationId: string,
    role: ChatMessage["role"],
    content: string,
    status: ChatMessage["status"] = "complete",
  ): ChatMessage {
    return this.conversations.addMessage(conversationId, role, content, status);
  }

  // 流式生成的助手消息先以 'streaming' 落库（内容为空），结束/停止/失败时再定稿。
  createAssistantMessage(conversationId: string): ChatMessage {
    return this.conversations.createAssistantMessage(conversationId);
  }

  // Accept a continuation only after preflight. A changed branch/tail must not
  // turn a stale model request into an overwrite of an edited message.
  prepareContinueMessage(conversationId: string, expected: ChatMessage): ChatMessage {
    return this.conversations.prepareContinueMessage(conversationId, expected);
  }

  finalizeContinuedMessage(message: ChatMessage, status: "complete" | "stopped" | "failed", content: string,
    generation?: MessageGenerationMetadata): ChatMessage {
    return this.conversations.finalizeContinuedMessage(message, status, content, generation);
  }

  finalizeAssistantMessage(
    message: ChatMessage,
    status: "complete" | "stopped" | "failed",
    content: string,
    generation?: MessageGenerationMetadata,
    candidates?: ModelCandidateSnapshot[],
  ): ChatMessage {
    return this.conversations.finalizeAssistantMessage(message, status, content, generation, candidates);
  }

  // Fork at the edit point. Unchanged prefix IDs remain valid sources; the edited
  // message receives a new ID, and descendants stay accessible on the old branch.
  editMessage(conversationId: string, messageId: string, content: string): ChatMessage | undefined {
    return this.conversations.editMessage(conversationId, messageId, content);
  }

  // 选择候选回复（FR-CHAT）：swipe_id/内容/扩展数据/投影的服务端原子更新。
  // 语义与投影逻辑保持一致：原候选保留当前展示状态，新候选继承自己的 extra。
  selectMessageSwipe(conversationId: string, message: ChatMessage, swipeId: number, contentOverride?: string): ChatMessage {
    return this.conversations.selectMessageSwipe(conversationId, message, swipeId, contentOverride);
  }

  // 删除当前分支中的一条消息。
  deleteMessage(conversationId: string, messageId: string): boolean {
    return this.conversations.deleteMessage(conversationId, messageId);
  }

  getMessage(conversationId: string, messageId: string, branchId: string): ChatMessage | undefined {
    return this.conversations.getMessage(conversationId, messageId, branchId);
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
    return this.conversations.prepareRegenerateLastAssistant(conversationId);
  }

  // 切换当前分支到指定分支 ID（若分支中尚无消息则不切换）。
  activateBranch(conversationId: string, branchId: string): ConversationDetail | undefined {
    return this.conversations.activateBranch(conversationId, branchId);
  }

  listPlugins(): PluginListResponse {
    return this.plugins.list();
  }

  installPlugin(manifest: PluginManifest): InstalledPlugin {
    return this.plugins.install(manifest);
  }

  getPlugin(id: string): InstalledPlugin | undefined {
    return this.plugins.get(id);
  }

  setPluginEnabled(id: string, enabled: boolean): InstalledPlugin | undefined {
    return this.plugins.setEnabled(id, enabled);
  }

  deletePlugin(id: string): boolean {
    return this.plugins.delete(id);
  }

  activePlugins(): InstalledPlugin[] {
    return this.plugins.active();
  }
}
