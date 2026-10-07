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

  // 兼容端点：卡自带的运行时（实测 MVU 的 _wait_init）会请求 `/version` 并读取
  // `pkgVersion`，这是酒馆前端的既有接口。缺少它时该步骤失败，可能中断整段初始化。
  // 只回本应用版本，不模拟酒馆的其他字段。
  app.get("/version", async (_request, reply) => {
    return reply.header("Cache-Control", "no-store").send({
      pkgVersion: packageVersion,
      agent: "mycompanion",
    });
  });
}
