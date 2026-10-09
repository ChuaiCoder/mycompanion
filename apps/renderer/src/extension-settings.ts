// 共享扩展设置存储：/api/extensions/settings 的直连封装（FR-DATA 设置持久化）。
// 各领域（编辑器草稿、界面语言、向量匹配、预设绑定）在同一个缓存对象上读写，
// 保存时整体 PUT；串行队列避免并发写互相覆盖，服务端会保留预设存储域。

import { readApiPayload } from "./api";

declare global { interface Window { __mycompanionFlushDrafts?: () => Promise<void> } }

let cache: Record<string, unknown> | undefined;
let loading: Promise<Record<string, unknown>> | undefined;
let queue: Promise<void> = Promise.resolve();
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

export function loadSharedExtensionSettings(): Promise<Record<string, unknown>> {
  return loading ??= (async () => {
    const response = await fetch("/api/extensions/settings", { headers: { Accept: "application/json" } });
    const payload = await readApiPayload(response) as { extensionSettings?: unknown };
    cache = payload.extensionSettings && typeof payload.extensionSettings === "object" && !Array.isArray(payload.extensionSettings)
      ? payload.extensionSettings as Record<string, unknown> : {};
    return cache;
  })().catch(error => { loading = undefined; throw error; });
}

export function saveSharedExtensionSettings(): Promise<void> {
  const body = JSON.stringify({ extensionSettings: cache ?? {} });
  const run = queue.then(async () => {
    const response = await fetch("/api/extensions/settings", {
      method: "PUT",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body,
    });
    await readApiPayload(response);
  });
  queue = run.catch(() => {});
  return run.then(() => { for (const listener of listeners) listener(); });
}

export function saveSharedExtensionSettingsDebounced(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    void saveSharedExtensionSettings().catch(() => { /* 下次写入会重试 */ });
  }, 800);
}

/** Flush any pending debounced write, then wait for the save queue to drain. */
export async function flushSharedExtensionSettings(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
    await saveSharedExtensionSettings();
    return;
  }
  await queue;
}

export function onSharedExtensionSettingsSaved(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Indirection so views never touch window.location directly (test-friendly). */
export function reloadApplication(): void {
  window.location.reload();
}
