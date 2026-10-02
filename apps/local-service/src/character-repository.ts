import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

import type {
  CharacterDetail,
  CharacterListResponse,
  CharacterLorebookEntry,
  CharacterRegexRule,
  CharacterSummary,
} from "@mycompanion/shared";
import {
  parseCharacterCardDocument,
  parseCharacterLorebookEntries,
  type CharacterCard,
  type ParsedCharacterCard,
} from "@mycompanion/character-card";
import { parseCharacterRegexRules } from "./regex-engine.js";
import { CharacterAssetRepository } from "./character-assets.js";
import { replaceCharacterMainIcon } from "./character-archive.js";

export interface CharacterImport extends ParsedCharacterCard {
  sourcePng?: Uint8Array;
  avatar?: string;
}

export interface StoredCharacter {
  detail: CharacterDetail;
  rawCard: CharacterCard;
  sourcePng?: Uint8Array;
  assets?: Map<string, Buffer>;
}

export interface ImportResult {
  character: CharacterDetail;
  replayed: boolean;
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super("The idempotency key has already been used for different content.");
    this.name = "IdempotencyConflictError";
  }
}

export class CharacterImportTargetError extends Error {
  constructor(readonly statusCode: 404 | 409) {
    super(statusCode === 404 ? "要替换的角色不存在。" : "角色已在预览后被修改，请重新预览后再替换。");
  }
}

/** Incoming explicit values win; absent extension/unknown object fields survive. */
function mergeImportedCard(previous: unknown, incoming: unknown): unknown {
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  if (!object(previous) || !object(incoming)) return structuredClone(incoming);
  return Object.fromEntries([...new Set([...Object.keys(previous), ...Object.keys(incoming)])].map(key => [key,
    Object.hasOwn(incoming, key) ? mergeImportedCard(previous[key], incoming[key]) : structuredClone(previous[key])]));
}

interface CharacterRow {
  id: string;
  avatar: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_message: string;
  alternate_greetings_json: string;
  example_dialogue: string;
  system_prompt: string;
  post_history_instructions: string;
  creator_notes: string;
  tags_json: string;
  creator: string;
  character_version: string;
  source_format: CharacterDetail["sourceFormat"];
  source_version: string;
  raw_extensions_json: string;
  raw_card_json: string;
  source_png: Uint8Array | null;
  unknown_field_paths_json: string;
  lorebook_entry_count: number;
  regex_script_count: number;
  regex_enabled_json: string | null;
  lorebook_enabled_json: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface IdempotencyRow {
  request_hash: string;
  character_id: string;
}

function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("Stored character data is invalid.");
  }
  return parsed;
}

function parseEnabledIndexes(value: string | null): Set<number> {
  if (!value) return new Set();
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "number")) {
    return new Set();
  }
  return new Set(parsed);
}

function parseObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Stored character extensions are invalid.");
  }
  return parsed as Record<string, unknown>;
}

function regexRulesForRow(row: Pick<CharacterRow, "raw_extensions_json" | "regex_enabled_json">): CharacterRegexRule[] {
  const enabled = parseEnabledIndexes(row.regex_enabled_json);
  return parseCharacterRegexRules(parseObject(row.raw_extensions_json)).map((rule) => ({
    ...rule,
    disabled: !enabled.has(rule.order),
  }));
}

function lorebookEntriesForRow(row: Pick<CharacterRow, "raw_card_json" | "lorebook_enabled_json">): CharacterLorebookEntry[] {
  const enabled = parseEnabledIndexes(row.lorebook_enabled_json);
  const rawCard = JSON.parse(row.raw_card_json) as CharacterCard;
  return parseCharacterLorebookEntries(rawCard).map((entry) => ({
    ...entry,
    enabled: enabled.has(entry.index),
  }));
}

function rowToDetail(row: CharacterRow): CharacterDetail {
  const alternateGreetings = parseStringArray(row.alternate_greetings_json);
  const storedPreview = parseCharacterCardDocument(
    JSON.parse(row.raw_card_json) as unknown,
  ).preview;
  return {
    id: row.id,
    avatar: row.avatar,
    name: row.name,
    description: row.description,
    personality: row.personality,
    scenario: row.scenario,
    firstMessage: row.first_message,
    alternateGreetings,
    alternateGreetingsCount: alternateGreetings.length,
    exampleDialogue: row.example_dialogue,
    systemPrompt: row.system_prompt,
    postHistoryInstructions: row.post_history_instructions,
    creatorNotes: row.creator_notes,
    tags: parseStringArray(row.tags_json),
    creator: row.creator,
    characterVersion: row.character_version,
    sourceFormat: row.source_format,
    sourceVersion: row.source_version,
    rawExtensions: parseObject(row.raw_extensions_json),
    unknownFieldPaths: parseStringArray(row.unknown_field_paths_json),
    lorebookEntryCount: row.lorebook_entry_count,
    regexScriptCount: row.regex_script_count,
    lorebookEntries: storedPreview.lorebookEntries,
    regexScripts: storedPreview.regexScripts,
    regexEnabled: regexRulesForRow(row),
    lorebookEnabled: lorebookEntriesForRow(row),
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSummary(row: CharacterRow): CharacterSummary {
  return {
    id: row.id,
    avatar: row.avatar,
    name: row.name,
    description: row.description,
    tags: parseStringArray(row.tags_json),
    sourceFormat: row.source_format,
    sourceVersion: row.source_version,
    alternateGreetingsCount: parseStringArray(row.alternate_greetings_json).length,
    lorebookEntryCount: row.lorebook_entry_count,
    regexScriptCount: row.regex_script_count,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CharacterRepository {
  readonly assets: CharacterAssetRepository;
  readonly #database: DatabaseSync;
  readonly #ownsDatabase: boolean;

  constructor(database: string | DatabaseSync = ":memory:") {
    this.#ownsDatabase = typeof database === "string";
    this.#database = typeof database === "string" ? new DatabaseSync(database) : database;
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS characters (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        personality TEXT NOT NULL,
        scenario TEXT NOT NULL,
        first_message TEXT NOT NULL,
        alternate_greetings_json TEXT NOT NULL,
        example_dialogue TEXT NOT NULL,
        system_prompt TEXT NOT NULL,
        post_history_instructions TEXT NOT NULL,
        creator_notes TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        creator TEXT NOT NULL,
        character_version TEXT NOT NULL,
        source_format TEXT NOT NULL,
        source_version TEXT NOT NULL,
        raw_extensions_json TEXT NOT NULL,
        raw_card_json TEXT NOT NULL,
        source_png BLOB,
        unknown_field_paths_json TEXT NOT NULL,
        lorebook_entry_count INTEGER NOT NULL,
        regex_script_count INTEGER NOT NULL,
        regex_enabled_json TEXT,
        lorebook_enabled_json TEXT,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS character_import_idempotency (
        idempotency_key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS characters_created_at_idx
        ON characters(created_at DESC);
    `);
    // 旧库补齐世界书/正则启用状态列（导入后默认全停用）。
    const columns = new Set(
      (this.#database.prepare("PRAGMA table_info(characters)").all() as Array<{ name: string }>)
        .map((row) => row.name),
    );
    if (!columns.has("regex_enabled_json")) {
      this.#database.prepare(
        "ALTER TABLE characters ADD COLUMN regex_enabled_json TEXT",
      ).run();
    }
    if (!columns.has("lorebook_enabled_json")) {
      this.#database.prepare(
        "ALTER TABLE characters ADD COLUMN lorebook_enabled_json TEXT",
      ).run();
    }
    if (!columns.has("deleted_at")) {
      this.#database.prepare(
        "ALTER TABLE characters ADD COLUMN deleted_at TEXT",
      ).run();
    }
    if (!columns.has("avatar")) {
      this.#database.exec("ALTER TABLE characters ADD COLUMN avatar TEXT");
      this.#database.exec("UPDATE characters SET avatar = id || '.png'");
    }
    this.#database.exec("CREATE UNIQUE INDEX IF NOT EXISTS characters_avatar ON characters(avatar COLLATE NOCASE)");
    this.assets = new CharacterAssetRepository(this.#database);
  }

  close(): void {
    if (this.#ownsDatabase) {
      this.#database.close();
    }
  }

  list(options: { includeDeleted?: boolean } = {}): CharacterListResponse {
    // 默认隐藏软删除角色（FR-DATA-004）；回收站视图用 includeDeleted 列出。
    const rows = this.#database
      .prepare(
        options.includeDeleted
          ? "SELECT * FROM characters ORDER BY created_at DESC, id DESC"
          : "SELECT * FROM characters WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC",
      )
      .all() as unknown as CharacterRow[];
    // 列表只需要摘要字段；直接投影避免对每张卡重跑完整的 V2/V3 校验。
    const items = rows.map((row) => rowToSummary(row));
    return { items, total: items.length };
  }

  get(id: string): CharacterDetail | undefined {
    const row = this.#database
      .prepare("SELECT * FROM characters WHERE id = ?")
      .get(id) as CharacterRow | undefined;
    return row ? rowToDetail(row) : undefined;
  }

  getStored(id: string, includeAssets = false): StoredCharacter | undefined {
    const row = this.#database
      .prepare("SELECT * FROM characters WHERE id = ?")
      .get(id) as CharacterRow | undefined;
    if (!row) {
      return undefined;
    }

    const rawCard = JSON.parse(row.raw_card_json) as CharacterCard;
    return {
      detail: rowToDetail(row),
      rawCard,
      ...(row.source_png ? { sourcePng: new Uint8Array(row.source_png) } : {}),
      ...(includeAssets ? { assets: this.assets.getAll(id) } : {}),
    };
  }

  getByAvatar(avatar: string): StoredCharacter | undefined {
    const row = this.#database.prepare("SELECT id FROM characters WHERE avatar = ? COLLATE NOCASE AND deleted_at IS NULL").get(avatar) as { id: string } | undefined;
    return row ? this.getStored(row.id) : undefined;
  }

  findImportDuplicates(imported: CharacterImport) {
    const rows = this.#database.prepare("SELECT id, name, updated_at, raw_card_json FROM characters WHERE deleted_at IS NULL AND name = ? COLLATE NOCASE ORDER BY updated_at DESC, id")
      .all(imported.card.data.name) as unknown as Array<{ id: string; name: string; updated_at: string; raw_card_json: string }>;
    return rows.map(row => ({ id: row.id, name: row.name, updatedAt: row.updated_at,
      match: isDeepStrictEqual(JSON.parse(row.raw_card_json), imported.card) ? "exact" as const : "same-name" as const }));
  }

  allocateAvatar(base: string): string {
    let avatar = `${base}.png`, suffix = 1;
    while (this.#database.prepare("SELECT 1 FROM characters WHERE avatar = ? COLLATE NOCASE").get(avatar)) avatar = `${base}${suffix++}.png`;
    return avatar;
  }

  update(id: string, document: unknown, options: { sourcePng?: Uint8Array; regexFromCard?: boolean; lorebookFromCard?: boolean } = {}): StoredCharacter | undefined {
    const existing = this.getStored(id);
    if (!existing || existing.detail.deletedAt) return undefined;
    const parsed = parseCharacterCardDocument(document);
    const editedAssets = options.sourcePng && parsed.card.spec === "chara_card_v3"
      ? replaceCharacterMainIcon(parsed.card,this.assets.getAll(id),options.sourcePng) : undefined;
    const data = parsed.card.data;
    const oldRegex = parseCharacterRegexRules(existing.rawCard.data.extensions);
    const enabledRegex = parseCharacterRegexRules(data.extensions).filter(rule => {
      if (options.regexFromCard) return !rule.disabled;
      const previous = oldRegex.find(old => rule.id ? old.id === rule.id : old.order === rule.order);
      return previous ? existing.detail.regexEnabled.some(old => old.order === previous.order && !old.disabled) : !rule.disabled;
    }).map(rule => rule.order);
    const enabledLore = (data.character_book?.entries ?? []).flatMap((entry, index) => {
      const previousIndex = entry.id === undefined ? index : existing.rawCard.data.character_book?.entries.findIndex(old => old.id === entry.id) ?? -1;
      const previous = existing.detail.lorebookEnabled.find(old => old.index === previousIndex);
      return (options.lorebookFromCard || !previous ? entry.enabled : previous.enabled) ? [index] : [];
    });
    // Preserve row identity and refresh the cached speaker name in its stories.
    this.#database.exec("SAVEPOINT character_update");
    try {
    this.#database.prepare(`UPDATE characters SET
      name = ?, description = ?, personality = ?, scenario = ?, first_message = ?,
      alternate_greetings_json = ?, example_dialogue = ?, system_prompt = ?, post_history_instructions = ?,
      creator_notes = ?, tags_json = ?, creator = ?, character_version = ?, source_version = ?, source_format = ?,
      raw_extensions_json = ?, raw_card_json = ?, source_png = ?, unknown_field_paths_json = ?,
      lorebook_entry_count = ?, regex_script_count = ?, lorebook_enabled_json = ?, regex_enabled_json = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL`).run(
      data.name, data.description, data.personality, data.scenario, data.first_mes,
      JSON.stringify(data.alternate_greetings), data.mes_example, data.system_prompt, data.post_history_instructions,
      data.creator_notes, JSON.stringify(data.tags), data.creator, data.character_version, parsed.preview.specVersion,
      existing.detail.sourceFormat.endsWith("-charx") ? parsed.card.spec === "chara_card_v3" ? "ccv3-charx" : "ccv2-charx"
        : options.sourcePng || existing.sourcePng ? parsed.card.spec === "chara_card_v3" ? "ccv3-png" : "ccv2-png" : parsed.preview.format,
      JSON.stringify(data.extensions), JSON.stringify(parsed.card), options.sourcePng ?? existing.sourcePng ?? null,
      JSON.stringify(parsed.preview.unknownFieldPaths), parsed.preview.lorebookEntryCount, parsed.preview.regexScriptCount,
      JSON.stringify(enabledLore), JSON.stringify(enabledRegex), new Date(Math.max(Date.now(), Date.parse(existing.detail.updatedAt) + 1)).toISOString(), id,
    );
      if (editedAssets) this.assets.replace(id,editedAssets);
      if (this.#database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversations'").get()) {
        this.#database.prepare("UPDATE conversations SET character_name = ? WHERE character_id = ?").run(data.name, id);
      }
      this.#database.exec("RELEASE character_update");
    } catch (error) { this.#database.exec("ROLLBACK TO character_update; RELEASE character_update"); throw error; }
    return this.getStored(id);
  }

  // 启用/停用单条正则规则（FR-REGEX-007）。返回更新后的规则列表。
  setRegexRuleEnabled(characterId: string, order: number, enabled: boolean): CharacterRegexRule[] | undefined {
    const row = this.#database
      .prepare("SELECT raw_extensions_json, regex_enabled_json FROM characters WHERE id = ?")
      .get(characterId) as Pick<CharacterRow, "raw_extensions_json" | "regex_enabled_json"> | undefined;
    if (!row) return undefined;
    const rules = regexRulesForRow(row);
    const target = rules.find((rule) => rule.order === order);
    if (!target) return undefined;
    const enabledIndexes = rules
      .filter((rule) => (rule.order === order ? enabled : !rule.disabled))
      .map((rule) => rule.order);
    this.#database.prepare(
      "UPDATE characters SET regex_enabled_json = ?, updated_at = ? WHERE id = ?",
    ).run(JSON.stringify(enabledIndexes), new Date().toISOString(), characterId);
    const updated = this.get(characterId);
    return updated?.regexEnabled;
  }

  // 启用/停用单条世界书条目（FR-LORE-002）。返回更新后的条目列表。
  setLorebookEntryEnabled(characterId: string, index: number, enabled: boolean): CharacterLorebookEntry[] | undefined {
    const row = this.#database
      .prepare("SELECT raw_card_json, lorebook_enabled_json FROM characters WHERE id = ?")
      .get(characterId) as Pick<CharacterRow, "raw_card_json" | "lorebook_enabled_json"> | undefined;
    if (!row) return undefined;
    const entries = lorebookEntriesForRow(row);
    const target = entries.find((entry) => entry.index === index);
    if (!target) return undefined;
    const enabledIndexes = entries
      .filter((entry) => (entry.index === index ? enabled : entry.enabled))
      .map((entry) => entry.index);
    this.#database.prepare(
      "UPDATE characters SET lorebook_enabled_json = ?, updated_at = ? WHERE id = ?",
    ).run(JSON.stringify(enabledIndexes), new Date().toISOString(), characterId);
    return this.get(characterId)?.lorebookEnabled;
  }

  // 一次性启用/停用角色全部世界书条目。
  setAllLorebookEntriesEnabled(characterId: string, enabled: boolean): CharacterLorebookEntry[] | undefined {
    const row = this.#database
      .prepare("SELECT raw_card_json, lorebook_enabled_json FROM characters WHERE id = ?")
      .get(characterId) as Pick<CharacterRow, "raw_card_json" | "lorebook_enabled_json"> | undefined;
    if (!row) return undefined;
    const entries = lorebookEntriesForRow(row);
    const enabledIndexes = enabled ? entries.map((entry) => entry.index) : [];
    this.#database.prepare(
      "UPDATE characters SET lorebook_enabled_json = ?, updated_at = ? WHERE id = ?",
    ).run(JSON.stringify(enabledIndexes), new Date().toISOString(), characterId);
    return this.get(characterId)?.lorebookEnabled;
  }

  // 一次性启用/停用角色全部正则规则。
  setAllRegexRulesEnabled(characterId: string, enabled: boolean): CharacterRegexRule[] | undefined {
    const row = this.#database
      .prepare("SELECT raw_extensions_json, regex_enabled_json FROM characters WHERE id = ?")
      .get(characterId) as Pick<CharacterRow, "raw_extensions_json" | "regex_enabled_json"> | undefined;
    if (!row) return undefined;
    const rules = regexRulesForRow(row);
    const enabledIndexes = enabled ? rules.map((rule) => rule.order) : [];
    this.#database.prepare(
      "UPDATE characters SET regex_enabled_json = ?, updated_at = ? WHERE id = ?",
    ).run(JSON.stringify(enabledIndexes), new Date().toISOString(), characterId);
    return this.get(characterId)?.regexEnabled;
  }

  // 软删除（FR-DATA-004 默认）：标记 deleted_at，关联故事/记忆随之隐藏但保留，可恢复。
  softDelete(id: string): boolean {
    const result = this.#database
      .prepare("UPDATE characters SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
      .run(new Date().toISOString(), new Date().toISOString(), id);
    return result.changes > 0;
  }

  // 恢复软删除的角色（FR-DATA-004）。
  restoreDeleted(id: string): boolean {
    const result = this.#database
      .prepare("UPDATE characters SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL")
      .run(new Date().toISOString(), id);
    return result.changes > 0;
  }

  // 永久删除（FR-DATA-004，需再次确认）：级联删除对话、消息、记忆、摘要与设置。
  permanentDelete(id: string): boolean {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#database.prepare("DELETE FROM characters WHERE id = ?").run(id);
      this.#database.exec("COMMIT");
      return result.changes > 0;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  // 回收站：软删除角色的轻量列表。
  listDeleted(): CharacterSummary[] {
    const rows = this.#database
      .prepare("SELECT * FROM characters WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC")
      .all() as unknown as CharacterRow[];
    return rows.map((row) => rowToSummary(row));
  }

  // 全量备份角色（FR-DATA-003）：原始卡 + 启用状态 + 头像，含软删除角色。
  listForBackup(): Array<{
    id: string;
    avatar?: string;
    rawCard: Record<string, unknown>;
    sourcePngBase64?: string;
    assets?: Record<string,string>;
    sourceFormat?: CharacterDetail["sourceFormat"];
    regexEnabledIndexes: number[];
    lorebookEnabledIndexes: number[];
    createdAt: string;
    updatedAt: string;
  }> {
    const rows = this.#database
      .prepare("SELECT * FROM characters ORDER BY created_at, id")
      .all() as unknown as CharacterRow[];
    return rows.map((row) => ({
      id: row.id,
      avatar: row.avatar,
      rawCard: JSON.parse(row.raw_card_json) as Record<string, unknown>,
      sourceFormat: row.source_format,
      ...(row.source_png ? { sourcePngBase64: Buffer.from(row.source_png).toString("base64") } : {}),
      ...this.assets.backupFields(row.id),
      regexEnabledIndexes: [...parseEnabledIndexes(row.regex_enabled_json)].sort((a, b) => a - b),
      lorebookEnabledIndexes: [...parseEnabledIndexes(row.lorebook_enabled_json)].sort((a, b) => a - b),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  // Restore raw fields and their normalized projection together.
  restoreCharacter(entry: {
    id: string;
    avatar?: string | undefined;
    rawCard: Record<string, unknown>;
    sourcePngBase64?: string | undefined;
    assets?: Record<string,string> | undefined;
    sourceFormat?: CharacterDetail["sourceFormat"] | undefined;
    regexEnabledIndexes: number[];
    lorebookEnabledIndexes: number[];
    createdAt: string;
    updatedAt: string;
  }): void {
    const parsed = parseCharacterCardDocument(entry.rawCard);
    const data = parsed.card.data;
    const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
    const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
    // A complete backup may restore this card inside its own SQLite transaction.
    this.#database.exec("SAVEPOINT restore_character");
    try {
      this.#database.prepare(`
        INSERT INTO characters (
          id, avatar, name, description, personality, scenario, first_message,
          alternate_greetings_json, example_dialogue, system_prompt,
          post_history_instructions, creator_notes, tags_json, creator,
          character_version, source_format, source_version,
          raw_extensions_json, raw_card_json, source_png,
          unknown_field_paths_json, lorebook_entry_count, regex_script_count,
          lorebook_enabled_json, regex_enabled_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          avatar = excluded.avatar,
          name = excluded.name,
          description = excluded.description,
          personality = excluded.personality,
          scenario = excluded.scenario,
          first_message = excluded.first_message,
          alternate_greetings_json = excluded.alternate_greetings_json,
          example_dialogue = excluded.example_dialogue,
          system_prompt = excluded.system_prompt,
          post_history_instructions = excluded.post_history_instructions,
          creator_notes = excluded.creator_notes,
          tags_json = excluded.tags_json,
          creator = excluded.creator,
          character_version = excluded.character_version,
          source_format = excluded.source_format,
          source_version = excluded.source_version,
          unknown_field_paths_json = excluded.unknown_field_paths_json,
          lorebook_entry_count = excluded.lorebook_entry_count,
          regex_script_count = excluded.regex_script_count,
          raw_extensions_json = excluded.raw_extensions_json,
          raw_card_json = excluded.raw_card_json,
          source_png = excluded.source_png,
          lorebook_enabled_json = excluded.lorebook_enabled_json,
          regex_enabled_json = excluded.regex_enabled_json,
          updated_at = excluded.updated_at
      `).run(
        entry.id,
        entry.avatar ?? this.get(entry.id)?.avatar ?? `${entry.id}.png`,
        str(data?.name, "未知角色"),
        str(data?.description),
        str(data?.personality),
        str(data?.scenario),
        str(data?.first_mes),
        JSON.stringify(list(data?.alternate_greetings)),
        str(data?.mes_example),
        str(data?.system_prompt),
        str(data?.post_history_instructions),
        str(data?.creator_notes),
        JSON.stringify(list(data?.tags)),
        str(data?.creator, "未知"),
        str(data?.character_version, "1.0"),
        entry.sourceFormat ?? (entry.assets ? parsed.card.spec === "chara_card_v3" ? "ccv3-charx" : "ccv2-charx"
          : entry.sourcePngBase64 ? parsed.card.spec === "chara_card_v3" ? "ccv3-png" : "ccv2-png" : parsed.preview.format),
        parsed.preview.specVersion,
        JSON.stringify((data?.extensions ?? {}) as Record<string, unknown>),
        JSON.stringify(parsed.card),
        entry.sourcePngBase64 ? Buffer.from(entry.sourcePngBase64, "base64") : null,
        JSON.stringify(parsed.preview.unknownFieldPaths),
        parsed.preview.lorebookEntryCount,
        parsed.preview.regexScriptCount,
        JSON.stringify(entry.lorebookEnabledIndexes),
        JSON.stringify(entry.regexEnabledIndexes),
        entry.createdAt,
        entry.updatedAt,
      );
      this.assets.restore(entry.id,entry.assets);
      this.#database.exec("RELEASE SAVEPOINT restore_character");
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK TO SAVEPOINT restore_character");
        this.#database.exec("RELEASE SAVEPOINT restore_character");
      } catch { /* SQLite may already have rolled back after a disk/IO failure. */ }
      throw error;
    }
  }

  // 该角色的原始卡 + 启用状态（备份冲突判定用，FR-DATA-003）。
  getBackupEntry(id: string): {
    avatar?: string;
    rawCard: Record<string, unknown>;
    sourcePngBase64?: string;
    assets?: Record<string,string>;
    sourceFormat?: CharacterDetail["sourceFormat"];
    regexEnabledIndexes: number[];
    lorebookEnabledIndexes: number[];
  } | undefined {
    const row = this.#database
      .prepare("SELECT * FROM characters WHERE id = ?")
      .get(id) as CharacterRow | undefined;
    if (!row) return undefined;
    return {
      avatar: row.avatar,
      rawCard: JSON.parse(row.raw_card_json) as Record<string, unknown>,
      sourceFormat: row.source_format,
      ...(row.source_png ? { sourcePngBase64: Buffer.from(row.source_png).toString("base64") } : {}),
      ...this.assets.backupFields(row.id),
      regexEnabledIndexes: [...parseEnabledIndexes(row.regex_enabled_json)].sort((a, b) => a - b),
      lorebookEnabledIndexes: [...parseEnabledIndexes(row.lorebook_enabled_json)].sort((a, b) => a - b),
    };
  }

  existsById(id: string): boolean {
    return this.#database
      .prepare("SELECT 1 FROM characters WHERE id = ?")
      .get(id) !== undefined;
  }

  import(
    imported: CharacterImport,
    requestHash: string,
    idempotencyKey?: string,
    options: { mode?: "copy" | "replace"; targetId?: string | undefined; expectedUpdatedAt?: string | undefined } = {},
  ): ImportResult {
    if (idempotencyKey) {
      const existing = this.#database
        .prepare(
          "SELECT request_hash, character_id FROM character_import_idempotency WHERE idempotency_key = ?",
        )
        .get(idempotencyKey) as IdempotencyRow | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new IdempotencyConflictError();
        }
        const character = this.get(existing.character_id);
        if (!character) {
          throw new Error("The idempotency record refers to a missing character.");
        }
        return { character, replayed: true };
      }
    }

    if (options.mode === "replace") {
      const previous = options.targetId ? this.getStored(options.targetId) : undefined;
      if (!previous || previous.detail.deletedAt) throw new CharacterImportTargetError(404);
      if (previous.detail.updatedAt !== options.expectedUpdatedAt) throw new CharacterImportTargetError(409);
      this.#database.exec("SAVEPOINT character_import_replace");
      try {
        const updated = this.update(previous.detail.id, mergeImportedCard(previous.rawCard, imported.card),
          imported.sourcePng ? { sourcePng: imported.sourcePng } : {});
        if (!updated) throw new CharacterImportTargetError(404);
        if (imported.assets) {
          this.assets.replace(updated.detail.id, imported.assets);
          this.#database.prepare("UPDATE characters SET source_format=? WHERE id=?").run(imported.preview.format,updated.detail.id);
          updated.detail.sourceFormat = imported.preview.format;
        }
        if (idempotencyKey) this.#database.prepare("INSERT INTO character_import_idempotency (idempotency_key, request_hash, character_id) VALUES (?, ?, ?)")
          .run(idempotencyKey, requestHash, updated.detail.id);
        this.#database.exec("RELEASE character_import_replace");
        return { character: updated.detail, replayed: false };
      } catch (error) {
        try { this.#database.exec("ROLLBACK TO character_import_replace; RELEASE character_import_replace"); } catch { /* Preserve original SQLite failure. */ }
        throw error;
      }
    }
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const data = imported.card.data;
    const detail: CharacterDetail = {
      id,
      avatar: imported.avatar ?? `${id}.png`,
      name: data.name,
      description: data.description,
      personality: data.personality,
      scenario: data.scenario,
      firstMessage: data.first_mes,
      alternateGreetings: [...data.alternate_greetings],
      alternateGreetingsCount: data.alternate_greetings.length,
      exampleDialogue: data.mes_example,
      systemPrompt: data.system_prompt,
      postHistoryInstructions: data.post_history_instructions,
      creatorNotes: data.creator_notes,
      tags: [...data.tags],
      creator: data.creator,
      characterVersion: data.character_version,
      sourceFormat: imported.assets ? imported.preview.format
        : imported.sourcePng ? imported.card.spec === "chara_card_v3" ? "ccv3-png" : "ccv2-png" : imported.preview.format,
      sourceVersion: imported.preview.specVersion,
      rawExtensions: data.extensions,
      unknownFieldPaths: [...imported.preview.unknownFieldPaths],
      lorebookEntryCount: imported.preview.lorebookEntryCount,
      regexScriptCount: imported.preview.regexScriptCount,
      lorebookEntries: imported.preview.lorebookEntries,
      regexScripts: imported.preview.regexScripts,
      // 导入的规则默认全部停用，等待用户在角色页显式启用（FR-REGEX-001/007）。
      regexEnabled: parseCharacterRegexRules(data.extensions).map((rule) => ({ ...rule, disabled: true })),
      // 导入的世界书条目同样默认停用（FR-LORE-001/002）。
      lorebookEnabled: parseCharacterLorebookEntries(imported.card),
      // 新导入的角色未删除（deleted_at 列默认 NULL）。
      deletedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.#database.exec("SAVEPOINT character_import");
    try {
      this.#database
        .prepare(`
          INSERT INTO characters (
            id, avatar, name, description, personality, scenario, first_message,
            alternate_greetings_json, example_dialogue, system_prompt,
            post_history_instructions, creator_notes, tags_json, creator,
            character_version, source_format, source_version,
            raw_extensions_json, raw_card_json, source_png,
            unknown_field_paths_json, lorebook_entry_count, regex_script_count,
            lorebook_enabled_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          detail.id,
          detail.avatar!,
          detail.name,
          detail.description,
          detail.personality,
          detail.scenario,
          detail.firstMessage,
          JSON.stringify(detail.alternateGreetings),
          detail.exampleDialogue,
          detail.systemPrompt,
          detail.postHistoryInstructions,
          detail.creatorNotes,
          JSON.stringify(detail.tags),
          detail.creator,
          detail.characterVersion,
          detail.sourceFormat,
          detail.sourceVersion,
          JSON.stringify(detail.rawExtensions),
          JSON.stringify(imported.card),
          imported.sourcePng ? Buffer.from(imported.sourcePng) : null,
          JSON.stringify(detail.unknownFieldPaths),
          detail.lorebookEntryCount,
          detail.regexScriptCount,
          // 导入时全部停用：启用状态集合为空数组。
          JSON.stringify([]),
          detail.createdAt,
          detail.updatedAt,
        );

      if (imported.assets) this.assets.replace(detail.id,imported.assets);
      if (idempotencyKey) {
        this.#database
          .prepare(
            "INSERT INTO character_import_idempotency (idempotency_key, request_hash, character_id) VALUES (?, ?, ?)",
          )
          .run(idempotencyKey, requestHash, detail.id);
      }
      this.#database.exec("RELEASE character_import");
    } catch (error) {
      this.#database.exec("ROLLBACK TO character_import; RELEASE character_import");
      throw error;
    }

    return { character: detail, replayed: false };
  }
}
