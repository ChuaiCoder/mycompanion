import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import type { MacroVariableChange } from "../prompt/prompt-macros.js";
import { MacroVariableConflictError } from "../prompt/macro-variable-conflict.js";

/**
 * 扩展设置 + 宏变量原子提交：extension_settings 单行表的读写，
 * 以及故事局部/全局宏变量的冲突检测与跨表原子写入。
 */
export class ExtensionSettingsRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly withTransaction: <T>(work: () => T) => T,
    /** 轻量元数据读取（单行）：冲突检测不需要整段消息历史。 */
    private readonly getChatMetadata: (id: string) => Record<string, unknown> | undefined,
  ) {}

  has(): boolean {
    return this.database.prepare("SELECT 1 FROM extension_settings WHERE singleton = 1").get() !== undefined;
  }

  get(): Record<string, unknown> {
    const row = this.database.prepare("SELECT settings_json FROM extension_settings WHERE singleton = 1").get() as { settings_json: string } | undefined;
    return row ? JSON.parse(row.settings_json) as Record<string, unknown> : { variables: { global: {} } };
  }

  save(settings: Record<string, unknown>): void {
    // A settings-only replacement must not erase independently saved QR sets.
    // An explicit field still permits backup/import overwrite and API deletion.
    const qrKey="__mycompanion_quick_reply_presets";
    if(!Object.hasOwn(settings,qrKey)){
      const existing=this.get();
      if(Object.hasOwn(existing,qrKey))settings={...settings,[qrKey]:existing[qrKey]};
    }
    this.database.prepare(`INSERT INTO extension_settings (singleton, settings_json) VALUES (1, ?)
      ON CONFLICT(singleton) DO UPDATE SET settings_json = excluded.settings_json`).run(JSON.stringify(settings));
  }

  commitMacroVariables(id: string | null, changes: MacroVariableChange[]): void {
    // Neutral-chat local variables have no durable story. Globals still belong
    // to the application and use the same atomic conflict check.
    if (id === null) changes = changes.filter(change => change.scope === "global");
    if (!changes.length) return;
    this.withTransaction(() => {
      const chatMetadata = id === null ? undefined : this.getChatMetadata(id);
      if (id !== null && !chatMetadata) throw new Error("宏变量所属的故事已不存在。");
      const metadata = chatMetadata ?? {}, settings = this.get();
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
        this.database.prepare("UPDATE conversations SET metadata_json = ? WHERE id = ?").run(JSON.stringify(metadata),id);
      }
      if (changes.some(change=>change.scope==="global")) {
        namespace.global=global;settings.variables=namespace;this.save(settings);
      }
    });
  }
}
