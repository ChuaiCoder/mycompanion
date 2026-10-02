import { describe, expect, it } from "vitest";

import { healthResponseSchema } from "@mycompanion/shared";

import { buildApp } from "./app.js";
import { apps } from "./test-helpers.js";

describe("GET /api/health", () => {
  it("returns a response that matches the shared API contract", async () => {
    const app = buildApp();
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/health",
    });

    expect(response.statusCode).toBe(200);
    expect(healthResponseSchema.parse(response.json())).toEqual({
      status: "ok",
      service: "mycompanion-local-service",
      version: "0.2.1",
    });
  });

  it("reports the targeted Tavern extension API version as a string", async () => {
    const app = buildApp(); apps.push(app);
    const response = await app.inject({ method: "GET", url: "/version" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ pkgVersion: "1.19.0" });
  });
});
