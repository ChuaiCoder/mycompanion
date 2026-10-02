import * as fs from "node:fs";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, posix, relative, sep } from "node:path";

import git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import { readBoundedZip } from "./bounded-zip.js";

import type { CodePlugin } from "@mycompanion/shared";

// Resource budgets apply before assets are buffered or persisted.
export const codePluginLimits = {
  archiveBytes: 32 * 1024 * 1024,
  fileBytes: 16 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  entries: 4096,
} as const;
const cloneTimeoutMilliseconds = 60_000;

export class CodePluginRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodePluginRepositoryError";
  }
}

/** ZIP 扩展包解析失败时抛出的错误，message 直接展示给用户。 */
export class CodePluginPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodePluginPackageError";
  }
}

export interface CodePluginRepository {
  plugin: Omit<CodePlugin, "enabled" | "installedAt">;
  manifest: Record<string, unknown>;
  files: Map<string, Buffer>;
}

/** 从 SillyTavern 扩展 ZIP 解析出的可安装扩展包，结构与 Git 仓库版一致。 */
export type CodePluginPackage = CodePluginRepository;

function safePath(value: string): string {
  if (
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[a-z]:/i.test(value)
  ) {
    throw new CodePluginRepositoryError(`扩展仓库包含不安全路径：${value}`);
  }
  const normalized = posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new CodePluginRepositoryError(`扩展仓库包含路径穿越：${value}`);
  }
  return normalized;
}

export function normalizeRepositoryUrl(value: string): URL {
  if (value.length > 2_048) {
    throw new CodePluginRepositoryError("Git URL 过长。");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new CodePluginRepositoryError("请输入有效的 Git URL。");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new CodePluginRepositoryError("只支持 HTTP 或 HTTPS Git URL。");
  }
  if (url.username || url.password) {
    throw new CodePluginRepositoryError("Git URL 不能包含用户名或密码。");
  }
  url.hash = "";
  return url;
}

/** 把任意来源名称归一化为扩展 ID：小写、只保留字母数字与 ._-，并以字母数字开头。 */
function slugify(source: string, errorMessage: string): string {
  const slug = source
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .slice(0, 64);
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(slug)) {
    throw new CodePluginRepositoryError(errorMessage);
  }
  return slug;
}

function repositoryName(url: URL): string {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    throw new CodePluginRepositoryError("Git URL 路径无效。");
  }
  const source = basename(decodedPath).replace(/\.git$/i, "");
  return slugify(source, "无法从 Git URL 确定扩展名称。");
}

function stringField(
  manifest: Record<string, unknown>,
  key: string,
  fallback = "",
): string {
  const value = manifest[key];
  return typeof value === "string" ? value.trim().slice(0, 300) : fallback;
}

function fileField(manifest: Record<string, unknown>, key: string): string | null {
  const value = manifest[key];
  if (typeof value !== "string" || !value.trim()) return null;
  return safePath(value.trim());
}

function contentWarnings(
  files: Map<string, Buffer>,
  js: string | null,
  manifest: Record<string, unknown>,
): string[] {
  const warnings: string[] = [];
  if (js) {
    const source = files.get(js)?.toString("utf8") ?? "";
    if (/\$\s*\(|jQuery|document\.(querySelector|getElementById)|#chat|#send_textarea/.test(source)) {
      warnings.push("扩展依赖 SillyTavern 页面 DOM，部分界面功能可能无法使用。");
    }
    if (/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(source)) {
      warnings.push("扩展包含网络请求；启用后可访问外部网络，请确认扩展来源可信。");
    }
  }
  if (Array.isArray(manifest.requires) && manifest.requires.length > 0) {
    warnings.push(`扩展需要 Extras 模块：${manifest.requires.map(String).join("、")}。`);
  }
  if (Array.isArray(manifest.dependencies) && manifest.dependencies.length > 0) {
    warnings.push(`扩展依赖其他扩展：${manifest.dependencies.map(String).join("、")}。`);
  }
  if (!stringField(manifest, "license")) {
    warnings.push("仓库没有在 manifest.json 中声明许可证。");
  }
  return warnings;
}

/** One budget for both archive metadata and repository assets. */
class AssetBudget {
  private entries = 0;
  private bytes = 0;

  add(size: number): void {
    if (++this.entries > codePluginLimits.entries) {
      throw new CodePluginRepositoryError("扩展最多允许 4096 个文件和目录。");
    }
    if (!Number.isSafeInteger(size) || size < 0 || size > codePluginLimits.fileBytes) {
      throw new CodePluginRepositoryError("扩展单文件不能超过 16 MiB。");
    }
    this.bytes += size;
    if (this.bytes > codePluginLimits.totalBytes) {
      throw new CodePluginRepositoryError("扩展资源总量不能超过 64 MiB。");
    }
  }
}

async function readRepositoryFiles(directory: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  const budget = new AssetBudget();

  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (current === directory && entry.name === ".git") continue;
      const absolutePath = join(current, entry.name);
      const path = safePath(relative(directory, absolutePath).split(sep).join("/"));
      const metadata = await lstat(absolutePath);
      budget.add(metadata.isDirectory() ? 0 : metadata.size);
      if (metadata.isSymbolicLink()) {
        throw new CodePluginRepositoryError(`扩展仓库不能包含符号链接：${path}`);
      }
      if (metadata.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!metadata.isFile()) {
        throw new CodePluginRepositoryError(`扩展仓库包含不支持的文件类型：${path}`);
      }
      files.set(path, await readFile(absolutePath));
    }
  }

  await visit(directory);
  return files;
}

function parsePluginFiles(
  files: Map<string, Buffer>,
  id: string,
  source: { sourceUrl?: string; sourceRef?: string; sourceRevision?: string } = {},
): CodePluginRepository {
  const manifestFile = files.get("manifest.json");
  if (!manifestFile) {
    throw new CodePluginRepositoryError("扩展根目录没有 manifest.json。");
  }

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(manifestFile.toString("utf8"));
  } catch {
    throw new CodePluginRepositoryError("manifest.json 不是有效 JSON。");
  }
  if (!rawManifest || typeof rawManifest !== "object" || Array.isArray(rawManifest)) {
    throw new CodePluginRepositoryError("manifest.json 必须是 JSON 对象。");
  }
  const manifest = rawManifest as Record<string, unknown>;
  const displayName = stringField(manifest, "display_name");
  if (!displayName) {
    throw new CodePluginRepositoryError("manifest.json 缺少 display_name。");
  }
  const js = fileField(manifest, "js");
  const css = fileField(manifest, "css");
  if (!js && !css) {
    throw new CodePluginRepositoryError("扩展没有声明 js 或 css 入口。");
  }
  for (const entry of [js, css]) {
    if (entry && !files.has(entry)) {
      throw new CodePluginRepositoryError(`manifest.json 引用了不存在的文件：${entry}`);
    }
  }
  if (js && ![".js", ".mjs"].includes(extname(js).toLowerCase())) {
    throw new CodePluginRepositoryError("JavaScript 入口必须使用 .js 或 .mjs 扩展名。");
  }
  if (css && extname(css).toLowerCase() !== ".css") {
    throw new CodePluginRepositoryError("CSS 入口必须使用 .css 扩展名。");
  }

  const homepage = stringField(manifest, "homePage") || stringField(manifest, "homepage");
  let normalizedHomepage = source.sourceUrl;
  if (homepage) {
    try {
      const candidate = new URL(homepage);
      if (["http:", "https:"].includes(candidate.protocol)) normalizedHomepage = candidate.href;
    } catch {
      // The repository URL remains the safe fallback.
    }
  }
  const totalBytes = [...files.values()].reduce((sum, value) => sum + value.length, 0);
  return {
    plugin: {
      kind: "sillytavern-js",
      id,
      displayName,
      version: stringField(manifest, "version", "未知"),
      author: stringField(manifest, "author", "未知作者"),
      license: stringField(manifest, "license", "未声明"),
      ...(normalizedHomepage ? { homepage: normalizedHomepage } : {}),
      ...source,
      js,
      css,
      fileCount: files.size,
      totalBytes,
      warnings: contentWarnings(files, js, manifest),
    },
    manifest,
    files,
  };
}

export async function parseCodePluginRepository(
  directory: string,
  sourceUrl: string,
  sourceRef: string,
  sourceRevision: string,
): Promise<CodePluginRepository> {
  const url = normalizeRepositoryUrl(sourceUrl);
  return parsePluginFiles(await readRepositoryFiles(directory), repositoryName(url), {
    sourceUrl: url.href,
    sourceRef: sourceRef.slice(0, 200),
    sourceRevision,
  });
}

export async function installCodePluginFromUrl(
  value: string,
  requestedRef = "",
): Promise<CodePluginRepository> {
  const url = normalizeRepositoryUrl(value);
  const reference = requestedRef.trim();
  if (reference.length > 200 || reference.startsWith("-") || /[\x00-\x20\x7f~^:?*\[\\]/.test(reference)
    || reference.includes("..") || reference.includes("@{") || reference.endsWith("/") || reference.endsWith(".")
    || reference.split("/").some(part => part.startsWith(".") || part.endsWith(".lock"))) {
    throw new CodePluginRepositoryError("分支或标签名称无效。");
  }

  const directory = await mkdtemp(join(tmpdir(), "mycompanion-extension-"));
  const controller = new AbortController();
  let timeoutReached = false;
  const timeout = setTimeout(() => {
    timeoutReached = true;
    controller.abort();
  }, cloneTimeoutMilliseconds);
  const boundedHttp = {
    request: async (request: Parameters<typeof http.request>[0]) =>
      http.request({ ...request, signal: controller.signal }),
  };

  try {
    await git.clone({
      fs,
      http: boundedHttp,
      dir: directory,
      url: url.href,
      depth: 1,
      singleBranch: true,
      noTags: !reference,
      ...(reference ? { ref: reference } : {}),
      onAuth: () => {
        throw new CodePluginRepositoryError("当前只支持无需登录的公开 Git 仓库。");
      },
    });
    let revision = await git.resolveRef({ fs, dir: directory, ref: "HEAD" });
    // Annotated-tag checkouts can leave HEAD pointing at the tag object. Persist
    // the actual commit so update comparisons match the remote peeled target.
    for (let depth = 0; ; depth++) {
      const object = await git.readObject({ fs, dir: directory, oid: revision });
      if (object.type === "commit") break;
      if (object.type !== "tag" || depth >= 32) throw new CodePluginRepositoryError("扩展分支或标签没有指向有效提交。");
      revision = (await git.readTag({ fs, dir: directory, oid: revision })).tag.object;
    }
    const checkedOutBranch = await git.currentBranch({ fs, dir: directory, fullname: true });
    // Store full refs so a branch and a tag with the same name stay distinct.
    const sourceRef = checkedOutBranch || (reference ? await git.expandRef({ fs, dir: directory, ref: reference }) : "HEAD");
    return await parseCodePluginRepository(
      directory,
      url.href,
      sourceRef,
      revision,
    );
  } catch (error) {
    if (error instanceof CodePluginRepositoryError) throw error;
    if (timeoutReached) {
      throw new CodePluginRepositoryError("克隆扩展仓库超时，请检查网络后重试。");
    }
    throw new CodePluginRepositoryError("无法克隆扩展仓库，请检查 Git URL、分支或标签。");
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await rm(directory, { force: true, recursive: true });
  }
}

export function contentTypeForPluginFile(path: string): string {
  const types: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".gif": "image/gif",
    ".html": "text/html; charset=utf-8",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  };
  return types[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** Strip a single wrapper directory only when the archive has no root manifest. */
function stripArchiveRoot(files: Map<string, Buffer>): Map<string, Buffer> {
  if (files.has("manifest.json")) return files;
  const first = files.keys().next().value;
  if (!first?.includes("/")) return files;
  const prefix = first.slice(0, first.indexOf("/") + 1);
  if (![...files.keys()].every((path) => path.startsWith(prefix))) return files;
  return new Map([...files].map(([path, data]) => [path.slice(prefix.length), data]));
}

/** Parse legacy ZIP imports with the same manifest validation as Git installs. */
export async function parseCodePluginPackage(
  buffer: Buffer,
  filename: string,
): Promise<CodePluginPackage> {
  try {
    const files = await readBoundedZip(buffer, codePluginLimits);
    const id = slugify(basename(filename).replace(/\.zip$/i, ""), "无法从扩展文件名确定扩展名称。");
    return parsePluginFiles(stripArchiveRoot(files), id);
  } catch (cause) {
    throw new CodePluginPackageError(cause instanceof Error ? cause.message : String(cause));
  }
}
