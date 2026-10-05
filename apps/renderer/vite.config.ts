import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  build: { license: { fileName: "THIRD_PARTY_LICENSES.md" } },
  test: {
    environment: "jsdom",
    // Process CSS so tests can assert on the real stylesheet (see
    // src/test/stylesheet.test.ts). Without this, CSS imports resolve to empty.
    css: true,
    setupFiles: ["./src/test/setup.ts"],
  },
});
