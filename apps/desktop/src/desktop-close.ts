import type { BrowserWindow } from "electron";

/** Wait for renderer drafts while the local service and document are still alive. */
export async function flushDesktopDrafts(window: BrowserWindow, timeoutMs = 15_000): Promise<void> {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return;
  const contents = window.webContents;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let destroyed: (() => void) | undefined;
  try {
    const rendererDestroyed = new Promise<void>(resolve => {
      destroyed = () => { if (window.isDestroyed() || contents.isDestroyed()) resolve(); };
      contents.once("destroyed", destroyed);
      window.once("closed", destroyed);
    });
    await Promise.race([
      contents.executeJavaScript(`(async () => {
        if (typeof window.__mycompanionFlushDrafts === 'function') await window.__mycompanionFlushDrafts();
      })()`),
      // Once the document is destroyed, its pending JS promise may never settle.
      // This permits service cleanup; it does not claim those drafts were saved.
      rendererDestroyed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("保存编辑草稿超时，请稍后重试关闭。")), timeoutMs);
      }),
    ]);
  } catch (error) {
    if (!window.isDestroyed() && !contents.isDestroyed()) throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (destroyed) {
      contents.removeListener("destroyed", destroyed);
      window.removeListener("closed", destroyed);
    }
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
    if (approved) return Promise.resolve(true);
    if (pending) return pending;
    pending = (async () => {
      try {
        // A destroyed renderer cannot flush drafts, but its service still owns
        // SQLite and background work and must complete the same shutdown path.
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
