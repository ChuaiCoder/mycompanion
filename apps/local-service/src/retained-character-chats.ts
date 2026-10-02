import type { DatabaseSync } from "node:sqlite";
import { retainedCharacterChatsSchema, type CharacterDetail, type RetainedCharacterChats } from "@mycompanion/shared";
import type { RuntimeRepository } from "./runtime-repository.js";

/** Detached, avatar-keyed histories reuse the application's backup projection.
 * Deleting the actual character still triggers normal foreign-key cascades. */
export class RetainedCharacterChatsRepository {
  constructor(private readonly database: DatabaseSync, private readonly runtime: RuntimeRepository) {
    database.exec(`CREATE TABLE IF NOT EXISTS retained_character_chats (
      avatar TEXT PRIMARY KEY COLLATE NOCASE, data_json TEXT NOT NULL
    )`);
  }

  get(avatar: string): RetainedCharacterChats | undefined {
    const row = this.database.prepare("SELECT data_json FROM retained_character_chats WHERE avatar = ?").get(avatar) as { data_json: string } | undefined;
    return row ? retainedCharacterChatsSchema.parse(JSON.parse(row.data_json)) : undefined;
  }

  list(): RetainedCharacterChats[] {
    return (this.database.prepare("SELECT data_json FROM retained_character_chats ORDER BY avatar").all() as { data_json: string }[])
      .map(row => retainedCharacterChatsSchema.parse(JSON.parse(row.data_json)));
  }

  save(value: RetainedCharacterChats): void {
    const entry = retainedCharacterChatsSchema.parse(value);
    this.database.prepare(`INSERT INTO retained_character_chats (avatar, data_json) VALUES (?, ?)
      ON CONFLICT(avatar) DO UPDATE SET data_json = excluded.data_json`).run(entry.avatar, JSON.stringify(entry));
  }

  removeCharacter(id: string, avatar: string, deleteChats: boolean): boolean {
    this.database.exec("SAVEPOINT retained_character_delete");
    try {
      const exists = this.database.prepare("SELECT 1 FROM characters WHERE id = ? AND avatar = ? COLLATE NOCASE AND deleted_at IS NULL").get(id, avatar);
      if (exists) {
        if (!deleteChats) {
          const conversations = this.runtime.listConversationsForBackup().filter(item => item.characterId === id);
          const ids = new Set(conversations.map(item => item.id));
          this.save({ avatar, characterId: id, conversations,
            memories: this.runtime.listMemoriesForBackup().filter(item => ids.has(item.conversationId)),
            stageSummaries: this.runtime.listStageSummariesForBackup().filter(item => ids.has(item.conversationId)),
            conversationSettings: this.runtime.listConversationSettingsForBackup().filter(item => ids.has(item.conversationId)),
          });
        } else this.database.prepare("DELETE FROM retained_character_chats WHERE avatar = ?").run(avatar);
        this.database.prepare("DELETE FROM characters WHERE id = ?").run(id);
      }
      this.database.exec("RELEASE retained_character_delete");
      return !!exists;
    } catch (error) {
      this.database.exec("ROLLBACK TO retained_character_delete; RELEASE retained_character_delete"); throw error;
    }
  }

  conflicts(entry: RetainedCharacterChats): string[] {
    const errors: string[] = [];
    for (const chat of entry.conversations) {
      if (this.runtime.conversationExists(chat.id)) errors.push(`故事标识已存在：${chat.id}`);
      for (const message of chat.messages) {
        if (this.database.prepare("SELECT 1 FROM messages WHERE id = ? AND branch_id = ?").get(message.id, message.branchId)) errors.push(`消息标识已存在：${message.id}`);
      }
    }
    for (const memory of entry.memories) if (this.runtime.memoryExists(memory.id)) errors.push(`记忆标识已存在：${memory.id}`);
    return errors;
  }

  createWithRetainedChats(avatar: string, create: () => CharacterDetail): CharacterDetail {
    this.database.exec("SAVEPOINT retained_character_create");
    try {
      const entry = this.get(avatar);
      const errors = entry ? this.conflicts(entry) : [];
      if (errors.length) throw Object.assign(new Error(errors.join("；")), { statusCode: 409 });
      const character = create();
      if (entry) {
        for (const chat of entry.conversations) this.runtime.restoreConversation({ ...chat, characterId: character.id, characterName: character.name });
        for (const memory of entry.memories) this.runtime.upsertMemoryForBackup({ ...memory, characterId: character.id });
        for (const summary of entry.stageSummaries) this.runtime.restoreStageSummary(summary);
        for (const setting of entry.conversationSettings) this.runtime.restoreConversationSetting(setting);
        this.database.prepare("DELETE FROM retained_character_chats WHERE avatar = ?").run(avatar);
      }
      this.database.exec("RELEASE retained_character_create");
      return character;
    } catch (error) {
      this.database.exec("ROLLBACK TO retained_character_create; RELEASE retained_character_create"); throw error;
    }
  }
}
