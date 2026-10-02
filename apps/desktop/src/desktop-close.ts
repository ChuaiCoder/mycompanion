import type { BrowserWindow } from "electron";

/** Wait for renderer drafts while the local service and document are still alive. */
export async function flushDesktopDrafts(window: BrowserWindow, timeoutMs = 15_000): Promise<void> {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      window.webContents.executeJavaScript(`(async () => {
        if (typeof window.__mycompanionFlushDrafts === 'function') await window.__mycompanionFlushDrafts();
      })()`),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("保存编辑草稿超时，请稍后重试关闭。")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One close attempt serves the title bar, app quit and repeated close requests. */
export function installDesktopCloseGuard(window: BrowserWindow, options: {
  beforeClose: () => Promise<void>;
  onError: (error: unknown) => void;
  timeoutMs?: number;
}) {
  let approved = false;
  let pending: Promise<boolean> | undefined;
  const requestClose = (): Promise<boolean> => {
    if (approved || window.isDestroyed()) return Promise.resolve(true);
    if (pending) return pending;
    pending = (async () => {
      try {
        await flushDesktopDrafts(window, options.timeoutMs);
        await options.beforeClose();
        approved = true;
        if (!window.isDestroyed()) window.close();
        return true;
      } catch (error) {
        options.onError(error);
        return false;
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  };
  window.on("close", event => {
    if (!approved) { event.preventDefault(); void requestClose(); }
  });
  return { requestClose, isApproved: () => approved };
}
