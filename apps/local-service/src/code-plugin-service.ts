import { createHash } from "node:crypto";
import type { CodePlugin } from "@mycompanion/shared";
import { installCodePluginFromUrl, normalizeRepositoryUrl, repositoryName } from "./code-plugin-repository.js";
import { checkCodePluginUpdate } from "./code-plugin-git-state.js";
import type { RuntimeRepository } from "./runtime-repository.js";
import { extensionInstallationName, visibleCodePlugins } from "./code-plugin-identity.js";
export { extensionInstallationName } from "./code-plugin-identity.js";

export class CodePluginMutationError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}
export function resolveCodePlugin(runtime: RuntimeRepository, name: string, scope?: "local" | "global", storageId = true): CodePlugin | undefined {
  const items = runtime.listCodePlugins().items.filter(plugin => scope === undefined || (plugin.installationScope ?? "local") === scope);
  // Discovery and public folder aliases follow Tavern's local-over-global rule.
  return items.filter(plugin => extensionInstallationName(plugin) === name)
    .sort((a, b) => Number(a.installationScope === "global") - Number(b.installationScope === "global"))[0]
    ?? (storageId ? items.find(plugin => plugin.id === name) : undefined);
}
export function discoveredCodePlugins(runtime: RuntimeRepository): CodePlugin[] {
  return visibleCodePlugins(runtime.listCodePlugins().items);
}
function sameSource(a: CodePlugin | undefined, b: CodePlugin | undefined): boolean {
  return a === undefined ? b === undefined : Boolean(b && a.sourceUrl === b.sourceUrl && a.sourceRef === b.sourceRef
    && a.sourceRevision === b.sourceRevision && a.installedAt === b.installedAt
    && a.installationScope === b.installationScope && a.extensionName === b.extensionName);
}
function ensureUnchanged(runtime: RuntimeRepository, observed: CodePlugin | undefined, id: string): void {
  if (!sameSource(observed, runtime.getCodePlugin(id))) throw new CodePluginMutationError(409, "EXTENSION_CHANGED", "扩展在下载或检查期间发生变化，请重试。");
}
export async function installCodePluginUrl(runtime: RuntimeRepository, url: string, branch = "", options: { onlyNew?: boolean; scope?: "local" | "global" } = {}): Promise<CodePlugin> {
  const normalized = normalizeRepositoryUrl(url), scope = options.scope ?? "local";
  const name = extensionInstallationName({ id: repositoryName(normalized), sourceUrl: normalized.href });
  const observed = resolveCodePlugin(runtime, name, scope, false);
  if (options.onlyNew && observed) throw new CodePluginMutationError(409, "EXTENSION_EXISTS", "扩展已安装。");
  if (observed && observed.sourceUrl !== normalized.href) throw new CodePluginMutationError(409, "EXTENSION_SOURCE_CONFLICT", "同名扩展已来自另一个仓库；请先确认已安装扩展的来源。");
  const repository = await installCodePluginFromUrl(normalized.href, branch);
  // Preserve legacy local ids; a separate storage id keeps both scopes and
  // case-distinct folders independent without changing the original manifest.
  let id = observed?.id ?? repository.plugin.id;
  if (!observed && (scope === "global" || runtime.getCodePlugin(id))) {
    let salt = 0;
    do { id = `${scope}-${createHash("sha256").update(`${name}\0${salt++}`).digest("hex").slice(0, 40)}`; }
    while (runtime.getCodePlugin(id));
  }
  ensureUnchanged(runtime, observed, id);
  const duplicate = resolveCodePlugin(runtime, name, scope, false);
  if (!sameSource(observed, duplicate)) throw new CodePluginMutationError(409, "EXTENSION_CHANGED", "扩展在下载期间发生变化，请重试。");
  const occupied = runtime.getCodePlugin(repository.plugin.id);
  if (repository.plugin.sourceUrl !== normalized.href || (occupied && occupied.id !== observed?.id && (occupied.installationScope ?? "local") === scope
    && extensionInstallationName(occupied) === name && occupied.sourceUrl !== normalized.href)) throw new CodePluginMutationError(409, "EXTENSION_SOURCE_CONFLICT", "下载的扩展来源与请求不同。");
  repository.plugin.id = id;
  repository.plugin.extensionName = observed?.extensionName ?? name;
  repository.plugin.installationScope = scope;
  return runtime.installCodePlugin(repository);
}
export async function checkInstalledCodePlugin(runtime: RuntimeRepository, plugin: CodePlugin) {
  const result = await checkCodePluginUpdate(plugin);
  ensureUnchanged(runtime, plugin, plugin.id);
  return result;
}
export async function updateInstalledCodePlugin(runtime: RuntimeRepository, plugin: CodePlugin, branch = plugin.sourceRef ?? ""): Promise<CodePlugin> {
  if (!plugin.sourceUrl || !plugin.sourceRevision) throw new CodePluginMutationError(400, "GIT_SOURCE_REQUIRED", "这个扩展没有 Git 来源，请通过仓库地址安装。");
  const repository = await installCodePluginFromUrl(plugin.sourceUrl, branch);
  ensureUnchanged(runtime, plugin, plugin.id);
  if (repository.plugin.sourceUrl !== plugin.sourceUrl) throw new CodePluginMutationError(409, "EXTENSION_SOURCE_CONFLICT", "下载的扩展来源与已安装版本不同。");
  repository.plugin.id = plugin.id;
  repository.plugin.extensionName = extensionInstallationName(plugin);
  repository.plugin.installationScope = plugin.installationScope ?? "local";
  return runtime.installCodePlugin(repository);
}
