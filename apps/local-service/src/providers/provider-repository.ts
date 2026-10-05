import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ProviderProfile, ProviderProfiles, ProviderSettings, ProviderTask, ProviderTaskAssignments, UpdateProviderSettings } from "@mycompanion/shared";
import { sameProviderCredentialScope } from "./provider-credential-scope.js";

interface ProfileRow { id: string; name: string; kind: ProviderSettings["kind"]; base_url: string; model: string;
  api_key_ciphertext: string | null; temperature: number; max_tokens: number; context_limit_tokens: number | null }
const defaults: ProviderSettings = { kind: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", hasApiKey: false,
  temperature: 0.8, maxTokens: 1024, contextLimitTokens: 32768 };

/** Named connections own ciphertext; task selection never moves a credential. */
export class ProviderRepository {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`CREATE TABLE IF NOT EXISTS provider_profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, base_url TEXT NOT NULL, model TEXT NOT NULL,
      api_key_ciphertext TEXT, temperature REAL NOT NULL, max_tokens INTEGER NOT NULL, context_limit_tokens INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, configured INTEGER NOT NULL DEFAULT 1
    ); CREATE TABLE IF NOT EXISTS provider_task_assignments (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), chat TEXT NOT NULL REFERENCES provider_profiles(id),
      summary TEXT REFERENCES provider_profiles(id), extraction TEXT REFERENCES provider_profiles(id), embedding TEXT REFERENCES provider_profiles(id)
    );`);
    if (!(database.prepare("PRAGMA table_info(provider_profiles)").all() as Array<{ name: string }>).some(column => column.name === "configured"))
      database.exec("ALTER TABLE provider_profiles ADD COLUMN configured INTEGER NOT NULL DEFAULT 1");
    if (!database.prepare("SELECT id FROM provider_profiles LIMIT 1").get()) {
      // Upgrade the former singleton once, preserving its encrypted value.
      const legacy = database.prepare("SELECT * FROM provider_settings WHERE singleton=1").get() as ProfileRow | undefined;
      const settings = legacy ? this.settings(legacy) : defaults;
      this.save("default", "默认连接", { ...settings, clearApiKey: false }, legacy?.api_key_ciphertext ?? undefined);
      if (!legacy) database.prepare("UPDATE provider_profiles SET configured=0 WHERE id='default'").run();
    }
    const first = database.prepare("SELECT id FROM provider_profiles ORDER BY rowid LIMIT 1").get() as { id: string };
    database.prepare("INSERT OR IGNORE INTO provider_task_assignments(singleton,chat) VALUES(1,?)").run(first.id);
  }
  private settings(row: ProfileRow): ProviderSettings {
    return { kind: row.kind, baseUrl: row.base_url, model: row.model, hasApiKey: Boolean(row.api_key_ciphertext), temperature: row.temperature,
      maxTokens: row.max_tokens, contextLimitTokens: row.context_limit_tokens ?? 32768 };
  }
  get(id: string): ProviderProfile | undefined {
    const row = this.database.prepare("SELECT * FROM provider_profiles WHERE id=?").get(id) as ProfileRow | undefined;
    return row ? { id: row.id, name: row.name, settings: this.settings(row) } : undefined;
  }
  list(): ProviderProfiles {
    return { profiles: (this.database.prepare("SELECT * FROM provider_profiles ORDER BY rowid").all() as unknown as ProfileRow[])
      .map(row => ({ id: row.id, name: row.name, settings: this.settings(row) })), tasks: this.assignments() };
  }
  assignments(): ProviderTaskAssignments {
    const row = this.database.prepare("SELECT chat,summary,extraction,embedding FROM provider_task_assignments WHERE singleton=1").get();
    return { ...(row as unknown as ProviderTaskAssignments) };
  }
  encryptedKey(id: string): string | undefined {
    return (this.database.prepare("SELECT api_key_ciphertext FROM provider_profiles WHERE id=?").get(id) as { api_key_ciphertext: string | null } | undefined)?.api_key_ciphertext ?? undefined;
  }
  isPlaceholder(id: string): boolean {
    return (this.database.prepare("SELECT configured FROM provider_profiles WHERE id=?").get(id) as { configured: number } | undefined)?.configured === 0;
  }
  isFresh(): boolean {
    return this.list().profiles.length === 1 && this.isPlaceholder(this.assignments().chat);
  }
  resolve(task: ProviderTask): { profileId: string; settings: ProviderSettings } | undefined {
    const assignments = this.assignments();
    const id = assignments[task] ?? (task === "embedding" ? undefined : assignments.chat);
    const profile = id ? this.get(id) : undefined;
    return profile ? { profileId: profile.id, settings: profile.settings } : undefined;
  }
  create(name: string, settings: UpdateProviderSettings, encrypted?: string): ProviderProfile {
    return this.save(randomUUID(), name, settings, encrypted);
  }
  save(id: string, name: string, settings: UpdateProviderSettings, encrypted?: string): ProviderProfile {
    const old = this.get(id);
    const previous = old && sameProviderCredentialScope(settings, old.settings) ? this.encryptedKey(id) : undefined;
    const key = settings.clearApiKey ? null : encrypted ?? previous ?? null;
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO provider_profiles(id,name,kind,base_url,model,api_key_ciphertext,temperature,max_tokens,context_limit_tokens,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,base_url=excluded.base_url,
      model=excluded.model,api_key_ciphertext=excluded.api_key_ciphertext,temperature=excluded.temperature,max_tokens=excluded.max_tokens,
      context_limit_tokens=excluded.context_limit_tokens,updated_at=excluded.updated_at,configured=1`)
      .run(id, name, settings.kind, settings.baseUrl, settings.model, key, settings.temperature, settings.maxTokens, settings.contextLimitTokens, now, now);
    return this.get(id)!;
  }
  assign(patch: { [Task in keyof ProviderTaskAssignments]?: ProviderTaskAssignments[Task] | undefined }): ProviderTaskAssignments {
    const next = { ...this.assignments(), ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) };
    for (const id of Object.values(next)) if (id !== null && !this.get(id)) throw new Error("任务关联的模型连接不存在。");
    this.database.prepare("UPDATE provider_task_assignments SET chat=?,summary=?,extraction=?,embedding=? WHERE singleton=1")
      .run(next.chat, next.summary, next.extraction, next.embedding);
    return next;
  }
  delete(id: string): "missing" | "last" | "deleted" {
    if (!this.get(id)) return "missing";
    const other = this.database.prepare("SELECT id FROM provider_profiles WHERE id<>? ORDER BY rowid LIMIT 1").get(id) as { id: string } | undefined;
    if (!other) return "last";
    const tasks = this.assignments();
    this.assign({ chat: tasks.chat === id ? other.id : tasks.chat, summary: tasks.summary === id ? null : tasks.summary,
      extraction: tasks.extraction === id ? null : tasks.extraction, embedding: tasks.embedding === id ? null : tasks.embedding });
    this.database.prepare("DELETE FROM provider_profiles WHERE id=?").run(id);
    return "deleted";
  }
  restore(state: ProviderProfiles, strategy: "skip" | "overwrite"): void {
    const fresh = this.isFresh();
    for (const profile of state.profiles) {
      if (strategy === "skip" && this.get(profile.id) && !this.isPlaceholder(profile.id)) continue;
      this.save(profile.id, profile.name, { ...profile.settings, clearApiKey: false });
    }
    // Profile ids are stable across export/restart. Keys never arrive from a backup.
    if (strategy === "overwrite" || fresh) this.assign(state.tasks);
  }
}
