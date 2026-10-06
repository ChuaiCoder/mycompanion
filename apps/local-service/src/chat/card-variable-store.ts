import type { DatabaseSync } from "node:sqlite";
import type { CardVariableMutation, CardVariableType } from "@mycompanion/shared";

// 卡片脚本的变量存储：本应用自己的实现，独立于宏引擎的变量提交路径。
//
// 三级落点都复用已有列，不新增表：
//   - global / preset      → extension_settings.settings_json
//   - chat / character     → conversations.metadata_json（story 级）
//   - message              → messages.extension_data_json
//
// `character` 与 `chat` 共用故事级存储是刻意的：本应用把每个对话视为一次独立开档，
// 角色级跨故事共享会让新的一局看到上一局的变量，破坏该原则。

const GLOBAL_NAMESPACE = "variables";
const PRESET_NAMESPACE = "__mycompanion_card_preset_variables";

export interface CardVariableRequestTarget {
  type: CardVariableType;
  /** 仅 message 作用域使用；省略或 "latest" 表示当前最后一条消息。 */
  messageId?: string | "latest";
}

type Json = Record<string, unknown>;

const asRecord = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};

export class CardVariableStore {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  #extensionSettings(): Json {
    const row = this.#database.prepare("SELECT settings_json FROM extension_settings WHERE singleton = 1")
      .get() as { settings_json: string } | undefined;
    return row ? JSON.parse(row.settings_json) as Json : {};
  }

  #conversationMetadata(conversationId: string): Json | undefined {
    const row = this.#database.prepare("SELECT metadata_json FROM conversations WHERE id = ?")
      .get(conversationId) as { metadata_json: string } | undefined;
    return row ? JSON.parse(row.metadata_json) as Json : undefined;
  }

  /** 解析 message 作用域的落点：显式 messageId，否则当前激活分支的最后一条消息。 */
  #resolveMessageId(conversationId: string, target: CardVariableRequestTarget): string | undefined {
    if (target.messageId && target.messageId !== "latest") return target.messageId;
    const row = this.#database.prepare(`
      SELECT id FROM messages
      WHERE conversation_id = ? AND branch_id = (SELECT active_branch_id FROM conversations WHERE id = ?)
      ORDER BY rowid DESC LIMIT 1
    `).get(conversationId, conversationId) as { id: string } | undefined;
    return row?.id;
  }

  #messageVariables(conversationId: string, messageId: string | undefined): Json {
    if (!messageId) return {};
    const row = this.#database.prepare(
      "SELECT extension_data_json FROM messages WHERE id = ? AND conversation_id = ?",
    ).get(messageId, conversationId) as { extension_data_json: string } | undefined;
    if (!row) return {};
    // 与生成/切换候选写入的 `extra.variables` 共用同一落点。
    return asRecord(asRecord(asRecord(JSON.parse(row.extension_data_json)).extra).variables);
  }

  /** 读取某一级的原始变量。 */
  readScope(conversationId: string, target: CardVariableRequestTarget): Json {
    if (target.type === "global") return asRecord(asRecord(this.#extensionSettings()[GLOBAL_NAMESPACE]).global);
    if (target.type === "preset") return asRecord(this.#extensionSettings()[PRESET_NAMESPACE]);
    if (target.type === "message") {
      return this.#messageVariables(conversationId, this.#resolveMessageId(conversationId, target));
    }
    // chat 与 character 同为故事级。
    return asRecord(asRecord(this.#conversationMetadata(conversationId)?.variables));
  }

  /**
   * 读取合并视图。优先级：消息级 > 故事级 > 全局。
   * 这与"全局常被卡片当作默认设定、局部随剧情推进覆盖"的直觉一致。
   */
  readMerged(conversationId: string, target: Omit<CardVariableRequestTarget, "messageId"> & { messageId?: string }): Json {
    const global = this.readScope(conversationId, { type: "global" });
    const chat = this.readScope(conversationId, { type: "chat" });
    const message = target.messageId === undefined ? {} : this.readScope(conversationId, { type: "message", messageId: target.messageId });
    return { ...global, ...chat, ...message };
  }

  #writeConversationVariables(conversationId: string, variables: Json): void {
    const metadata = this.#conversationMetadata(conversationId);
    if (metadata === undefined) throw new Error("故事不存在。");
    metadata.variables = variables;
    this.#database.prepare("UPDATE conversations SET metadata_json = ? WHERE id = ?")
      .run(JSON.stringify(metadata), conversationId);
  }

  #writeMessageVariables(conversationId: string, messageId: string, variables: Json): void {
    const row = this.#database.prepare(
      "SELECT extension_data_json FROM messages WHERE id = ? AND conversation_id = ?",
    ).get(messageId, conversationId) as { extension_data_json: string } | undefined;
    if (!row) throw new Error("要写入的消息不存在。");
    const extensionData = asRecord(JSON.parse(row.extension_data_json));
    extensionData.extra = { ...asRecord(extensionData.extra), variables };
    this.#database.prepare("UPDATE messages SET extension_data_json = ? WHERE id = ? AND conversation_id = ?")
      .run(JSON.stringify(extensionData), messageId, conversationId);
  }

  /**
   * 应用一次变量写入，三级各自在**同一事务**内落盘。
   *
   * 事务内重新读取当前值再合并，避免与生成期间的写入互相覆盖——不是拿调用方传来的旧快照去覆盖。
   */
  commit(conversationId: string, mutation: CardVariableMutation): void {
    // 写入路径只接受已解析的 messageId；"latest" 只在读取/入口处解析。
    const target: CardVariableRequestTarget = mutation.messageId === undefined
      ? { type: mutation.type }
      : { type: mutation.type, messageId: mutation.messageId };
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      // 事务内重读：message 落点也要在这里解析，保证与写入同一致视图。
      const current = this.readScope(conversationId, target);
      const next = applyMutation(current, mutation);
      if (mutation.type === "global") {
        const settings = this.#extensionSettings();
        const namespace = asRecord(settings[GLOBAL_NAMESPACE]);
        namespace.global = next;
        settings[GLOBAL_NAMESPACE] = namespace;
        this.#database.prepare(`INSERT INTO extension_settings (singleton, settings_json) VALUES (1, ?)
          ON CONFLICT(singleton) DO UPDATE SET settings_json = excluded.settings_json`)
          .run(JSON.stringify(settings));
      } else if (mutation.type === "preset") {
        const settings = this.#extensionSettings();
        settings[PRESET_NAMESPACE] = next;
        this.#database.prepare(`INSERT INTO extension_settings (singleton, settings_json) VALUES (1, ?)
          ON CONFLICT(singleton) DO UPDATE SET settings_json = excluded.settings_json`)
          .run(JSON.stringify(settings));
      } else if (mutation.type === "message") {
        const messageId = this.#resolveMessageId(conversationId, target);
        if (!messageId) throw new Error("当前故事没有可写入的消息。");
        this.#writeMessageVariables(conversationId, messageId, next);
      } else {
        this.#writeConversationVariables(conversationId, next);
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}

/**
 * 把一次写入作用到当前值上。
 *
 * `insert` 只补缺失的键、`replace` 整体替换——这两种语义在卡片脚本里用途不同，
 * 混在一起会让"设置一个键"意外清空其它键。
 */
export function applyMutation(current: Json, mutation: CardVariableMutation): Json {
  const next: Json = { ...current };
  switch (mutation.action) {
    case "set":
      if (mutation.remove) delete next[mutation.key];
      else next[mutation.key] = mutation.value;
      return next;
    case "replace":
      return { ...mutation.values };
    case "insert":
      // 只补缺失：已有键保持原值。
      for (const [key, value] of Object.entries(mutation.values)) {
        if (!Object.hasOwn(next, key)) next[key] = value;
      }
      return next;
    case "delete": {
      if (mutation.subject === "key") {
        delete next[String(mutation.target)];
      } else {
        // 按值删除：同时删除字符串形式匹配的项，与"删除值为 x 的变量"的常见期望一致。
        for (const [key, value] of Object.entries(next)) {
          if (value === mutation.target || JSON.stringify(value) === JSON.stringify(mutation.target)) delete next[key];
        }
      }
      return next;
    }
  }
}
