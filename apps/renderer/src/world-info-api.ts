import {
  newWorldInfoEntryTemplate,
  worldInfoDocumentSchema,
  worldInfoSettingsSchema,
  type WorldInfoDocument,
  type WorldInfoSettings,
} from "@mycompanion/shared";

// 世界书 REST 直连（/api/worldinfo/*）。每次变更后广播 mycompanion:world-info，
// 与角色世界书面板（LorebookPanel）和世界书编辑器的监听保持一致。
export { newWorldInfoEntryTemplate };

function changed(detail: { name?: string; deleted?: boolean } = {}): void {
  window.dispatchEvent(new CustomEvent("mycompanion:world-info", { detail }));
}

async function request(url: string, init: RequestInit | undefined, label: string): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${label}（HTTP ${response.status}）。`);
  return response;
}

const json = { Accept: "application/json", "Content-Type": "application/json" };

export async function listWorldInfoNames(): Promise<string[]> {
  const response = await request("/api/worldinfo/list", { headers: { Accept: "application/json" } }, "世界书列表读取失败");
  const payload = await response.json() as { world_names?: unknown };
  return Array.isArray(payload.world_names) ? payload.world_names.filter((name): name is string => typeof name === "string") : [];
}

export async function loadWorldInfo(name: string): Promise<WorldInfoDocument | null> {
  const response = await fetch("/api/worldinfo/get", {
    method: "POST", headers: json, body: JSON.stringify({ name }),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`世界书读取失败（HTTP ${response.status}）。`);
  return worldInfoDocumentSchema.parse(await response.json());
}

export async function saveWorldInfo(name: string, data: WorldInfoDocument): Promise<void> {
  await request("/api/worldinfo/edit", {
    method: "POST", headers: json, body: JSON.stringify({ name, data }),
  }, "世界书保存失败");
  changed({ name });
}

// 服务端没有单独的 create 路由：重名检查后用空文档落一本新书。
export async function createWorldInfo(name: string): Promise<boolean> {
  const names = await listWorldInfoNames();
  if (!name.trim() || names.some(existing => existing.localeCompare(name, undefined, { sensitivity: "base" }) === 0)) return false;
  await request("/api/worldinfo/edit", {
    method: "POST", headers: json, body: JSON.stringify({ name, data: { entries: {} } }),
  }, "世界书创建失败");
  changed({ name });
  return true;
}

export async function deleteWorldInfo(name: string): Promise<boolean> {
  const response = await fetch("/api/worldinfo/delete", {
    method: "POST", headers: json, body: JSON.stringify({ name }),
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`世界书删除失败（HTTP ${response.status}）。`);
  changed({ name, deleted: true });
  return true;
}

export async function getWorldInfoSettings(): Promise<WorldInfoSettings> {
  const response = await request("/api/worldinfo/settings", { headers: { Accept: "application/json" } }, "世界书设置读取失败");
  return worldInfoSettingsSchema.parse(await response.json());
}

export async function saveWorldInfoSettings(settings: WorldInfoSettings): Promise<WorldInfoSettings> {
  const response = await request("/api/worldinfo/settings", {
    method: "PUT", headers: json, body: JSON.stringify(settings),
  }, "世界书设置保存失败");
  const saved = worldInfoSettingsSchema.parse(await response.json());
  changed();
  return saved;
}
