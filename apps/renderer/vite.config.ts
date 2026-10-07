import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

import { vendorChunkOf } from "./chunking.js";

export default defineConfig({
  plugins: [react()],
  build: {
    license: { fileName: "THIRD_PARTY_LICENSES.md" },
    rollupOptions: {
      // 按角色拆分产物（策略与理由见 chunking.ts）。
      output: { manualChunks: (id: string) => vendorChunkOf(id) },
    },
  },
  test: {
    environment: "jsdom",
    // Process CSS so tests can assert on the real stylesheet (see
    // src/test/stylesheet.test.ts). Without this, CSS imports resolve to empty.
    css: true,
    setupFiles: ["./src/test/setup.ts"],
  },
});
