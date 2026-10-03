import {
  installedPluginSchema,
  pluginListResponseSchema,
  pluginManifestSchema,
  type InstalledPlugin,
  type PluginListResponse,
} from "@mycompanion/shared";

import { ApiRequestError, readApiPayload } from "./core";

export async function listPlugins(signal?: AbortSignal): Promise<PluginListResponse> {
  const response = await fetch("/api/plugins", {
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  return pluginListResponseSchema.parse(await readApiPayload(response));
}

export async function installPlugin(file: File): Promise<InstalledPlugin> {
  if (file.size > 1024 * 1024) {
    throw new ApiRequestError("FILE_TOO_LARGE", "插件清单不能超过 1 MiB。");
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(await file.text()) as unknown;
  } catch {
    throw new ApiRequestError("INVALID_PLUGIN_MANIFEST", "插件清单不是有效的 JSON。");
  }
  const localCheck = pluginManifestSchema.safeParse(manifest);
  if (!localCheck.success) {
    throw new ApiRequestError(
      "INVALID_PLUGIN_MANIFEST",
      "插件清单格式不兼容。",
      localCheck.error.issues.map((issue) => issue.message),
    );
  }
  const response = await fetch("/api/plugins/install", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(localCheck.data),
  });
  return installedPluginSchema.parse(await readApiPayload(response));
}

export async function setPluginEnabled(id: string, enabled: boolean): Promise<InstalledPlugin> {
  const response = await fetch(`/api/plugins/${encodeURIComponent(id)}/enabled`, {
    method: "PUT",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  return installedPluginSchema.parse(await readApiPayload(response));
}

export async function uninstallPlugin(id: string): Promise<void> {
  const response = await fetch(`/api/plugins/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) await readApiPayload(response);
}
