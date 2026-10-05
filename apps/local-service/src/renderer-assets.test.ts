import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { apps } from "./testing/helpers.js";

describe("desktop renderer assets", () => {
  it("serves the bundled renderer entry point with desktop security headers", async () => {
    const rendererRoot = mkdtempSync(join(tmpdir(), "mycompanion-renderer-test-"));
    writeFileSync(join(rendererRoot, "index.html"), "<!doctype html><title>Desktop</title>");
    try {
      const app = buildApp({ rendererRoot });
      apps.push(app);

      const response = await app.inject({ method: "GET", url: "/" });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("<title>Desktop</title>");
      expect(response.headers["content-security-policy"]).toBeUndefined();
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
    } finally {
      rmSync(rendererRoot, { force: true, recursive: true });
    }
  });
});
