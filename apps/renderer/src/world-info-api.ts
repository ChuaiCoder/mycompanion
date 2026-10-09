import {
  newWorldInfoEntryTemplate,
  worldInfoDocumentSchema,
  worldInfoSettingsSchema,
  type WorldInfoDocument,
  type WorldInfoSettings,
} from "@mycompanion/shared";
import { ApiRequestError, readApiPayload } from "./api";

// 世界书 REST 直连（/api/worldinfo/*）。每次变更后广播 mycompanion:world-info，
// 与角色世界书面板（LorebookPanel）和世界书编辑器的监听保持一致。
export { newWorldInfoEntryTemplate };

function changed(detail: { name?: string; deleted?: boolean } = {}): void {
  window.dispatchEvent(new CustomEvent("mycompanion:world-info", { detail }));
}

const json = { Accept: "application/json", "Content-Type": "application/json" };

export async function listWorldInfoNames(): Promise<string[]> {
  const response = await fetch("/api/worldinfo/list", { headers: { Accept: "application/json" } });
  const payload = await readApiPayload(response) as { world_names?: unknown };
  return Array.isArray(payload.world_names) ? payload.world_names.filter((name): name is string => typeof name === "string") : [];
}

export async function loadWorldInfo(name: string): Promise<WorldInfoDocument | null> {
  try {
    const response = await fetch("/api/worldinfo/get", {
      method: "POST", headers: json, body: JSON.stringify({ name }),
    });
    return worldInfoDocumentSchema.parse(await readApiPayload(response));
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === "WORLD_INFO_NOT_FOUND") return null;
    throw error;
  }
}

export async function saveWorldInfo(name: string, data: WorldInfoDocument): Promise<void> {
  const response = await fetch("/api/worldinfo/edit", {
    method: "POST", headers: json, body: JSON.stringify({ name, data }),
  });
  await readApiPayload(response);
  changed({ name });
}

// 服务端没有单独的 create 路由：重名检查后用空文档落一本新书。
export async function createWorldInfo(name: string): Promise<boolean> {
  const names = await listWorldInfoNames();
  if (!name.trim() || names.some(existing => existing.localeCompare(name, undefined, { sensitivity: "base" }) === 0)) return false;
  const response = await fetch("/api/worldinfo/edit", {
    method: "POST", headers: json, body: JSON.stringify({ name, data: { entries: {} } }),
  });
  await readApiPayload(response);
  changed({ name });
  return true;
}

export async function deleteWorldInfo(name: string): Promise<boolean> {
  try {
    const response = await fetch("/api/worldinfo/delete", {
      method: "POST", headers: json, body: JSON.stringify({ name }),
    });
    await readApiPayload(response);
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === "WORLD_INFO_NOT_FOUND") return false;
    throw error;
  }
  changed({ name, deleted: true });
  return true;
}

export async function getWorldInfoSettings(): Promise<WorldInfoSettings> {
  const response = await fetch("/api/worldinfo/settings", { headers: { Accept: "application/json" } });
  return worldInfoSettingsSchema.parse(await readApiPayload(response));
}

export async function saveWorldInfoSettings(settings: WorldInfoSettings): Promise<WorldInfoSettings> {
  const response = await fetch("/api/worldinfo/settings", {
    method: "PUT", headers: json, body: JSON.stringify(settings),
  });
  const saved = worldInfoSettingsSchema.parse(await readApiPayload(response));
  changed();
  return saved;
}
