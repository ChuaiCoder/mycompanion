import type { FastifyInstance } from "fastify";
import {
  providerConnectionResponseSchema,
  providerModelsResponseSchema,
  providerSettingsSchema,
  listProviderModelsRequestSchema,
  updateProviderSettingsSchema,
  type ApiErrorResponse,
} from "@mycompanion/shared";

import { ModelRequestError, testProviderConnection } from "../providers/model-client.js";
import type { RuntimeRepository } from "../persistence/runtime-repository.js";
import { sendError } from "../http-errors.js";
import type { SecretCodec } from "../route-types.js";
import { probeProvider } from "../providers/provider-probe.js";
import { listProviderModels, modelsFailureIssue } from "../providers/provider-models.js";
import { sameProviderCredentialScope } from "../providers/provider-credential-scope.js";

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

  // 「测试获取模型」：按协议拉取该服务商真实可用的模型名。
  // 允许带草稿设置（还没保存也能先试），未带草稿时用已保存的设置与密钥。
  app.post<{ Body: unknown }>("/api/settings/provider/models", async (request, reply) => {
    const emptyBody = request.body == null || (typeof request.body === "object" && !Array.isArray(request.body) && !Object.keys(request.body).length);
    let settings = runtime.getProvider();
    let apiKey: string | undefined;
    if (emptyBody) {
      const encrypted = runtime.getEncryptedApiKey();
      if (encrypted) {
        if (!secretCodec) return sendError(reply, 503, "SECRET_STORAGE_UNAVAILABLE", "系统安全存储不可用，无法读取 API Key。");
        try { apiKey = secretCodec.unseal(encrypted); }
        catch { return sendError(reply, 503, "SECRET_STORAGE_UNAVAILABLE", "已保存密钥无法读取，请重新填写 API Key。"); }
      }
    } else {
      // 用宽松校验：获取模型列表时模型名还不知道，不能按写入规则要求非空。
      const parsed = listProviderModelsRequestSchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "INVALID_PROVIDER_SETTINGS", "模型设置无效，请检查地址与协议。");
      const draft = parsed.data;
      settings = { ...settings, kind: draft.kind, baseUrl: draft.baseUrl, model: draft.model };
      apiKey = draft.clearApiKey ? undefined : draft.apiKey || undefined;
      // 不把已保存的密钥发往用户新填的服务地址。
      if (!apiKey && !draft.clearApiKey && sameProviderCredentialScope(draft, runtime.getProvider())) {
        const encrypted = runtime.getEncryptedApiKey();
        if (encrypted && secretCodec) {
          try { apiKey = secretCodec.unseal(encrypted); }
          catch { return sendError(reply, 503, "SECRET_STORAGE_UNAVAILABLE", "已保存密钥无法读取，请重新填写 API Key。"); }
        }
      }
    }
    return providerModelsResponseSchema.parse(await listProviderModels(settings, apiKey));
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
    // 无草稿时按协议分派：openai-compatible / ollama 沿用既有的 OpenAI 版探测
    // （保持 401 + AUTHENTICATION 的既有契约），Claude 与 Gemini 走各协议实现——
    // 它们以前被这条 OpenAI 专用路径必然测失败，于是配置正常也显示「未连接」。
    if (settings.kind === "anthropic" || settings.kind === "gemini") {
      const encrypted = runtime.getEncryptedApiKey();
      let apiKey: string | undefined;
      if (encrypted) {
        if (!secretCodec) return sendError(reply, 503, "SECRET_STORAGE_UNAVAILABLE", "系统安全存储不可用，无法读取 API Key。");
        try { apiKey = secretCodec.unseal(encrypted); }
        catch { return sendError(reply, 503, "SECRET_STORAGE_UNAVAILABLE", "已保存密钥无法读取，请重新填写 API Key。"); }
      }
      const result = await listProviderModels(settings, apiKey);
      if (result.ok) {
        return providerConnectionResponseSchema.parse({
          ok: true,
          models: result.models,
          message: result.models.length > 0 ? `连接成功，读取到 ${result.models.length} 个模型。` : "连接成功；服务没有返回模型列表。",
        });
      }
      const issue = modelsFailureIssue(result.failure ?? "connection", settings.kind);
      if (issue.code === "AUTHENTICATION") return sendError(reply, 401, "PROVIDER_CONNECTION_FAILED", result.message);
      return providerConnectionResponseSchema.parse({ ok: false, message: result.message, models: [], issue });
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
