import type { ProviderConnectionResponse } from "@mycompanion/shared";
import { ModelRequestError } from "./model-request-error.js";

/** Provider bodies/status text can echo Authorization and must never become diagnostics. */
export function providerFailureDetails(status: number): NonNullable<ProviderConnectionResponse["issue"]> & { message: string } {
  if (status === 401 || status === 403) return { code: "AUTHENTICATION", field: "apiKey", message: "服务拒绝了 API Key。",
    suggestion: "检查密钥是否正确、仍有效，并具有所选模型的使用权限。", retryable: false };
  if (status === 404) return { code: "MODEL_NOT_FOUND", field: "model", message: "服务找不到所选模型或聊天接口。",
    suggestion: "核对模型名称及 API 地址是否包含正确的版本路径，例如 /v1。", retryable: false };
  if (status === 429) return { code: "RATE_LIMIT", field: "connection", message: "服务请求过于频繁或额度不足。",
    suggestion: "查看服务商额度与限流说明，稍后重试。", retryable: true };
  if (status >= 500) return { code: "SERVICE_UNAVAILABLE", field: "connection", message: "模型服务暂时不可用。",
    suggestion: "检查服务状态；本地模型请确认已经启动。", retryable: true };
  return { code: "REQUEST_REJECTED", field: "model", message: `服务拒绝了模型请求（HTTP ${status}）。`,
    suggestion: "检查所选模型是否支持当前接口和请求参数。", retryable: false };
}

export function providerHttpError(status: number): ModelRequestError {
  return new ModelRequestError(providerFailureDetails(status).message, status);
}

/** Some compatible providers send an error envelope even with HTTP 200. */
export function providerPayloadError(value: unknown): ModelRequestError | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  if (!Object.hasOwn(data, "error") || data.error == null || data.error === false) return undefined;
  const error = data.error && typeof data.error === "object" && !Array.isArray(data.error)
    ? data.error as Record<string, unknown> : {};
  const rawStatus = error.status ?? data.status ?? error.code;
  const status = typeof rawStatus === "number" && Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 502;
  return providerHttpError(status);
}
