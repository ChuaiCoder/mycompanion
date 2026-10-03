import type { FastifyInstance } from "fastify";
import { healthResponseSchema, type HealthResponse } from "@mycompanion/shared";

export function registerHealthRoutes(app: FastifyInstance, packageVersion: string): void {
  app.get<{ Reply: HealthResponse }>("/api/health", async () => {
    return healthResponseSchema.parse({
      status: "ok",
      service: "mycompanion-local-service",
      version: packageVersion,
    });
  });
}
