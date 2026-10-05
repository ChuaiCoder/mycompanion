import type { DatabaseSync } from "node:sqlite";
import { worldInfoDocumentSchema, worldInfoSettingsSchema, type WorldInfoDocument, type WorldInfoSettings } from "@mycompanion/shared";

/** Named books and selection settings belong to the application's own database. */
export class WorldInfoRepository {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`CREATE TABLE IF NOT EXISTS world_info_books (
      name TEXT PRIMARY KEY, data_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS world_info_settings (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), settings_json TEXT NOT NULL
    );`);
  }

  names(): string[] {
    return (this.database.prepare("SELECT name FROM world_info_books ORDER BY name COLLATE NOCASE, name").all() as { name: string }[]).map(row => row.name);
  }

  get(name: string): WorldInfoDocument | undefined {
    const row = this.database.prepare("SELECT data_json FROM world_info_books WHERE name = ?").get(name) as { data_json: string } | undefined;
    return row ? JSON.parse(row.data_json) as WorldInfoDocument : undefined;
  }

  save(name: string, document: WorldInfoDocument): void {
    if (!name.trim() || name.includes("\0")) throw new Error("World info requires a nonempty name without NUL characters.");
    const data = worldInfoDocumentSchema.parse(document);
    this.database.prepare(`INSERT INTO world_info_books(name, data_json) VALUES (?, ?)
      ON CONFLICT(name) DO UPDATE SET data_json = excluded.data_json`).run(name, JSON.stringify(data));
  }

  delete(name: string): boolean {
    // A single transaction prevents a deleted book remaining globally selected.
    this.database.exec("SAVEPOINT delete_world_info");
    try {
      const removed = this.database.prepare("DELETE FROM world_info_books WHERE name = ?").run(name).changes > 0;
      if (removed) {
        const settings = this.settings();
        settings.world_info.globalSelect = settings.world_info.globalSelect.filter(item => item !== name);
        for (const binding of settings.world_info.charLore) binding.extraBooks = binding.extraBooks.filter(item => item !== name);
        this.saveSettings(settings);
      }
      this.database.exec("RELEASE delete_world_info");
      return removed;
    } catch (error) {
      this.database.exec("ROLLBACK TO delete_world_info; RELEASE delete_world_info");
      throw error;
    }
  }

  hasSettings(): boolean {
    return this.database.prepare("SELECT 1 FROM world_info_settings WHERE singleton = 1").get() !== undefined;
  }

  settings(): WorldInfoSettings {
    const row = this.database.prepare("SELECT settings_json FROM world_info_settings WHERE singleton = 1").get() as { settings_json: string } | undefined;
    return worldInfoSettingsSchema.parse(row ? JSON.parse(row.settings_json) : {});
  }

  saveSettings(settings: WorldInfoSettings): void {
    this.database.prepare(`INSERT INTO world_info_settings(singleton, settings_json) VALUES (1, ?)
      ON CONFLICT(singleton) DO UPDATE SET settings_json = excluded.settings_json`).run(JSON.stringify(worldInfoSettingsSchema.parse(settings)));
  }
}
