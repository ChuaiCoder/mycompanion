import { DatabaseSync } from "node:sqlite";
import git from "isomorphic-git";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodePlugin } from "@mycompanion/shared";
import { buildApp } from "./app.js";
import { checkCodePluginUpdate } from "./code-plugin-git-state.js";
import * as repository from "./code-plugin-repository.js";
import { RuntimeRepository } from "./runtime-repository.js";
import { apps } from "./test-helpers.js";

const first = "a".repeat(40), second = "b".repeat(40);
function fixture(revision = first, ref = "refs/heads/main"): repository.CodePluginRepository {
  return { plugin: { kind: "sillytavern-js", id: "update-fixture", displayName: "Update fixture",
    version: revision === first ? "1" : "2", author: "Fixture", license: "MIT",
    sourceUrl: "https://example.invalid/update-fixture.git", sourceRef: ref, sourceRevision: revision,
    js: "index.js", css: null, fileCount: 1, totalBytes: revision.length, warnings: [] },
    manifest: { display_name: "Update fixture", js: "index.js" }, files: new Map([["index.js", Buffer.from(revision)]]) };
}
const installed = (ref = "refs/heads/main"): CodePlugin => ({ ...fixture(first, ref).plugin, enabled: true, installedAt: "2026-10-01T00:00:00.000Z" });
afterEach(() => vi.restoreAllMocks());

describe("read-only remote Git status", () => {
  it("distinguishes full branch/tag refs and uses the commit behind an annotated tag", async () => {
    vi.spyOn(git, "listServerRefs").mockResolvedValue([
      { ref: "HEAD", oid: first, target: "refs/heads/main" },
      { ref: "refs/heads/main", oid: first },
      { ref: "refs/tags/main", oid: "c".repeat(40), peeled: second },
    ]);
    expect(await checkCodePluginUpdate(installed())).toMatchObject({ state: "up_to_date", remoteRevision: first, defaultRef: "refs/heads/main" });
    expect(await checkCodePluginUpdate(installed("refs/tags/main"))).toMatchObject({ state: "update_available", remoteRevision: second });
  });
  it("reads old short branch names and resolves legacy HEAD using the advertised default", async () => {
    vi.spyOn(git, "listServerRefs").mockResolvedValue([
      { ref: "HEAD", oid: first, target: "refs/heads/main" }, { ref: "refs/heads/main", oid: first },
    ]);
    for (const ref of ["main", "HEAD"]) expect((await checkCodePluginUpdate(installed(ref))).state).toBe("up_to_date");
  });
  it("does not fall back to default when an installed branch has been deleted", async () => {
    vi.spyOn(git, "listServerRefs").mockResolvedValue([{ ref: "refs/heads/main", oid: first }]);
    expect(await checkCodePluginUpdate(installed("refs/heads/removed"))).toMatchObject({ state: "ref_missing", remoteRevision: null });
  });
  it("rejects network failures rather than reporting a false up-to-date result", async () => {
    vi.spyOn(git, "listServerRefs").mockRejectedValue(new Error("private remote response"));
    await expect(checkCodePluginUpdate(installed())).rejects.toThrow("无法检查扩展更新");
  });
});

describe("installed extension updates", () => {
  async function setup() {
    const app = buildApp(); apps.push(app);
    const download = vi.spyOn(repository, "installCodePluginFromUrl").mockResolvedValue(fixture());
    expect((await app.inject({ method: "POST", url: "/api/code-plugins/install-url", payload: { url: fixture().plugin.sourceUrl } })).statusCode).toBe(201);
    await app.inject({ method: "PUT", url: "/api/code-plugins/update-fixture/enabled", payload: { enabled: true } });
    await app.inject({ method: "PUT", url: "/api/code-plugins/update-fixture/contributions", payload: { systemPrompt: "User configuration", commands: [] } });
    return { app, download };
  }
  it("updates the installed ref and retains enabled state, installation time and configuration", async () => {
    const { app, download } = await setup();
    const before = (await app.inject({ method: "GET", url: "/api/backup" })).json().codePlugins[0];
    download.mockResolvedValueOnce(fixture(second));
    const result = await app.inject({ method: "POST", url: "/api/code-plugins/update-fixture/update", payload: { expectedRevision: first } });
    expect(result.statusCode).toBe(200);
    expect(download).toHaveBeenLastCalledWith(fixture().plugin.sourceUrl, "refs/heads/main");
    expect(result.json()).toMatchObject({ enabled: true, sourceRevision: second, installedAt: before.installedAt });
    const after = (await app.inject({ method: "GET", url: "/api/backup" })).json().codePlugins[0];
    expect(after.contributions).toEqual(before.contributions);
  });
  it("switches to an explicitly selected full tag ref", async () => {
    const { app, download } = await setup(); download.mockResolvedValueOnce(fixture(second, "refs/tags/v2"));
    const result = await app.inject({ method: "POST", url: "/api/code-plugins/update-fixture/update", payload: { expectedRevision: first, branch: "refs/tags/v2" } });
    expect(result.statusCode).toBe(200); expect(result.json().sourceRef).toBe("refs/tags/v2");
    expect(download).toHaveBeenLastCalledWith(fixture().plugin.sourceUrl, "refs/tags/v2");
  });
  it("rejects a stale expected revision before downloading", async () => {
    const { app, download } = await setup(); download.mockClear();
    expect((await app.inject({ method: "POST", url: "/api/code-plugins/update-fixture/update", payload: { expectedRevision: second } })).statusCode).toBe(409);
    expect(download).not.toHaveBeenCalled();
  });
  it("keeps installed assets on a failed clone", async () => {
    const { app, download } = await setup(); download.mockRejectedValueOnce(new repository.CodePluginRepositoryError("网络失败"));
    expect((await app.inject({ method: "POST", url: "/api/code-plugins/update-fixture/update", payload: { expectedRevision: first } })).statusCode).toBe(422);
    expect((await app.inject({ method: "GET", url: "/scripts/extensions/third-party/update-fixture/index.js" })).body).toBe(first);
  });
  it("does not resurrect an uninstalled plugin when a download completes late", async () => {
    const { app, download } = await setup();
    download.mockImplementationOnce(async () => {
      await app.inject({ method: "DELETE", url: "/api/code-plugins/update-fixture" }); return fixture(second);
    });
    expect((await app.inject({ method: "POST", url: "/api/code-plugins/update-fixture/update", payload: { expectedRevision: first } })).statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: "/api/code-plugins" })).json().total).toBe(0);
  });
  it("does not overwrite another completed update", async () => {
    const { app, download } = await setup();
    download.mockImplementationOnce(async () => {
      download.mockResolvedValueOnce(fixture(second));
      await app.inject({ method: "POST", url: "/api/code-plugins/install-url", payload: { url: fixture().plugin.sourceUrl } });
      return fixture("c".repeat(40));
    });
    expect((await app.inject({ method: "POST", url: "/api/code-plugins/update-fixture/update", payload: { expectedRevision: first } })).statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: "/scripts/extensions/third-party/update-fixture/index.js" })).body).toBe(second);
  });
  it("checks remotely without changing stored assets or settings", async () => {
    const { app } = await setup();
    vi.spyOn(git, "listServerRefs").mockResolvedValue([{ ref: "refs/heads/main", oid: second }]);
    const before = (await app.inject({ method: "GET", url: "/api/backup" })).body;
    const result = await app.inject({ method: "POST", url: "/api/code-plugins/update-fixture/check-update" });
    expect(result.statusCode).toBe(200); expect(result.json().state).toBe("update_available");
    const after = (await app.inject({ method: "GET", url: "/api/backup" })).json();
    expect(after.codePlugins).toEqual(JSON.parse(before).codePlugins);
  });
});

it("rolls back a partial asset replacement and supports an enclosing savepoint", () => {
  const database = new DatabaseSync(":memory:"); const runtime = new RuntimeRepository(database);
  try {
    runtime.installCodePlugin(fixture());
    database.exec("CREATE TEMP TRIGGER fail_asset BEFORE INSERT ON code_plugin_files WHEN NEW.path = 'broken.js' BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    const update = fixture(second); update.files.set("broken.js", Buffer.from("second"));
    expect(() => runtime.withTransaction(() => runtime.installCodePlugin(update))).toThrow("injected failure");
    expect(runtime.getCodePlugin("update-fixture")?.sourceRevision).toBe(first);
    expect(runtime.getCodePluginFile("update-fixture", "index.js")?.toString()).toBe(first);
    expect(runtime.getCodePluginFile("update-fixture", "broken.js")).toBeUndefined();
    database.exec("DROP TRIGGER fail_asset");
    expect(runtime.withTransaction(() => runtime.installCodePlugin(fixture(second))).sourceRevision).toBe(second);
  } finally { database.close(); }
});
