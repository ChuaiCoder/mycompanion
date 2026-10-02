import type { ProviderConnectionResponse, ProviderSettings } from "@mycompanion/shared";
import { requestChatCompletion } from "./model-client.js";

function failure(code: string, field: "baseUrl" | "apiKey" | "model" | "connection", message: string,
  suggestion: string, retryable = false): ProviderConnectionResponse {
  return { ok: false, message, models: [], issue: { code, field, suggestion, retryable } };
}

/** Read-only draft check: exercise the selected model, never persist test settings or replies. */
export async function probeProvider(settings: ProviderSettings, apiKey?: string, timeoutMs = 15_000): Promise<ProviderConnectionResponse> {
  try {
    const url = new URL(settings.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("invalid address");
  } catch {
    return failure("INVALID_ADDRESS", "baseUrl", "模型服务地址无效。", "填写服务商提供的 HTTP(S) API 地址；Ollama 通常为 http://127.0.0.1:11434/v1。");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await requestChatCompletion(settings.baseUrl, {
      model: settings.model, messages: [{ role: "user", content: "Reply with OK." }],
      max_tokens: 16, stream: false,
    }, controller.signal, apiKey);
    if ([401, 403].includes(response.status))
      return failure("AUTHENTICATION", "apiKey", "服务拒绝了 API Key。", "检查密钥是否正确、仍有效，并具有所选模型的使用权限。");
    if (response.status === 404)
      return failure("MODEL_NOT_FOUND", "model", "服务找不到所选模型或聊天接口。", "核对模型名称及 API 地址是否包含正确的版本路径，例如 /v1。");
    if (response.status === 429)
      return failure("RATE_LIMIT", "connection", "服务请求过于频繁或额度不足。", "查看服务商额度与限流说明，稍后重试。", true);
    if (response.status >= 500)
      return failure("SERVICE_UNAVAILABLE", "connection", "模型服务暂时不可用。", "检查服务状态；本地模型请确认已经启动。", true);
    if (!response.ok)
      return failure("REQUEST_REJECTED", "model", `服务拒绝了聊天测试（HTTP ${response.status}）。`, "检查所选模型是否支持 OpenAI 兼容的聊天接口。");
    let data: { choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }> };
    try { data = await response.json(); }
    catch {
      if (controller.signal.aborted) throw controller.signal.reason;
      return failure("INVALID_RESPONSE", "baseUrl", "服务返回了无法识别的响应。", "核对 API 地址是否为聊天接口，而非服务网站或登录页面。");
    }
    const choice = data && Array.isArray(data.choices) ? data.choices[0] : undefined;
    if (typeof choice?.message?.content !== "string" || !choice.message.content.trim()
      || (choice.finish_reason != null && !["stop", "length"].includes(String(choice.finish_reason))))
      return failure("INVALID_RESPONSE", "model", "模型没有返回可用的聊天文本。", "选择支持文本聊天的模型，或检查接口协议配置。");
    return { ok: true, message: "所选模型已返回测试回复，可以开始聊天。", models: [],
      testedModel: settings.model, capability: "chat-completion" };
  } catch {
    return controller.signal.aborted
      ? failure("TIMEOUT", "connection", "模型测试超时。", "检查网络和模型状态；本地模型首次加载后重试。", true)
      : failure("CONNECTION", "baseUrl", "无法连接模型服务。", "检查 API 地址、网络或本地模型进程。", true);
  } finally { clearTimeout(timer); }
}
