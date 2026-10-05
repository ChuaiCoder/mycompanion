import type { ProviderConnectionResponse, ProviderModelsResponse, ProviderSettings } from "@mycompanion/shared";

/** 结果里带上可机读的失败类别，路由才能给出正确的状态码与修正建议。 */
export type ProviderModelsFailure = "authentication" | "no-model-list" | "timeout" | "connection" | "invalid-address";

export interface ProviderModelsResult extends ProviderModelsResponse {
  failure?: ProviderModelsFailure;
}

// 「测试获取模型」：按协议向服务商要一份可选模型名。
//
// 为什么必须分协议：这个请求以前只有 OpenAI 一种实现（GET /models + Authorization: Bearer），
// 对 Claude 和 Gemini 必然 401/404，于是"连接正常"的用户会看到"未连接"。这里的鉴权方式
// 与 provider-transport 的聊天请求保持一致，避免两处各写一套。

const TIMEOUT_MS = 15_000;

function modelsPath(baseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(`${baseUrl.replace(/\/+$/, "")}/models`);
  } catch {
    throw new Error("模型地址无效。");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("模型地址必须是 HTTP(S) 地址，且不能包含账号或密码。");
  }
  return parsed;
}

function authHeaders(settings: ProviderSettings, apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (!apiKey) return headers;
  if (settings.kind === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    headers["x-api-key"] = apiKey;
  } else if (settings.kind === "gemini") {
    headers["x-goog-api-key"] = apiKey;
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

/** 各家返回结构不同，这里各取所需并去重排序。 */
function readModels(settings: ProviderSettings, payload: unknown): string[] {
  const body = payload as {
    data?: Array<{ id?: unknown }>;
    models?: Array<{ name?: unknown }>;
  };
  if (settings.kind === "gemini") {
    return (body.models ?? [])
      .map(entry => typeof entry.name === "string" ? entry.name.replace(/^models\//, "") : undefined)
      .filter((name): name is string => Boolean(name));
  }
  return (body.data ?? [])
    .map(entry => typeof entry.id === "string" ? entry.id : undefined)
    .filter((id): id is string => Boolean(id));
}

export async function listProviderModels(
  settings: ProviderSettings,
  apiKey?: string,
): Promise<ProviderModelsResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(modelsPath(settings.baseUrl), {
      method: "GET",
      headers: authHeaders(settings, apiKey),
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403) {
        return { ok: false, failure: "authentication", message: "密钥被拒绝，请检查 API Key 是否正确、是否已启用。", models: [] };
      }
      if (response.status === 404) {
        return { ok: false, failure: "no-model-list", message: "该地址没有模型列表接口，请确认地址是否以 /v1 结尾。", models: [] };
      }
      return { ok: false, failure: "connection", message: `服务返回 ${response.status}，无法读取模型列表。`, models: [] };
    }
    const models = [...new Set(readModels(settings, await response.json()))].slice(0, 500).sort();
    return {
      ok: true,
      models,
      message: models.length > 0 ? `读取到 ${models.length} 个模型。` : "连接成功，但服务没有返回模型列表，请手动填写模型名。",
    };
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, failure: "timeout", message: "读取模型列表超时，请检查网络后重试。", models: [] };
    if (error instanceof Error && error.message.startsWith("模型地址")) {
      return { ok: false, failure: "invalid-address", message: error.message, models: [] };
    }
    return { ok: false, failure: "connection", message: "无法连接模型服务，请检查地址、网络和本地模型进程。", models: [] };
  } finally {
    clearTimeout(timer);
  }
}

/** 把失败类别翻成设置页能用的修正建议（与既有 providerIssue 结构一致）。 */
export function modelsFailureIssue(failure: ProviderModelsFailure, kind: ProviderSettings["kind"]): NonNullable<ProviderConnectionResponse["issue"]> {
  const local = kind === "ollama";
  switch (failure) {
    case "authentication":
      return { code: "AUTHENTICATION", field: "apiKey", retryable: false,
        suggestion: "这个密钥被服务拒绝了：请确认 Key 正确、已启用，并且属于当前地址对应的账号。" };
    case "no-model-list":
      return { code: "NO_MODEL_LIST", field: "baseUrl", retryable: false,
        suggestion: "该地址没有模型列表接口：请确认 Base URL 填的是 API 地址、通常以 /v1 结尾。" };
    case "timeout":
      return { code: "TIMEOUT", field: "connection", retryable: true,
        suggestion: "读取模型列表超时：检查网络；本地模型首次加载较慢，可稍后重试。" };
    case "invalid-address":
      return { code: "INVALID_ADDRESS", field: "baseUrl", retryable: false,
        suggestion: "模型服务地址无效：填写服务商提供的 HTTP(S) API 地址。" };
    default:
      return { code: "CONNECTION", field: "baseUrl", retryable: true,
        suggestion: local
          ? "无法连接本地模型服务：确认 Ollama 已启动，地址通常为 http://127.0.0.1:11434/v1。"
          : "无法连接模型服务：确认地址可访问、密钥有效。" };
  }
}
