import { BrowserWindow, shell } from "electron";
import { SESSION_TOKEN_HEADER } from "@mycompanion/local-service";

function externalUrl(value: string): boolean {
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}

/**
 * 给窗口发往本地服务的每个请求注入会话令牌头（导航、fetch、流式、<img>、前端卡 iframe
 * 全部覆盖）。在 webRequest 层注入，渲染层与卡脚本无需感知令牌——它们与页面同源，
 * 按产品决策（spec §5.10）本就是可信代码；守卫防的是应用之外的本机进程与网页。
 * 注意 origin 用 URL 比较而不是字符串前缀，避免端口前缀撞车（:1000 与 :10009）。
 */
function installSessionTokenHeader(window: BrowserWindow, origin: string, sessionToken: string): void {
  window.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
    let sameOrigin = false;
    try { sameOrigin = new URL(details.url).origin === origin; } catch { /* 忽略无法解析的 URL */ }
    if (!sameOrigin) { callback({}); return; }
    callback({ requestHeaders: { ...details.requestHeaders, [SESSION_TOKEN_HEADER]: sessionToken } });
  });
}

/** Load the application's own local document. */
export async function loadDesktopDocument(window: BrowserWindow, origin: string): Promise<void> {
  const url = new URL(origin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) throw new Error("Invalid local application origin");
  await window.loadURL(origin);
}

/** Desktop window shared by the independent application and reference tests. */
export async function createDesktopWindow(origin: string, show = true, sessionToken?: string): Promise<BrowserWindow> {
  const url = new URL(origin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) throw new Error("Invalid local application origin");
  const window = new BrowserWindow({
    width: 1240, height: 820, minWidth: 360, minHeight: 640,
    show: false, autoHideMenuBar: true, backgroundColor: "#fcfbf8", title: "MyCompanion",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      // Hidden verification windows still paint, so screenshots show current UI.
      offscreen: !show, backgroundThrottling: show },
  });
  if (sessionToken) installSessionTokenHeader(window, origin, sessionToken);
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
