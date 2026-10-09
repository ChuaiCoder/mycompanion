import { join, resolve } from "node:path";
import { app, dialog, safeStorage } from "electron";
import type { BrowserWindow } from "electron";
import { createDesktopWindow } from "./desktop-window.js";
import { installDesktopCloseGuard } from "./desktop-close.js";
import { startIndependentService } from "./independent-service.js";

app.setName("MyCompanion");
let mainWindow: BrowserWindow | null = null;
let service: Awaited<ReturnType<typeof startIndependentService>> | null = null;
let closeGuard: ReturnType<typeof installDesktopCloseGuard> | undefined;

async function startApplication(): Promise<void> {
  service = await startIndependentService({
    dataRoot: app.getPath("userData"),
    rendererRoot: app.isPackaged ? join(process.resourcesPath, "renderer") : resolve(app.getAppPath(), "../renderer/dist"),
    storage: safeStorage,
  });
  mainWindow = await createDesktopWindow(service.origin, true, service.sessionToken);
  closeGuard = installDesktopCloseGuard(mainWindow, {
    beforeClose: async () => { await service?.stop(); service = null; },
    onError: error => dialog.showErrorBox("草稿尚未保存", `${error instanceof Error ? error.message : String(error)}\n窗口已保留；请检查本地服务或连接后重试关闭。`),
  });
  mainWindow.on("closed", () => { mainWindow = null; });
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.on("before-quit", event => {
    if (!service || closeGuard?.isApproved()) return;
    event.preventDefault();
    // CDP/renderer destruction can skip BrowserWindow's close event. After the
    // guard drains the surviving service, retry quit even without a live window.
    if (closeGuard) void closeGuard.requestClose().then(closed => { if (closed) app.quit(); });
    else void service.stop().then(() => { service = null; app.quit(); });
  });
  app.on("window-all-closed", () => app.quit());
  void app.whenReady().then(startApplication).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error && error.cause instanceof Error ? "\n" + error.cause.message : "";
    dialog.showErrorBox("MyCompanion 无法启动", "本地服务启动失败：" + message + cause);
    app.quit();
  });
}
