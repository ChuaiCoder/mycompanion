import { describe, expect, it, vi } from "vitest";

import {
  characterDetailSchema,
  codePluginSchema,
  conversationDetailSchema,
} from "@mycompanion/shared";

import { buildApp } from "./app.js";
import * as codePluginRepository from "./code-plugin-repository.js";
import {
  apps,
  fullV2Card,
  pathTraversalExtensionZip,
  sandboxExtensionZip,
} from "./test-helpers.js";

describe("SillyTavern JavaScript extension sandbox", () => {
  it("serves core module aliases and reports missing named-import modules as 404", async () => {
    const app = buildApp();
    apps.push(app);
    const alias = await app.inject({ method: "GET", url: "/scripts/utils.js" });
    const runtime = await app.inject({ method: "GET", url: "/plugin-runtime/scripts/utils.js" });
    expect(alias.statusCode).toBe(200);
    expect(alias.body).toBe(runtime.body);
    expect(alias.headers["content-type"]).toContain("text/javascript");
    const missing = await app.inject({ method: "GET", url: "/plugin-runtime/scripts/fixture-missing-core.js" });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toContain("尚未实现");
  });
  it("rejects ZIP path traversal before persisting files", async () => {
    const app = buildApp();
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/code-plugins/install",
      headers: {
        "content-type": "application/zip",
        "x-plugin-filename": "malicious.zip",
      },
      payload: pathTraversalExtensionZip,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: "INVALID_CODE_PLUGIN" },
    });
    expect(response.json().error.message).toContain("路径穿越");
  });

  it("installs a code extension from a Git URL", async () => {
    const spy = vi.spyOn(codePluginRepository, "installCodePluginFromUrl").mockResolvedValue({
      plugin: {
        kind: "sillytavern-js",
        id: "url-installed-ext",
        displayName: "URL Installed Extension",
        version: "1.0.0",
        author: "Author",
        license: "MIT",
        sourceUrl: "https://github.com/example/repo",
        sourceRef: "main",
        sourceRevision: "a".repeat(40),
        js: "index.js",
        css: null,
        fileCount: 1,
        totalBytes: 12,
        warnings: [],
      },
      manifest: { display_name: "URL Installed Extension", js: "index.js" },
      files: new Map([["index.js", Buffer.from("console.log(1)")]]),
    });
    try {
      const app = buildApp();
      apps.push(app);

      const invalid = await app.inject({
        method: "POST",
        url: "/api/code-plugins/install-url",
        payload: { url: "" },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({
        error: { code: "INVALID_INSTALL_URL" },
      });

      const installed = await app.inject({
        method: "POST",
        url: "/api/code-plugins/install-url",
        payload: { url: "https://github.com/example/repo" },
      });
      expect(installed.statusCode).toBe(201);
      expect(codePluginSchema.parse(installed.json())).toMatchObject({
        id: "url-installed-ext",
        displayName: "URL Installed Extension",
        enabled: false,
      });
      expect(spy).toHaveBeenCalledWith("https://github.com/example/repo", "");

      const enabled = await app.inject({ method: "PUT", url: "/api/code-plugins/url-installed-ext/enabled",
        payload: { enabled: true } });
      expect(enabled.statusCode).toBe(200);
      const contribution = await app.inject({ method: "PUT", url: "/api/code-plugins/url-installed-ext/contributions",
        payload: { systemPrompt: "Keep this setting.", commands: [] } });
      expect(contribution.statusCode).toBe(200);
      const before = (await app.inject({ method: "GET", url: "/api/backup" })).json();
      const original = before.codePlugins.find((item: { id: string }) => item.id === "url-installed-ext");
      expect(original).toBeDefined();

      spy.mockResolvedValueOnce({ plugin: { ...codePluginSchema.parse(installed.json()),
        version: "1.1.0", sourceRevision: "b".repeat(40), fileCount: 1, totalBytes: 12 },
        manifest: { display_name: "URL Installed Extension", version: "1.1.0", js: "index.js" },
        files: new Map([["index.js", Buffer.from("console.log(2)")]]) });
      const updated = await app.inject({ method: "POST", url: "/api/code-plugins/install-url",
        payload: { url: "https://github.com/example/repo" } });
      expect(updated.statusCode).toBe(201);
      expect(updated.json()).toMatchObject({ version: "1.1.0", enabled: true, installedAt: original.installedAt,
        sourceRevision: "b".repeat(40) });
      expect((await app.inject({ method: "GET", url: "/scripts/extensions/third-party/url-installed-ext/index.js" })).body)
        .toBe("console.log(2)");
      const after = (await app.inject({ method: "GET", url: "/api/backup" })).json();
      expect(after.codePlugins.find((item: { id: string }) => item.id === "url-installed-ext").contributions)
        .toEqual(original.contributions);

      spy.mockResolvedValueOnce({ plugin: { ...codePluginSchema.parse(updated.json()),
        sourceUrl: "https://github.com/other/repo", sourceRevision: "c".repeat(40) },
        manifest: { display_name: "Different source", js: "index.js" },
        files: new Map([["index.js", Buffer.from("console.log(3)")]]) });
      const conflict = await app.inject({ method: "POST", url: "/api/code-plugins/install-url",
        payload: { url: "https://github.com/other/repo" } });
      expect(conflict.statusCode).toBe(409);
      expect((await app.inject({ method: "GET", url: "/scripts/extensions/third-party/url-installed-ext/index.js" })).body)
        .toBe("console.log(2)");
    } finally {
      spy.mockRestore();
    }
  });

  it("maps Git repository errors to a 422 install failure", async () => {
    const spy = vi.spyOn(codePluginRepository, "installCodePluginFromUrl").mockRejectedValue(
      new codePluginRepository.CodePluginRepositoryError("Git 仓库根目录没有 manifest.json。"),
    );
    try {
      const app = buildApp();
      apps.push(app);
      const response = await app.inject({
        method: "POST",
        url: "/api/code-plugins/install-url",
        payload: { url: "https://github.com/example/repo", branch: "main" },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        error: { code: "INVALID_CODE_PLUGIN", message: "Git 仓库根目录没有 manifest.json。" },
      });
      expect(spy).toHaveBeenCalledWith("https://github.com/example/repo", "main");
    } finally {
      spy.mockRestore();
    }
  });

  it("installs original extension assets, exposes the desktop loader, and applies active prompt contributions", async () => {
    let providerRequest: { messages?: Array<{ role: string; content: string }> } | undefined;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(
      async (_url: URL, init?: RequestInit) => {
        providerRequest = JSON.parse(String(init?.body)) as typeof providerRequest;
        return new Response(JSON.stringify({
          choices: [{ message: { content: "提灯仍然亮着。" } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    ));
    const app = buildApp();
    apps.push(app);

    const installedResponse = await app.inject({
      method: "POST",
      url: "/api/code-plugins/install",
      headers: {
        "content-type": "application/zip",
        "x-plugin-filename": "sandbox-test.zip",
      },
      payload: sandboxExtensionZip,
    });
    expect(installedResponse.statusCode).toBe(201);
    const installed = codePluginSchema.parse(installedResponse.json());
    expect(installed).toMatchObject({
      id: "sandbox-test",
      displayName: "Sandbox Test",
      js: "index.js",
      css: "style.css",
      enabled: false,
      fileCount: 3,
    });

    const enabled = await app.inject({
      method: "PUT",
      url: "/api/code-plugins/sandbox-test/enabled",
      payload: { enabled: true },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({ enabled: true });

    const frame = await app.inject({
      method: "GET",
      url: "/plugin-runtime/frame/sandbox-test",
      headers: { host: "localhost:1234", "sec-fetch-site": "same-origin" },
    });
    expect(frame.statusCode).toBe(404);
    const descriptors = await app.inject({ method: "GET", url: "/api/code-plugins/runtime" });
    expect(descriptors.json().items).toEqual([expect.objectContaining({ id: "sandbox-test", js: "index.js", css: "style.css", enabled: true, order: 1, hooks: { activate: "activate" } })]);
    const loader = await app.inject({ method: "GET", url: "/plugin-runtime/desktop-host.js" });
    expect(loader.statusCode).toBe(200);
    expect(loader.headers["content-type"]).toContain("javascript");
    expect(loader.headers["content-security-policy"]).toBeUndefined();

    const script = await app.inject({
      method: "GET",
      url: "/plugin-runtime/scripts/extensions/third-party/sandbox-test/index.js",
      headers: { host: "localhost:1234", "sec-fetch-site": "same-origin" },
    });
    expect(script.statusCode).toBe(200);
    expect(script.body).toContain("setExtensionPrompt");
    expect(script.headers["access-control-allow-origin"]).toBe("*");
    const originalPath = await app.inject({ method: "GET", url: "/scripts/extensions/third-party/sandbox-test/index.js" });
    expect(originalPath.body).toBe(script.body);

    const localApi = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: "localhost:1234", "sec-fetch-site": "same-origin" },
    });
    expect(localApi.statusCode).toBe(200);

    const contribution = await app.inject({
      method: "PUT",
      url: "/api/code-plugins/sandbox-test/contributions",
      payload: { systemPrompt: "Keep the lantern lit.", commands: [{
        name: "lantern", description: "详细用法：".repeat(100), prompt: "{{args}}",
      }] },
    });
    expect(contribution.statusCode).toBe(200);
    expect(contribution.json().commands[0].description).toBe("详细用法：".repeat(100));

    const imported = characterDetailSchema.parse((await app.inject({
      method: "POST",
      url: "/api/characters/import/commit",
      payload: { filename: "ccv2-full.json", card: fullV2Card },
    })).json());
    await app.inject({
      method: "PUT",
      url: "/api/settings/provider",
      payload: {
        kind: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "test-model",
        temperature: 0.8,
        maxTokens: 200,
      },
    });
    const conversation = conversationDetailSchema.parse((await app.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { characterId: imported.id },
    })).json());
    const sent = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages`,
      payload: { content: "灯还亮着吗？" },
    });
    expect(sent.statusCode).toBe(200);
    expect(providerRequest?.messages?.some(message => message.role === "system" && message.content === "Keep the lantern lit.")).toBe(true);
  });
});
