import type { FastifyInstance } from "fastify";
import {
  providerConnectionResponseSchema,
  providerSettingsSchema,
  updateProviderSettingsSchema,
  type ApiErrorResponse,
} from "@mycompanion/shared";

import { ModelRequestError, testProviderConnection } from "./model-client.js";
import type { RuntimeRepository } from "./runtime-repository.js";
import { sendError } from "./http-errors.js";
import type { SecretCodec } from "./route-types.js";
import { probeProvider } from "./provider-probe.js";
import { sameProviderCredentialScope } from "./provider-credential-scope.js";

export function registerSettingsRoutes(app: FastifyInstance, runtime: RuntimeRepository, secretCodec?: SecretCodec): void {
  app.get("/api/settings/provider", async () => {
    return providerSettingsSchema.parse(runtime.getProvider());
  });

  app.put<{ Body: unknown }>("/api/settings/provider", async (request, reply) => {
    const result = updateProviderSettingsSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({
        error: {
          code: "INVALID_PROVIDER_SETTINGS",
          message: "模型设置无效。",
          details: result.error.issues.map((issue) => issue.message),
        },
      } satisfies ApiErrorResponse);
    }
    try {
      const url = new URL(result.data.baseUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error("invalid URL");
      }
    } catch {
      return sendError(reply, 400, "INVALID_PROVIDER_URL", "Base URL 必须是有效的 HTTP(S) 地址，且不能包含账号或密码。");
    }
    if (result.data.apiKey && !secretCodec) {
      return sendError(reply, 503, "SECRET_STORAGE_UNAVAILABLE", "系统安全存储不可用，API Key 未保存。");
    }
    const encrypted = result.data.apiKey
      ? secretCodec?.seal(result.data.apiKey)
      : undefined;
    return providerSettingsSchema.parse(runtime.saveProvider(result.data, encrypted));
  });

  app.post<{ Body: unknown }>("/api/settings/provider/test", async (request, reply) => {
    const settings = runtime.getProvider();
    const emptyBody = request.body == null || (typeof request.body === "object" && !Array.isArray(request.body) && !Object.keys(request.body).length);
    if (!emptyBody) {
      const parsed = updateProviderSettingsSchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "INVALID_PROVIDER_SETTINGS", "模型设置无效，请检查地址、模型及高级参数。");
      let apiKey = parsed.data.clearApiKey ? undefined : parsed.data.apiKey || undefined;
      // Never send a saved credential to a newly typed service endpoint.
      if (!apiKey && !parsed.data.clearApiKey && sameProviderCredentialScope(parsed.data, settings)) {
        const encrypted = runtime.getEncryptedApiKey();
        if (encrypted) {
          if (!secretCodec) return sendError(reply, 503, "SECRET_STORAGE_UNAVAILABLE", "系统安全存储不可用，无法读取 API Key。");
          try { apiKey = secretCodec.unseal(encrypted); }
          catch { return sendError(reply, 503, "SECRET_STORAGE_UNAVAILABLE", "已保存密钥无法读取，请重新填写 API Key。"); }
        }
      }
      return providerConnectionResponseSchema.parse(await probeProvider({ ...parsed.data, hasApiKey: !!apiKey }, apiKey));
    }
    try {
      const encrypted = runtime.getEncryptedApiKey();
      const apiKey = encrypted ? secretCodec?.unseal(encrypted) : undefined;
      const result = await testProviderConnection(settings, apiKey);
      return providerConnectionResponseSchema.parse({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof ModelRequestError
        ? error.message
        : "连接检查失败。";
      return sendError(reply, error instanceof ModelRequestError ? error.statusCode : 502, "PROVIDER_CONNECTION_FAILED", message);
    }
  });
}
