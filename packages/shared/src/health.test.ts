import { describe, expect, it } from "vitest";

import { healthResponseSchema } from "./health.js";

describe("healthResponseSchema", () => {
  it("accepts the internal local-service health response", () => {
    const result = healthResponseSchema.parse({
      status: "ok",
      service: "mycompanion-local-service",
      version: "0.1.0",
    });

    expect(result.status).toBe("ok");
  });

  it("rejects responses with a different service identity", () => {
    expect(() =>
      healthResponseSchema.parse({
        status: "ok",
        service: "unexpected-service",
        version: "0.1.0",
      }),
    ).toThrow();
  });
});
