import type { DatabaseSync } from "node:sqlite";

/**
 * 版本化结构迁移的登记表。
 *
 * 版本表出现之前的迁移是各仓储里的探测式逻辑（PRAGMA 查列 → 条件 ALTER），
 * 它们是老库的基线，必须原样保留——老库缺哪一项是未知的，探测本身幂等。
 * 今后的结构变更一律走 applyMigration：只执行一次，事务内登记。
 */
export function ensureMigrationTable(database: DatabaseSync): void {
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
}

/** 已登记的迁移版本。 */
export function appliedMigrations(database: DatabaseSync): Set<number> {
  ensureMigrationTable(database);
  const rows = database.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>;
  return new Set(rows.map(row => row.version));
}

/**
 * 执行一个编号迁移：已登记的版本直接跳过；执行与登记在同一事务里，
 * 中途失败整体回滚、不留下半个迁移。
 */
export function applyMigration(database: DatabaseSync, version: number, migrate: () => void): void {
  if (appliedMigrations(database).has(version)) return;
  database.exec("SAVEPOINT apply_migration");
  try {
    migrate();
    database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(version, new Date().toISOString());
    database.exec("RELEASE SAVEPOINT apply_migration");
  } catch (error) {
    database.exec("ROLLBACK TO SAVEPOINT apply_migration; RELEASE SAVEPOINT apply_migration");
    throw error;
  }
}
