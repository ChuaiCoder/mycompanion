import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CodePluginPackageError,
  codePluginLimits,
  parseCodePluginPackage,
  parseCodePluginRepository,
} from "./code-plugin-repository.js";

const fixture = (name: string) => readFile(new URL(`../fixtures/extensions/${name}.zip`, import.meta.url));

describe("extension package validation", () => {
  it("uses the root manifest even when a nested manifest is read later", async () => {
    const result = await parseCodePluginPackage(await fixture("root"), "test-extension.zip");
    expect(result.plugin.displayName).toBe("Root extension");
    expect(result.files.has("nested/manifest.json")).toBe(true);
  });

  it("accepts a GitHub-style wrapper and applies identical Git/ZIP validation", async () => {
    const archive = await parseCodePluginPackage(await fixture("wrapper"), "test-extension.zip");
    const directory = await mkdtemp(join(tmpdir(), "mc-extension-test-"));
    try {
      for (const [path, content] of archive.files) await writeFile(join(directory, path), content);
      const repository = await parseCodePluginRepository(directory, "https://example.com/test-extension", "main", "a".repeat(40));
      expect(repository.manifest).toEqual(archive.manifest);
      expect(repository.files).toEqual(archive.files);
      expect(repository.plugin).toMatchObject(archive.plugin);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing-root", "根目录没有 manifest.json"],
    ["invalid-entry", "路径穿越"],
    ["duplicate", "重复路径"],
    ["symlink", "符号链接"],
    ["oversized-file", "16 MiB"],
    ["oversized-total", "64 MiB"],
    ["too-many-entries", "4096"],
  ])("rejects %s through the package error boundary", async (name, message) => {
    const result = parseCodePluginPackage(await fixture(name), "test-extension.zip");
    await expect(result).rejects.toBeInstanceOf(CodePluginPackageError);
    await expect(result).rejects.toThrow(message);
  });

  it("rejects oversized uploads before trying to decode them", async () => {
    await expect(parseCodePluginPackage(Buffer.alloc(codePluginLimits.archiveBytes + 1), "large.zip"))
      .rejects.toThrow("32 MiB");
  });

  it("rejects oversized repository assets before reading their contents", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mc-extension-test-"));
    try {
      await writeFile(join(directory, "large.bin"), Buffer.alloc(codePluginLimits.fileBytes + 1));
      await expect(parseCodePluginRepository(directory, "https://example.com/test-extension", "main", "a".repeat(40)))
        .rejects.toThrow("16 MiB");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
