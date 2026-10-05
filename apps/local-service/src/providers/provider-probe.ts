import type { ProviderConnectionResponse, ProviderSettings } from "@mycompanion/shared";
import { normalizeChatCompletionRequest } from "./chat-completion-request.js";
import { requestProviderCompletion } from "./provider-transport.js";
import { decodeProviderReply } from "./provider-response.js";
import { providerFailureDetails, providerPayloadError } from "./provider-errors.js";

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
    const transport=normalizeChatCompletionRequest({
      model: settings.model, messages: [{ role: "user", content: "Reply with OK." }],
      max_tokens: 16, stream: false,
    },settings,apiKey);
    const response = await requestProviderCompletion(transport,controller.signal);
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const { message, ...issue } = providerFailureDetails(response.status);
      return { ok: false, message, models: [], issue };
    }
    let data: { choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }> };
    try { data = await response.json(); }
    catch {
      if (controller.signal.aborted) throw controller.signal.reason;
      return failure("INVALID_RESPONSE", "baseUrl", "服务返回了无法识别的响应。", "核对 API 地址是否为聊天接口，而非服务网站或登录页面。");
    }
    const providerError = providerPayloadError(data);
    if (providerError) {
      const { message, ...issue } = providerFailureDetails(providerError.statusCode);
      return { ok: false, message, models: [], issue };
    }
    const decoded=decodeProviderReply(transport.protocol,data);
    if (!decoded.text.trim() || !["stop","length","response"].includes(decoded.finishReason))
      return failure("INVALID_RESPONSE", "model", "模型没有返回可用的聊天文本。", "选择支持文本聊天的模型，或检查接口协议配置。");
    return { ok: true, message: "所选模型已返回测试回复，可以开始聊天。", models: [],
      testedModel: settings.model, capability: "chat-completion" };
  } catch {
    return controller.signal.aborted
      ? failure("TIMEOUT", "connection", "模型测试超时。", "检查网络和模型状态；本地模型首次加载后重试。", true)
      : failure("CONNECTION", "baseUrl", "无法连接模型服务。", "检查 API 地址、网络或本地模型进程。", true);
  } finally { clearTimeout(timer); }
}
