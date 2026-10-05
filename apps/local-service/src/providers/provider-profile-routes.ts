import type { FastifyInstance } from "fastify";
import { providerProfilesSchema, providerProfileSchema, saveProviderProfileSchema, updateProviderTaskAssignmentsSchema,
  updateProviderSettingsSchema } from "@mycompanion/shared";
import type { RuntimeRepository } from "./runtime-repository.js";
import type { SecretCodec } from "./route-types.js";
import { sameProviderCredentialScope } from "./provider-credential-scope.js";
import { probeProvider } from "./provider-probe.js";
import { sendError } from "./http-errors.js";
import { embedTexts, EmbeddingRequestError } from "./embedding-client.js";
import { providerFailureDetails } from "./provider-errors.js";

const validUrl = (value: string): boolean => {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
};

export function registerProviderProfileRoutes(app: FastifyInstance, runtime: RuntimeRepository, codec?: SecretCodec): void {
  app.get("/api/settings/providers", async (_request, reply) => reply.header("Cache-Control", "no-store").send(providerProfilesSchema.parse(runtime.providers.list())));
  app.post<{ Body: unknown }>("/api/settings/providers", async (request, reply) => {
    const parsed = saveProviderProfileSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_PROVIDER_SETTINGS", "模型连接配置无效。");
    if (!validUrl(parsed.data.settings.baseUrl)) return sendError(reply, 400, "INVALID_PROVIDER_URL", "模型地址必须是 HTTP(S)，且不能包含账号或密码。");
    if (parsed.data.settings.apiKey && !codec) return sendError(reply, 503, "SECRET_STORAGE_UNAVAILABLE", "系统安全存储不可用，API Key 未保存。");
    const encrypted = parsed.data.settings.apiKey ? codec?.seal(parsed.data.settings.apiKey) : undefined;
    return reply.status(201).send(providerProfileSchema.parse(runtime.providers.create(parsed.data.name, parsed.data.settings, encrypted)));
  });
  app.put<{ Params: { id: string }; Body: unknown }>("/api/settings/providers/:id", async (request, reply) => {
    if (!runtime.providers.get(request.params.id)) return sendError(reply, 404, "PROVIDER_NOT_FOUND", "模型连接不存在。");
    const parsed = saveProviderProfileSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_PROVIDER_SETTINGS", "模型连接配置无效。");
    if (!validUrl(parsed.data.settings.baseUrl)) return sendError(reply, 400, "INVALID_PROVIDER_URL", "模型地址必须是 HTTP(S)，且不能包含账号或密码。");
    if (parsed.data.settings.apiKey && !codec) return sendError(reply, 503, "SECRET_STORAGE_UNAVAILABLE", "系统安全存储不可用，API Key 未保存。");
    const encrypted = parsed.data.settings.apiKey ? codec?.seal(parsed.data.settings.apiKey) : undefined;
    return providerProfileSchema.parse(runtime.providers.save(request.params.id, parsed.data.name, parsed.data.settings, encrypted));
  });
  app.delete<{ Params: { id: string } }>("/api/settings/providers/:id", async (request, reply) => {
    const result = runtime.withTransaction(() => runtime.providers.delete(request.params.id));
    if (result === "missing") return sendError(reply, 404, "PROVIDER_NOT_FOUND", "模型连接不存在。");
    if (result === "last") return sendError(reply, 409, "LAST_PROVIDER", "至少保留一个聊天连接；可以修改当前连接。");
    return providerProfilesSchema.parse(runtime.providers.list());
  });
  app.patch<{ Body: unknown }>("/api/settings/provider-tasks", async (request, reply) => {
    const parsed = updateProviderTaskAssignmentsSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_PROVIDER_TASKS", "模型任务配置无效。");
    try { runtime.providers.assign(parsed.data); }
    catch { return sendError(reply, 400, "PROVIDER_NOT_FOUND", "任务关联的模型连接不存在。"); }
    return providerProfilesSchema.parse(runtime.providers.list());
  });
  app.post<{ Params: { id: string }; Body: unknown }>("/api/settings/providers/:id/test", async (request, reply) => {
    const profile = runtime.providers.get(request.params.id);
    if (!profile) return sendError(reply, 404, "PROVIDER_NOT_FOUND", "模型连接不存在。");
    const parsed = updateProviderSettingsSchema.safeParse(request.body ?? profile.settings);
    if (!parsed.success) return sendError(reply, 400, "INVALID_PROVIDER_SETTINGS", "模型连接配置无效。");
    let key = parsed.data.clearApiKey ? undefined : parsed.data.apiKey || undefined;
    if (!key && !parsed.data.clearApiKey && sameProviderCredentialScope(parsed.data, profile.settings)) {
      const encrypted = runtime.getEncryptedApiKey(profile.id);
      if (encrypted) {
        if (!codec) return sendError(reply, 503, "SECRET_STORAGE_UNAVAILABLE", "系统安全存储不可用，无法读取 API Key。");
        try { key = codec.unseal(encrypted); }
        catch { return sendError(reply, 503, "SECRET_STORAGE_UNAVAILABLE", "已保存密钥无法读取，请重新填写 API Key。"); }
      }
    }
    if (request.body && typeof request.body === "object" && (request.body as Record<string, unknown>).task === "embedding") {
      try {
        await embedTexts(parsed.data, ["Connection test"], { apiKey: key });
        return { ok: true, message: "Embedding 模型已返回有效向量。", models: [], testedModel: parsed.data.model, capability: "embedding" };
      } catch (error) {
        if (error instanceof EmbeddingRequestError && error.status) {
          const { message, ...issue } = providerFailureDetails(error.status);
          return { ok: false, message, models: [], issue };
        }
        return { ok: false, message: "Embedding 模型没有返回有效向量。", models: [], issue: { code: "INVALID_RESPONSE", field: "model",
          suggestion: "选择支持 Embedding 的模型并检查连接地址；聊天模型通常不能用于此任务。", retryable: false } };
      }
    }
    return probeProvider({ ...parsed.data, hasApiKey: Boolean(key) }, key);
  });
}
