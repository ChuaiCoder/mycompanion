import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { createSessionToken, SESSION_TOKEN_HEADER, sessionTokenMatches } from "./auth-token.js";
import { apps } from "./testing/helpers.js";

describe("session token guard", () => {
  it("rejects requests without a token when one is configured", async () => {
    const app = buildApp({ sessionToken: createSessionToken() });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: { code: "UNAUTHORIZED", message: "缺少或无效的会话令牌。" } });
  });

  it("rejects a wrong token", async () => {
    const app = buildApp({ sessionToken: createSessionToken() });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { [SESSION_TOKEN_HEADER]: createSessionToken() },
    });

    expect(response.statusCode).toBe(401);
  });

  it("accepts the configured token", async () => {
    const token = createSessionToken();
    const app = buildApp({ sessionToken: token });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { [SESSION_TOKEN_HEADER]: token },
    });

    expect(response.statusCode).toBe(200);
  });

  it("also protects non-API routes such as /version", async () => {
    const app = buildApp({ sessionToken: createSessionToken() });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/version" });

    expect(response.statusCode).toBe(401);
  });

  it("protects the hosted renderer assets as well", async () => {
    const rendererRoot = mkdtempSync(join(tmpdir(), "mycompanion-auth-test-"));
    writeFileSync(join(rendererRoot, "index.html"), "<!doctype html><title>Desktop</title>");
    try {
      const token = createSessionToken();
      const app = buildApp({ sessionToken: token, rendererRoot });
      apps.push(app);

      const rejected = await app.inject({ method: "GET", url: "/" });
      expect(rejected.statusCode).toBe(401);

      const accepted = await app.inject({
        method: "GET",
        url: "/",
        headers: { [SESSION_TOKEN_HEADER]: token },
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.body).toContain("<title>Desktop</title>");
    } finally {
      rmSync(rendererRoot, { force: true, recursive: true });
    }
  });

  it("leaves the service open when no token is configured", async () => {
    const app = buildApp();
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
  });

  it("compares tokens without length-dependent shortcuts", () => {
    const token = createSessionToken();
    expect(sessionTokenMatches(token, token)).toBe(true);
    expect(sessionTokenMatches(token.slice(1), token)).toBe(false);
    expect(sessionTokenMatches("", token)).toBe(false);
    expect(sessionTokenMatches(undefined, token)).toBe(false);
    expect(sessionTokenMatches([token], token)).toBe(false);
  });
});
