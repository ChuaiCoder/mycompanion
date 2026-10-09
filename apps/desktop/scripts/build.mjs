import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDirectory, "..");
const outputFile = resolve(desktopRoot, "dist", "main.js");

await mkdir(dirname(outputFile), { recursive: true });
const entries = ["main.ts", "independent-service.ts", "desktop-window.ts", "desktop-close.ts"];
if (process.argv.includes("--reference-tavern")) throw new Error("The embedded Tavern build has been removed. Use the independent desktop build.");
await build({
  entryPoints: entries.map(file => resolve(desktopRoot, "src", file)),
  outdir: dirname(outputFile),
  bundle: true,
  platform: "node",
  format: "esm",
  // 代码分割：四个入口共享的依赖（local-service、gpt-tokenizer 的 BPE 表等约 9MB）
  // 抽成公共 chunk，不再每个入口各复制一份。
  splitting: true,
  target: "node22",
  external: ["electron", "node:*"],
  sourcemap: true,
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: "info",
});
