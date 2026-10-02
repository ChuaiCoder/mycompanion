import { randomInt } from "node:crypto";

/** Bind directly in the dynamic/private range. OS-assigned ports can include
 * Chromium-blocked service ports (observed: 6000 on Windows). */
export async function bindBrowserPort<T>(listen: (port: number) => Promise<T>): Promise<T> {
  const tried = new Set<number>();
  let failure: unknown;
  for (let attempt = 0; attempt < 32; attempt++) {
    let port = randomInt(49152, 65536);
    while (tried.has(port)) port = port === 65535 ? 49152 : port + 1;
    tried.add(port);
    try { return await listen(port); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE" && code !== "EACCES") throw error;
      failure = error;
    }
  }
  throw new Error("无法绑定可用的本地桌面端口。", { cause: failure });
}
