import type { DatabaseSync } from "node:sqlite";
import type { InstalledPlugin, PluginListResponse, PluginManifest } from "@mycompanion/shared";

/** 声明式插件 CRUD：plugins 表的读写（安装、启停、删除、清单查询）。 */
interface PluginRow {
  manifest_json: string;
  enabled: number;
  installed_at: string;
}

export class PluginRepository {
  constructor(private readonly database: DatabaseSync) {}

  list(): PluginListResponse {
    const rows = this.database
      .prepare("SELECT manifest_json, enabled, installed_at FROM plugins ORDER BY installed_at DESC")
      .all() as unknown as PluginRow[];
    const items = rows.map((row) => ({
      ...(JSON.parse(row.manifest_json) as PluginManifest),
      enabled: Boolean(row.enabled),
      installedAt: row.installed_at,
    }));
    return { items, total: items.length };
  }

  install(manifest: PluginManifest): InstalledPlugin {
    const installedAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO plugins (id, manifest_json, enabled, installed_at)
      VALUES (?, ?, 0, ?)
      ON CONFLICT(id) DO UPDATE SET manifest_json = excluded.manifest_json, enabled = 0, installed_at = excluded.installed_at
    `).run(manifest.id, JSON.stringify(manifest), installedAt);
    return { ...manifest, enabled: false, installedAt };
  }

  get(id: string): InstalledPlugin | undefined {
    const row = this.database
      .prepare("SELECT manifest_json, enabled, installed_at FROM plugins WHERE id = ?")
      .get(id) as PluginRow | undefined;
    if (!row) return undefined;
    return {
      ...(JSON.parse(row.manifest_json) as PluginManifest),
      enabled: Boolean(row.enabled),
      installedAt: row.installed_at,
    };
  }

  setEnabled(id: string, enabled: boolean): InstalledPlugin | undefined {
    const result = this.database
      .prepare("UPDATE plugins SET enabled = ? WHERE id = ?")
      .run(enabled ? 1 : 0, id);
    if (result.changes === 0) return undefined;
    return this.get(id);
  }

  delete(id: string): boolean {
    return this.database.prepare("DELETE FROM plugins WHERE id = ?").run(id).changes > 0;
  }

  active(): InstalledPlugin[] {
    return this.list().items.filter((plugin) => plugin.enabled);
  }
}
