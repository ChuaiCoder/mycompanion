import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { appliedMigrations, applyMigration, ensureMigrationTable } from "./migrations.js";

describe("schema_migrations", () => {
  it("creates the registry table idempotently", () => {
    const database = new DatabaseSync(":memory:");
    ensureMigrationTable(database);
    ensureMigrationTable(database);
    expect(appliedMigrations(database).size).toBe(0);
    database.close();
  });

  it("runs each version exactly once and records it", () => {
    const database = new DatabaseSync(":memory:");
    let calls = 0;
    applyMigration(database, 1, () => {
      calls++;
      database.exec("CREATE TABLE sample (id TEXT)");
    });
    applyMigration(database, 1, () => { calls++; });
    expect(calls).toBe(1);
    expect(appliedMigrations(database).has(1)).toBe(true);
    database.close();
  });

  it("rolls back a failed migration without recording the version", () => {
    const database = new DatabaseSync(":memory:");
    expect(() => applyMigration(database, 2, () => {
      database.exec("CREATE TABLE half_done (id TEXT)");
      throw new Error("boom");
    })).toThrow("boom");
    expect(appliedMigrations(database).has(2)).toBe(false);
    // 回滚后表不应残留，重试可以重新执行。
    let retried = 0;
    applyMigration(database, 2, () => { retried++; });
    expect(retried).toBe(1);
    expect(appliedMigrations(database).has(2)).toBe(true);
    database.close();
  });
});
