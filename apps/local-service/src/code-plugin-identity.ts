import { basename } from "node:path";
import sanitizeFilename from "sanitize-filename";
import type { CodePlugin } from "@mycompanion/shared";

export function extensionInstallationName(plugin: Pick<CodePlugin, "id" | "sourceUrl" | "extensionName">): string {
  if (plugin.extensionName) return plugin.extensionName;
  if (plugin.sourceUrl) {
    const name = sanitizeFilename(basename(decodeURIComponent(new URL(plugin.sourceUrl).pathname)).replace(/\.git$/i, ""));
    if (name) return name;
  }
  return plugin.id;
}
export function visibleCodePlugins(items: CodePlugin[]): CodePlugin[] {
  return items.filter(plugin => plugin.installationScope !== "global"
    || !items.some(local => local.installationScope !== "global" && extensionInstallationName(local) === extensionInstallationName(plugin)));
}
