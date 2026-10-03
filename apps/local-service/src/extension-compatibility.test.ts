import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { backupChecksum } from "./backup.js";
import * as repository from "./code-plugin-repository.js";
import { RuntimeRepository } from "./runtime-repository.js";
import { installCodePluginUrl } from "./code-plugin-service.js";
import { apps, sandboxExtensionZip } from "./test-helpers.js";

const url = "https://example.invalid/Mixed-Case.git", first = "a".repeat(40);
function fixture(sourceUrl = url, text = "LOCAL") : repository.CodePluginRepository {
  return { plugin: { kind: "sillytavern-js", id: "mixed-case", displayName: "Scope fixture", version: "1", author: "Fixture", license: "MIT",
    sourceUrl, sourceRef: "refs/heads/main", sourceRevision: first, js: "index.js", css: null, fileCount: 1, totalBytes: text.length, warnings: [] },
    manifest: { display_name: "Scope fixture", version: "1", js: "index.js", unknownManifest: { keep: [17] } }, files: new Map([["index.js", Buffer.from(text)]]) };
}
afterEach(() => vi.restoreAllMocks());
describe("shared Tavern extension HTTP contract", () => {
  it("keeps local/global and case-distinct records, disabled local shadows global prompt/commands, and backup restores exact identity", async () => {
    const app = buildApp(); apps.push(app);
    const download = vi.spyOn(repository, "installCodePluginFromUrl").mockResolvedValue(fixture(url, "GLOBAL"));
    const installed = await app.inject({ method: "POST", url: "/api/extensions/install", payload: { url, global: true } });
    expect(installed.statusCode).toBe(200); expect(installed.json()).toMatchObject({ folderName: "Mixed-Case", extensionPath: "third-party/Mixed-Case" });
    const global = (await app.inject({ method: "GET", url: "/api/code-plugins" })).json().items[0];
    await app.inject({ method: "PUT", url: `/api/code-plugins/${global.id}/enabled`, payload: { enabled: true } });
    await app.inject({ method: "PUT", url: `/api/code-plugins/${global.id}/contributions`, payload: { systemPrompt: "GLOBAL", commands: [{ name: "global-command", description: "Global", prompt: "GLOBAL" }] } });
    download.mockResolvedValue(fixture(url, "LOCAL"));
    expect((await app.inject({ method: "POST", url: "/api/extensions/install", payload: { url, global: false } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/extensions/install", payload: { url, global: false } })).statusCode).toBe(409);
    download.mockResolvedValue(fixture("https://example.invalid/mixed-case.git", "CASE-DISTINCT"));
    expect((await app.inject({ method: "POST", url: "/api/extensions/install", payload: { url: "https://example.invalid/mixed-case.git" } })).statusCode).toBe(200);
    const items = (await app.inject({ method: "GET", url: "/api/code-plugins" })).json().items;
    expect(items).toHaveLength(3); expect(new Set(items.map((p: { id: string }) => p.id)).size).toBe(3);
    expect((await app.inject({ method: "GET", url: "/scripts/extensions/third-party/Mixed-Case/index.js" })).body).toBe("LOCAL");
    expect((await app.inject({ method: "GET", url: "/scripts/extensions/third-party/mixed-case/index.js" })).body).toBe("CASE-DISTINCT");
    expect((await app.inject({ method: "GET", url: "/api/code-plugins/runtime" })).json().items.filter((p: { extensionName: string }) => p.extensionName === "Mixed-Case")).toMatchObject([{ installationScope: "local", enabled: false }]);
    const backup = (await app.inject({ method: "GET", url: "/api/backup" })).json();
    const target = buildApp(); apps.push(target);
    expect((await target.inject({ method: "POST", url: "/api/backup/restore", payload: { backup, strategy: "overwrite" } })).statusCode).toBe(200);
    const restored = (await target.inject({ method: "GET", url: "/api/backup" })).json();
    expect(restored.codePlugins).toEqual(backup.codePlugins); expect(restored.codePlugins[0].manifest.unknownManifest).toEqual({ keep: [17] });
    await target.inject({ method: "PUT", url: `/api/code-plugins/${global.id}/enabled`, payload: { enabled: false } });
    const preview = await target.inject({ method: "POST", url: "/api/backup/restore/preview", payload: { backup, strategy: "overwrite" } });
    expect(preview.statusCode, preview.body).toBe(200); expect(preview.json().sections.codePlugins.overwrite).toBe(1);
    const restoreState = await target.inject({ method: "POST", url: "/api/backup/restore", payload: { backup, strategy: "overwrite" } });
    expect(restoreState.statusCode, restoreState.body).toBe(200);
    expect((await target.inject({ method: "GET", url: "/api/code-plugins" })).json().items.find((p: { id: string }) => p.id === global.id).enabled).toBe(true);
    expect((await target.inject({ method: "POST", url: "/api/extensions/delete", payload: { extensionName: "third-party/Mixed-Case", global: false } })).statusCode).toBe(200);
    expect((await target.inject({ method: "GET", url: "/scripts/extensions/third-party/Mixed-Case/index.js" })).body).toBe("GLOBAL");
    expect((await target.inject({ method: "POST", url: "/api/extensions/delete", payload: { extensionName: "Mixed-Case", global: true } })).statusCode).toBe(200);
    expect((await target.inject({ method: "POST", url: "/api/extensions/delete", payload: { extensionName: "Mixed-Case", global: true } })).statusCode).toBe(404);
  });
  it("filters global contributions in the real repository consumer even when the shadowing local is disabled", async () => {
    const database = new DatabaseSync(":memory:"), runtime = new RuntimeRepository(database);
    vi.spyOn(repository, "installCodePluginFromUrl").mockImplementation(async sourceUrl => fixture(sourceUrl));
    try {
      const global = await installCodePluginUrl(runtime, url, "", { scope: "global" });
      runtime.setCodePluginEnabled(global.id, true);
      runtime.saveCodePluginContributions(global.id, { systemPrompt: "GLOBAL", commands: [{ name: "global-command", description: "Global", prompt: "GLOBAL" }] });
      expect(runtime.activeCodePluginsAsInstalled()).toHaveLength(1);
      const local = await installCodePluginUrl(runtime, url, "", { scope: "local" });
      expect(local.enabled).toBe(false); expect(runtime.activeCodePluginsAsInstalled()).toEqual([]);
      runtime.deleteCodePlugin(local.id); expect(runtime.activeCodePluginsAsInstalled()[0]?.id).toBe(global.id);
    } finally { database.close(); }
  });
  it("reads non-Git packages through the original version contract and accepts old backups without identity fields", async () => {
    const app = buildApp(); apps.push(app);
    await app.inject({ method: "POST", url: "/api/code-plugins/install", headers: { "content-type": "application/zip", "x-plugin-filename": "sandbox-test.zip" }, payload: sandboxExtensionZip });
    const result = await app.inject({ method: "POST", url: "/api/extensions/version", payload: { extensionName: "sandbox-test", global: false } });
    expect(result.statusCode).toBe(200); expect(result.json()).toEqual({ currentBranchName: "", currentCommitHash: "", isUpToDate: true, remoteUrl: "" });
    const backup = (await app.inject({ method: "GET", url: "/api/backup" })).json();
    for (const plugin of backup.codePlugins) { delete plugin.extensionName; delete plugin.installationScope; }
    backup.manifest.checksum = backupChecksum(backup);
    const target = buildApp(); apps.push(target);
    expect((await target.inject({ method: "POST", url: "/api/backup/restore", payload: { backup, strategy: "overwrite" } })).statusCode).toBe(200);
    expect((await target.inject({ method: "GET", url: "/api/code-plugins/runtime" })).json().items[0].installationScope).toBe("local");
  });
});
