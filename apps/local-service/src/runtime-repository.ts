import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { MacroVariableChange } from "./prompt-macros.js";
import { MacroVariableConflictError } from "./macro-variable-conflict.js";
import { worldInfoStateRevision, worldInfoSourcesMatch, WORLD_INFO_STATE_KEY,restoreWorldInfoStateForBranch } from "./world-info-effects.js";
import { DatabaseSync } from "node:sqlite";
import { classifyMemoryRelation, isCompleteSourceQuote, isProtectedMemory, quoteDirectlyNamesClaim, quoteProvesTransition } from "./memory-conflict-core.js";
import { WorldInfoRepository } from "./world-info-repository.js";
import { RetainedCharacterChatsRepository } from "./retained-character-chats.js";
import { PersonaAvatarRepository } from "./persona-avatars.js";
import { VectorStore } from "./vector-store.js";
import { VectorCollectionRepository } from "./vector-collections.js";
import { ProviderRepository } from "./provider-repository.js";

import type {
  BackupPayload,
  ChatMessage,
  ConversationDetail,
  ConversationListResponse,
  ConversationSummary,
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
import { projectNativeCandidateMessage, hasNativeCandidateHistory, NATIVE_CANDIDATE_INFO_KEY, messageGenerationMetadataSchema } from "@mycompanion/shared";

/** 模型上下文上限的默认值；旧数据库与未保存过设置的行都按此回退。 */
export const DEFAULT_CONTEXT_LIMIT_TOKENS = 32_768;

/** 候选回复切换冲突（消息流式中、序号失效）。路由映射为 409。 */
export class SwipeSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwipeSelectionError";
  }
}

interface ConversationRow {
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
}

interface MessageRow {
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

interface PluginRow {
  manifest_json: string;
  enabled: number;
  installed_at: string;
}

interface StageSummaryRow {
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

interface MemoryRow {
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

function stageSummaryFromRow(row: StageSummaryRow): StageSummary {
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

function messageFingerprint(message: ChatMessage): string {
  return createHash("sha256").update(JSON.stringify([message.id, message.role, message.content, message.status,
    message.generationMetadata?.completionOutcome ?? null])).digest("hex");
}

function sourceFingerprint(messages: ChatMessage[]): string {
  return createHash("sha256").update(JSON.stringify(messages.map(message => messageFingerprint(message)))).digest("hex");
}

function summaryMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(message => message.status === "complete" && message.content.trim()
    && (!message.generationMetadata?.completionOutcome || message.generationMetadata.completionOutcome === "complete"));
}

function expandMacros(text: string, characterName: string): string {
  return text
    .replaceAll(/{{\s*char\s*}}/gi, characterName)
    .replaceAll(/{{\s*user\s*}}/gi, "User");
}

function parseGeneration(json: string | null): MessageGenerationMetadata | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as MessageGenerationMetadata;
  } catch {
    return undefined;
  }
}

function messageFromRow(row: MessageRow): ChatMessage {
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

export class RuntimeRepository {
  readonly #database: DatabaseSync;
  readonly worldInfo: WorldInfoRepository;
  readonly retainedChats: RetainedCharacterChatsRepository;
  readonly avatars: PersonaAvatarRepository;
  readonly vectors: VectorStore;
  readonly vectorCollections: VectorCollectionRepository;
  readonly providers: ProviderRepository;

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
        header_json TEXT NOT NULL DEFAULT '{}'
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
    if (conversationsExists && !hasConversationColumn("metadata_json")) {
      this.#database.exec("ALTER TABLE conversations ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
    }
    if (conversationsExists && !hasConversationColumn("header_json")) {
      this.#database.exec("ALTER TABLE conversations ADD COLUMN header_json TEXT NOT NULL DEFAULT '{}'");
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
    return this.#database.prepare("SELECT 1 FROM extension_settings WHERE singleton = 1").get() !== undefined;
  }

  getExtensionSettings(): Record<string, unknown> {
    const row = this.#database.prepare("SELECT settings_json FROM extension_settings WHERE singleton = 1").get() as { settings_json: string } | undefined;
    return row ? JSON.parse(row.settings_json) as Record<string, unknown> : { variables: { global: {} } };
  }

  saveExtensionSettings(settings: Record<string, unknown>): void {
    // A settings-only replacement must not erase independently saved QR sets.
    // An explicit field still permits backup/import overwrite and API deletion.
    const qrKey="__mycompanion_quick_reply_presets";
    if(!Object.hasOwn(settings,qrKey)){
      const existing=this.getExtensionSettings();
      if(Object.hasOwn(existing,qrKey))settings={...settings,[qrKey]:existing[qrKey]};
    }
    this.#database.prepare(`INSERT INTO extension_settings (singleton, settings_json) VALUES (1, ?)
      ON CONFLICT(singleton) DO UPDATE SET settings_json = excluded.settings_json`).run(JSON.stringify(settings));
  }

  commitMacroVariables(id: string | null, changes: MacroVariableChange[]): void {
    // Neutral-chat local variables have no durable story. Globals still belong
    // to the application and use the same atomic conflict check.
    if (id === null) changes = changes.filter(change => change.scope === "global");
    if (!changes.length) return;
    this.withTransaction(() => {
      const conversation = id === null ? undefined : this.getConversation(id);
      if (id !== null && !conversation) throw new Error("宏变量所属的故事已不存在。");
      const metadata = conversation?.chatMetadata ?? {}, settings = this.getExtensionSettings();
      const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
      const local = record(metadata.variables), namespace = record(settings.variables), global = record(namespace.global);
      for (const change of changes) {
        const store = change.scope === "local" ? local : global;
        if (Object.hasOwn(store,change.key) !== change.beforeExists || !isDeepStrictEqual(Object.hasOwn(store,change.key)?store[change.key]:undefined,change.before))
          throw new MacroVariableConflictError(change.key);
        if (change.afterExists) Object.defineProperty(store,change.key,{value:change.after,writable:true,configurable:true,enumerable:true});
        else delete store[change.key];
      }
      if (changes.some(change=>change.scope==="local")) {
        metadata.variables=local;
        this.#database.prepare("UPDATE conversations SET metadata_json = ? WHERE id = ?").run(JSON.stringify(metadata),id);
      }
      if (changes.some(change=>change.scope==="global")) {
        namespace.global=global;settings.variables=namespace;this.saveExtensionSettings(settings);
      }
    });
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
      this.#database.prepare(`
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
        this.#database.prepare(`
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
    const row = this.#database.prepare(
      "SELECT active_branch_id FROM conversations WHERE id = ?",
    ).get(conversationId) as { active_branch_id: string } | undefined;
    return row?.active_branch_id;
  }

  // 当前分支可达的消息 ID 集合（FR-MEM-008 分支回滚判定用）。
  listReachableMessageIds(conversationId: string): Set<string> {
    const branchId = this.activeBranchId(conversationId);
    if (!branchId) return new Set();
    const rows = this.#database.prepare(
      "SELECT id FROM messages WHERE conversation_id = ? AND branch_id = ?",
    ).all(conversationId, branchId) as Array<{ id: string }>;
    return new Set(rows.map((row) => row.id));
  }

  // 自动摘要开关（FR-MEM-006）：默认开启。
  isAutoSummaryEnabled(conversationId: string): boolean {
    const row = this.#database.prepare(
      "SELECT auto_summary_enabled FROM conversation_settings WHERE conversation_id = ?",
    ).get(conversationId) as { auto_summary_enabled: number } | undefined;
    return row?.auto_summary_enabled !== 0;
  }

  setAutoSummaryEnabled(conversationId: string, enabled: boolean): void {
    this.#database.prepare(`
      INSERT INTO conversation_settings (conversation_id, auto_summary_enabled)
      VALUES (?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET auto_summary_enabled = excluded.auto_summary_enabled
    `).run(conversationId, enabled ? 1 : 0);
  }

  // 阶段摘要（FR-MEM-006）。
  getSummary(conversationId: string): StageSummary | undefined {
    const branchId = this.activeBranchId(conversationId);
    if (!branchId) return undefined;
    const row = this.#database.prepare(`
      SELECT * FROM stage_summaries WHERE conversation_id = ? AND branch_id = ?
    `).get(conversationId, branchId) as StageSummaryRow | undefined;
    if (!row) return undefined;
    const sources = summaryMessages(this.listMessages(conversationId)).slice(0, row.covered_message_count);
    return { ...stageSummaryFromRow(row), valid: sources.length === row.covered_message_count
      && row.source_fingerprint === sourceFingerprint(sources)
      && isDeepStrictEqual(JSON.parse(row.source_message_ids_json), sources.map(message => message.id)) };
  }

  saveSummary(conversationId: string, content: string, coveredMessageCount: number, model: string): StageSummary {
    const branchId = this.activeBranchId(conversationId);
    if (!branchId) throw new Error("Summary story does not exist.");
    const sources = summaryMessages(this.listMessages(conversationId)).slice(0, coveredMessageCount);
    const createdAt = new Date().toISOString();
    this.#database.prepare(`
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
    const previous = this.#database.prepare("SELECT * FROM stage_summaries WHERE conversation_id = ? AND branch_id = ?")
      .get(conversationId, branchId) as StageSummaryRow | undefined;
    if (!previous) return undefined;
    const sources = summaryMessages(this.listMessages(conversationId)).slice(0, existing.coveredMessageCount);
    this.#database.prepare(`
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
    const row = this.#database.prepare("SELECT previous_source_json FROM stage_summaries WHERE conversation_id = ? AND branch_id = ?")
      .get(conversationId, branchId) as { previous_source_json: string | null };
    const previous = row.previous_source_json ? JSON.parse(row.previous_source_json) as {
      sourceMessageIds: string[]; sourceFingerprint: string; coveredMessageCount: number;
    } : { sourceMessageIds: [], sourceFingerprint: "", coveredMessageCount: existing.coveredMessageCount };
    this.#database.prepare(`
      UPDATE stage_summaries SET content = previous_content, previous_content = NULL, previous_source_json = NULL,
        covered_message_count = ?, source_message_ids_json = ?, source_fingerprint = ?, created_at = ?
      WHERE conversation_id = ? AND branch_id = ?
    `).run(previous.coveredMessageCount, JSON.stringify(previous.sourceMessageIds), previous.sourceFingerprint,
      new Date().toISOString(), conversationId, branchId);
    return this.getSummary(conversationId);
  }

  /** Async derivation may finish after edit/switch; verify captured sources before saving. */
  isMessageSnapshotCurrent(conversationId: string, branchId: string, sources: ChatMessage[], prefix = false): boolean {
    if (this.activeBranchId(conversationId) !== branchId) return false;
    const current = this.listMessages(conversationId);
    const candidates = prefix ? summaryMessages(current).slice(0, sources.length) : current.filter(message => sources.some(source => source.id === message.id));
    return candidates.length === sources.length && candidates.every((message, index) => messageFingerprint(message) === messageFingerprint(sources[index]!));
  }

  #inheritSummary(conversationId: string, oldBranch: string, newBranch: string, prefix: ChatMessage[]): void {
    const row = this.#database.prepare("SELECT * FROM stage_summaries WHERE conversation_id = ? AND branch_id = ?")
      .get(conversationId, oldBranch) as StageSummaryRow | undefined;
    if (!row) return;
    const sources = summaryMessages(prefix).slice(0, row.covered_message_count);
    if (sources.length !== row.covered_message_count || sourceFingerprint(sources) !== row.source_fingerprint
      || !isDeepStrictEqual(sources.map(message => message.id), JSON.parse(row.source_message_ids_json))) return;
    this.#database.prepare(`INSERT INTO stage_summaries
      SELECT conversation_id, ?, source_message_ids_json, source_fingerprint, previous_source_json,
        content, covered_message_count, model, previous_content, created_at
      FROM stage_summaries WHERE conversation_id = ? AND branch_id = ?`).run(newBranch, conversationId, oldBranch);
  }

  // ---- 长期记忆（FR-MEM-001/002/003/004/007/008） ----

  private memoryFromRow(row: MemoryRow): MemoryRecord {
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
    const rows = this.#database.prepare(`
      SELECT * FROM memories WHERE ${clauses.join(" AND ")} ORDER BY importance DESC, created_at DESC
    `).all(...params) as unknown as MemoryRow[];
    return rows.map((row) => this.memoryFromRow(row));
  }

  getMemory(memoryId: string): MemoryRecord | undefined {
    const row = this.#database.prepare("SELECT * FROM memories WHERE id = ?")
      .get(memoryId) as MemoryRow | undefined;
    return row ? this.memoryFromRow(row) : undefined;
  }

  readonly #memoryVisibilitySql = `EXISTS (SELECT 1 FROM conversations WHERE id = ?)
    AND ((scope = 'story' AND conversation_id = ?)
      OR (scope = 'character' AND character_id = (SELECT character_id FROM conversations WHERE id = ?))
      OR scope = 'user')`;

  getMemoryForConversation(memoryId: string, conversationId: string): MemoryRecord | undefined {
    const row = this.#database.prepare(`SELECT * FROM memories WHERE id = ? AND ${this.#memoryVisibilitySql}`)
      .get(memoryId, conversationId, conversationId, conversationId) as MemoryRow | undefined;
    return row ? this.memoryFromRow(row) : undefined;
  }

  addMemory(record: MemoryRecord): MemoryRecord {
    const sources = this.listMessages(record.conversationId).filter(message => record.sourceMessageIds.includes(message.id));
    const fingerprints = record.sourceMessageFingerprints ?? Object.fromEntries(sources.map(message => [message.id, messageFingerprint(message)]));
    this.#database.prepare(`
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
            this.#database.prepare("UPDATE memories SET status = 'superseded', superseded_by = ? WHERE id = ?")
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
      this.#database.prepare(`
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
        this.#database.prepare("UPDATE memories SET status = 'pending' WHERE id = ?").run(replacement.id);
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
      this.#database.prepare(`UPDATE memories SET content = ?, previous_content = ?, provenance_json = ?,
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
    return this.#database.prepare("DELETE FROM memories WHERE id = ?").run(memoryId).changes > 0;
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
      this.#database.prepare(`
        UPDATE memories SET status = 'superseded', superseded_by = ? WHERE id = ?
      `).run(newMemory.id, candidateId);
    }
    return affected;
  }

  /** 标记本轮注入的记忆（FR-MEM-002 最后使用时间）。 */
  markMemoriesUsed(memoryIds: string[]): void {
    if (memoryIds.length === 0) return;
    const statement = this.#database.prepare(
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
    const reachable = new Map(this.listMessages(conversationId).map(message => [message.id, messageFingerprint(message)]));
    const rows = this.#database.prepare(
      "SELECT * FROM memories WHERE conversation_id = ?",
    ).all(conversationId) as unknown as MemoryRow[];
    const records = new Map(rows.map(row => [row.id, this.memoryFromRow(row)]));
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
        if (nextStatus !== row.status) this.#database.prepare("UPDATE memories SET status = ? WHERE id = ?").run(nextStatus, row.id);
        continue;
      }
      if (row.status === "orphaned" && allReachable) {
        this.#database.prepare(`
          UPDATE memories SET status = 'active' WHERE id = ?
        `).run(row.id);
      } else if (row.status === "active" && sources.length > 0 && !allReachable) {
        this.#database.prepare(`
          UPDATE memories SET status = 'orphaned' WHERE id = ?
        `).run(row.id);
      }
    }
  }

  listConversations(): ConversationListResponse {
    const rows = this.#database.prepare(`
      SELECT c.*,
        COALESCE((SELECT substr(m.content, 1, 400) FROM messages m
          WHERE m.conversation_id = c.id AND m.branch_id = c.active_branch_id
          ORDER BY m.rowid DESC LIMIT 1), '') AS last_message_preview,
        (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id AND m.branch_id = c.active_branch_id) AS message_count
      FROM conversations c
      JOIN characters ch ON ch.id = c.character_id AND ch.deleted_at IS NULL
      ORDER BY c.updated_at DESC, c.id DESC
    `).all() as unknown as ConversationRow[];
    return { items: rows.map(summaryFromRow), total: rows.length };
  }

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
    messages: ChatMessage[];
    chatMetadata: Record<string, unknown>;
    chatHeader: Record<string, unknown>;
  }> {
    const conversations = this.#database
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
      // 备份包含全部分支的完整消息树（不止激活分支）。
      messages: this.listAllBranchMessages(row.id),
      chatMetadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
      chatHeader: JSON.parse(row.header_json) as Record<string, unknown>,
    }));
  }

  // 一个对话所有分支的消息（备份用，含 branch_id / parent 链接）。
  listAllBranchMessages(conversationId: string): ChatMessage[] {
    const rows = this.#database.prepare(`
      SELECT messages.*, rowid AS message_sequence FROM messages
      WHERE conversation_id = ?
      ORDER BY rowid ASC
    `).all(conversationId) as unknown as MessageRow[];
    return rows.map(messageFromRow);
  }

  listMemoriesForBackup(): MemoryRecord[] {
    const rows = this.#database.prepare("SELECT * FROM memories ORDER BY created_at").all() as unknown as MemoryRow[];
    return rows.map((row) => this.memoryFromRow(row));
  }

  listStageSummariesForBackup(): BackupPayload["stageSummaries"] {
    const rows = this.#database
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
    const rows = this.#database
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
    this.#database.exec("SAVEPOINT restore_conversation");
    try {
      this.#database.prepare(`
        INSERT INTO conversations (id, character_id, character_name, title, active_branch_id, created_at, updated_at, metadata_json, header_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          character_name = excluded.character_name,
          title = excluded.title,
          active_branch_id = excluded.active_branch_id,
          updated_at = excluded.updated_at,
          metadata_json = excluded.metadata_json,
          header_json = excluded.header_json
      `).run(entry.id, entry.characterId, entry.characterName, entry.title, entry.activeBranchId, entry.createdAt, entry.updatedAt, JSON.stringify(entry.chatMetadata ?? previous?.chatMetadata ?? {}), JSON.stringify(entry.chatHeader ?? previous?.chatHeader ?? {}));
      // 覆盖恢复：清掉该对话的旧消息/摘要/设置，再写入备份的完整消息树（全部分支）。
      this.#database.prepare("DELETE FROM messages WHERE conversation_id = ?").run(entry.id);
      this.#database.prepare("DELETE FROM stage_summaries WHERE conversation_id = ?").run(entry.id);
      this.#database.prepare("DELETE FROM conversation_settings WHERE conversation_id = ?").run(entry.id);
      this.#database.prepare("DELETE FROM memories WHERE conversation_id = ?").run(entry.id);
      const insert = this.#database.prepare(`
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
      this.#database.exec("RELEASE restore_conversation");
    } catch (error) {
      this.#database.exec("ROLLBACK TO restore_conversation; RELEASE restore_conversation");
      throw error;
    }
    return entry.messages.length;
  }

  // 恢复单条记忆：同 ID 覆盖，否则插入。（FR-DATA-003）
  upsertMemoryForBackup(record: MemoryRecord): void {
    this.#database.prepare(`
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
    const branchId = summary.branchId ?? this.activeBranchId(summary.conversationId);
    if (!branchId) throw new Error("Restored summary story does not exist.");
    this.#database.prepare(`
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

  restoreConversationSetting(setting: { conversationId: string; autoSummaryEnabled: boolean }): void {
    this.#database.prepare(`
      INSERT INTO conversation_settings (conversation_id, auto_summary_enabled) VALUES (?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET auto_summary_enabled = excluded.auto_summary_enabled
    `).run(setting.conversationId, setting.autoSummaryEnabled ? 1 : 0);
  }

  restorePlugin(plugin: { id: string; manifest: Record<string, unknown>; enabled: boolean; installedAt: string }): void {
    this.#database.prepare(`
      INSERT INTO plugins (id, manifest_json, enabled, installed_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        manifest_json = excluded.manifest_json,
        enabled = excluded.enabled,
        installed_at = excluded.installed_at
    `).run(plugin.id, JSON.stringify(plugin.manifest), plugin.enabled ? 1 : 0, plugin.installedAt);
  }

  // 备份恢复存在性检查（FR-DATA-003 预览）。
  conversationExists(id: string): boolean {
    return this.#database.prepare("SELECT 1 FROM conversations WHERE id = ?").get(id) !== undefined;
  }
  memoryExists(id: string): boolean {
    return this.#database.prepare("SELECT 1 FROM memories WHERE id = ?").get(id) !== undefined;
  }
  stageSummaryExists(conversationId: string, branchId = this.activeBranchId(conversationId)): boolean {
    return this.#database.prepare("SELECT 1 FROM stage_summaries WHERE conversation_id = ? AND branch_id = ?")
      .get(conversationId, branchId ?? "") !== undefined;
  }
  pluginExists(id: string): boolean {
    return this.#database.prepare("SELECT 1 FROM plugins WHERE id = ?").get(id) !== undefined;
  }
  // 声明式插件的原始 manifest（备份用）。
  getPluginManifest(id: string): Record<string, unknown> | undefined {
    const row = this.#database
      .prepare("SELECT manifest_json FROM plugins WHERE id = ?")
      .get(id) as { manifest_json: string } | undefined;
    return row ? (JSON.parse(row.manifest_json) as Record<string, unknown>) : undefined;
  }

  // 该角色关联的故事数（FR-DATA-004 删除前计数）。
  countConversationsForCharacter(characterId: string): number {
    const row = this.#database
      .prepare("SELECT count(*) AS n FROM conversations WHERE character_id = ?")
      .get(characterId) as { n: number };
    return row.n;
  }

  // 该角色关联的记忆数（story/character 作用域都记在此角色下）。
  countMemoriesForCharacter(characterId: string): number {
    const row = this.#database
      .prepare("SELECT count(*) AS n FROM memories WHERE character_id = ?")
      .get(characterId) as { n: number };
    return row.n;
  }

  getConversation(id: string, messageLimit?: number): ConversationDetail | undefined {
    const row = this.#database.prepare(`
      SELECT c.*,
        COALESCE((SELECT substr(m.content, 1, 400) FROM messages m
          WHERE m.conversation_id = c.id AND m.branch_id = c.active_branch_id
          ORDER BY m.rowid DESC LIMIT 1), '') AS last_message_preview,
        (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id AND m.branch_id = c.active_branch_id) AS message_count
      FROM conversations c WHERE c.id = ?
    `).get(id) as ConversationRow | undefined;
    if (!row) return undefined;
    return { ...summaryFromRow(row), messages: this.listMessages(id, messageLimit), chatMetadata: JSON.parse(row.metadata_json) as Record<string, unknown>, chatHeader: JSON.parse(row.header_json) as Record<string, unknown> };
  }

  /** Merge only invocation-owned WI metadata inside the accepting savepoint.
   * Revision covers both public timedWorldInfo and private prefix checkpoints. */
  commitWorldInfoState(id: string, branchId: string, before: string, next: Record<string, unknown>, sources: string[]): void {
    const current = this.getConversation(id);
    if (!current || current.activeBranchId !== branchId || !worldInfoSourcesMatch(sources, current.messages))
      throw new MacroVariableConflictError("世界书上下文");
    if (worldInfoStateRevision(current.chatMetadata ?? {}) !== before) throw new MacroVariableConflictError("世界书计时状态");
    const metadata = { ...current.chatMetadata, timedWorldInfo: structuredClone(next.timedWorldInfo),
      [WORLD_INFO_STATE_KEY]: structuredClone(next[WORLD_INFO_STATE_KEY]) };
    this.#database.prepare("UPDATE conversations SET metadata_json = ? WHERE id = ?").run(JSON.stringify(metadata), id);
  }

  // 只返回当前激活分支的消息，按发生顺序（parent_message_id 链接的链）排序。
  // limit 仅用于给模型上下文取最近 N 条（UI 展示用完整列表，limit 传 undefined）。
  listMessages(conversationId: string, limit?: number): ChatMessage[] {
    const rows = limit === undefined
      ? this.#database.prepare(`
          SELECT messages.*, rowid AS message_sequence FROM messages
          WHERE conversation_id = ? AND branch_id = (SELECT active_branch_id FROM conversations WHERE id = ?)
          ORDER BY rowid ASC
        `).all(conversationId, conversationId)
      : this.#database.prepare(`
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
    const parentRow = this.#database.prepare(`
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
      this.#database.prepare(`
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
      this.#database.prepare("UPDATE conversations SET updated_at = ?, metadata_json = json_set(metadata_json, '$.tainted', json('true')) WHERE id = ?")
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
    this.#database.prepare("UPDATE messages SET status = 'streaming' WHERE id = ? AND conversation_id = ? AND branch_id = ?")
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
        this.#database.prepare("UPDATE messages SET extension_data_json = ? WHERE id = ? AND conversation_id = ? AND branch_id = ?")
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
      this.#database.prepare(`
        UPDATE messages SET status = ?, content = ?, generation_json = ?, extension_data_json = ? WHERE id = ? AND conversation_id = ? AND branch_id = ?
      `).run(projected.status, content, projected.generationMetadata ? JSON.stringify(projected.generationMetadata) : null, JSON.stringify(extensionData), message.id, message.conversationId, message.branchId);
      this.#database.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
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
    this.#database.exec("SAVEPOINT edit_message_branch");
    try {
      const insert = this.#database.prepare(`INSERT INTO messages
        (id, conversation_id, branch_id, parent_message_id, role, content, status, generation_json, extension_data_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const message of [...current.messages.slice(0, index), edited]) {
        insert.run(message.id, conversationId, branchId, message.parentMessageId, message.role, message.content, message.status,
          message.generationMetadata ? JSON.stringify(message.generationMetadata) : null, JSON.stringify(message.extensionData ?? {}), message.createdAt);
      }
      this.#inheritSummary(conversationId, current.activeBranchId, branchId, current.messages.slice(0, index));
      this.#database.prepare("UPDATE conversations SET active_branch_id = ?, updated_at = ?, metadata_json = json_set(metadata_json, '$.tainted', json('true')) WHERE id = ?")
        .run(branchId, new Date().toISOString(), conversationId);
      this.syncMemoryReachability(conversationId);
      this.#restoreBranchWorldInfo(conversationId,current);
      this.#database.exec("RELEASE SAVEPOINT edit_message_branch");
    } catch (error) {
      this.#database.exec("ROLLBACK TO SAVEPOINT edit_message_branch; RELEASE SAVEPOINT edit_message_branch");
      throw error;
    }
    return edited;
  }

  // 选择候选回复（FR-CHAT）：swipe_id/内容/扩展数据/投影的服务端原子更新。
  // 语义与投影逻辑保持一致：原候选保留当前展示状态，新候选继承自己的 extra。
  selectMessageSwipe(conversationId: string, message: ChatMessage, swipeId: number): ChatMessage {
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
      this.#database.prepare(`UPDATE messages SET content = ?, status = ?, generation_json = ?, extension_data_json = ?
        WHERE id = ? AND conversation_id = ? AND branch_id = ?`).run(
        next.content, next.status, next.generationMetadata ? JSON.stringify(next.generationMetadata) : null,
        JSON.stringify(extensionData), message.id, message.conversationId, message.branchId);
      this.#database.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), conversationId);
      this.syncMemoryReachability(conversationId);
    });
    return this.getMessage(conversationId, message.id, message.branchId) ?? next;
  }

  // 删除当前分支中的一条消息。
  deleteMessage(conversationId: string, messageId: string): boolean {
    const branchId = this.activeBranchId(conversationId);
    if (!branchId) return false;
    const result = this.#database.prepare(`
      DELETE FROM messages WHERE id = ? AND conversation_id = ? AND branch_id = ?
    `).run(messageId, conversationId, branchId);
    if (result.changes > 0) {
      this.#database.prepare("UPDATE conversations SET updated_at = ?, metadata_json = json_set(metadata_json, '$.tainted', json('true')) WHERE id = ?")
        .run(new Date().toISOString(), conversationId);
      this.syncMemoryReachability(conversationId);
    }
    return result.changes > 0;
  }

  getMessage(conversationId: string, messageId: string, branchId: string): ChatMessage | undefined {
    const row = this.#database.prepare(`
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
      const anchorRow = this.#database.prepare(`
        SELECT rowid FROM messages WHERE id = ? AND conversation_id = ? AND branch_id = ?
      `).get(anchor.id, conversationId, current.activeBranchId) as { rowid: number } | undefined;
      if (anchorRow) {
        this.#database.prepare(`
          INSERT INTO messages (
            id, conversation_id, branch_id, parent_message_id, role, content, status, generation_json, extension_data_json, created_at
          )
          SELECT id, conversation_id, ?, parent_message_id, role, content, status, generation_json, extension_data_json, created_at
          FROM messages
          WHERE conversation_id = ? AND branch_id = ? AND rowid <= ?
          ORDER BY rowid ASC
        `).run(newBranchId, conversationId, current.activeBranchId, anchorRow.rowid);
      }
      this.#database.prepare(`
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
    const countRow = this.#database.prepare(`
      SELECT count(*) AS n FROM messages WHERE conversation_id = ? AND branch_id = ?
    `).get(conversationId, branchId) as { n: number } | undefined;
    if (!countRow || countRow.n === 0) return undefined;
    const previous=this.getConversation(conversationId);
    this.withTransaction(()=>{
      this.#database.prepare(`
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
    if(restored)this.#database.prepare("UPDATE conversations SET metadata_json = ? WHERE id = ?")
      .run(JSON.stringify({...current.chatMetadata,...restored}),conversationId);
  }

  listPlugins(): PluginListResponse {
    const rows = this.#database
      .prepare("SELECT manifest_json, enabled, installed_at FROM plugins ORDER BY installed_at DESC")
      .all() as unknown as PluginRow[];
    const items = rows.map((row) => ({
      ...(JSON.parse(row.manifest_json) as PluginManifest),
      enabled: Boolean(row.enabled),
      installedAt: row.installed_at,
    }));
    return { items, total: items.length };
  }

  installPlugin(manifest: PluginManifest): InstalledPlugin {
    const installedAt = new Date().toISOString();
    this.#database.prepare(`
      INSERT INTO plugins (id, manifest_json, enabled, installed_at)
      VALUES (?, ?, 0, ?)
      ON CONFLICT(id) DO UPDATE SET manifest_json = excluded.manifest_json, enabled = 0, installed_at = excluded.installed_at
    `).run(manifest.id, JSON.stringify(manifest), installedAt);
    return { ...manifest, enabled: false, installedAt };
  }

  getPlugin(id: string): InstalledPlugin | undefined {
    const row = this.#database
      .prepare("SELECT manifest_json, enabled, installed_at FROM plugins WHERE id = ?")
      .get(id) as PluginRow | undefined;
    if (!row) return undefined;
    return {
      ...(JSON.parse(row.manifest_json) as PluginManifest),
      enabled: Boolean(row.enabled),
      installedAt: row.installed_at,
    };
  }

  setPluginEnabled(id: string, enabled: boolean): InstalledPlugin | undefined {
    const result = this.#database
      .prepare("UPDATE plugins SET enabled = ? WHERE id = ?")
      .run(enabled ? 1 : 0, id);
    if (result.changes === 0) return undefined;
    return this.getPlugin(id);
  }

  deletePlugin(id: string): boolean {
    return this.#database.prepare("DELETE FROM plugins WHERE id = ?").run(id).changes > 0;
  }

  activePlugins(): InstalledPlugin[] {
    return this.listPlugins().items.filter((plugin) => plugin.enabled);
  }
}
