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

  // Tavern extensions use pkgVersion to choose their host API contract. This
  // is the compatibility baseline, distinct from MyCompanion's own version.
  app.get("/version", async (_request, reply) => reply.header("Cache-Control", "no-store")
    .send({ pkgVersion: "1.19.0" }));
}
