import { BrowserWindow, shell } from "electron";
import { installDesktopNetwork } from "./desktop-network.js";

function externalUrl(value: string): boolean {
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}

/** Install desktop networking before loading the application's own document. */
export async function loadDesktopDocument(window: BrowserWindow, origin: string): Promise<void> {
  const url = new URL(origin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) throw new Error("Invalid local application origin");
  installDesktopNetwork(window.webContents.session);
  await window.loadURL(origin);
}

/** Desktop window shared by the independent application and reference tests. */
export async function createDesktopWindow(origin: string, show = true): Promise<BrowserWindow> {
  const url = new URL(origin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) throw new Error("Invalid local application origin");
  const window = new BrowserWindow({
    width: 1240, height: 820, minWidth: 360, minHeight: 640,
    show: false, autoHideMenuBar: true, backgroundColor: "#fcfbf8", title: "MyCompanion",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      // Hidden verification windows still paint, so screenshots show current UI.
      offscreen: !show, backgroundThrottling: show },
  });
  // Keep Chromium/OS browser permissions; do not blanket-deny media, clipboard or notifications.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (externalUrl(url) && new URL(url).origin !== origin) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin !== origin) {
      event.preventDefault();
      if (externalUrl(target)) void shell.openExternal(target);
    }
  });
  try { await loadDesktopDocument(window, origin); } catch (error) { window.destroy(); throw error; }
  if (show) window.show();
  return window;
}
