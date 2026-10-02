import { type NativeCompletionRequest } from "@mycompanion/shared";
import { measureChatCompletionRequest, assertChatCompletionBudget } from "./chat-completion-budget.js";
import { normalizeChatCompletionRequest } from "./chat-completion-request.js";
import { ModelRequestError } from "./model-request-error.js";
import { MacroVariableConflictError } from "./macro-variable-conflict.js";
export { ModelRequestError } from "./model-request-error.js";
import type {
  ChatMessage,
  CharacterDetail,
  InstalledPlugin,
  LorebookReport,
  MemoryRetrievalReport,
  ProviderSettings,
  ExtensionPrompt,
} from "@mycompanion/shared";

import type { PromptBudgetReport } from "./prompt-budget.js";
import { getPersonaUserName } from "./power-user-core.js";
import { macroVariableStores, MacroEvaluationSession } from "./prompt-macros.js";
import type { RawChatRequest } from "./raw-generation.js";
import { createParser } from "eventsource-parser";
import { readPromptManagerSettings } from "./prompt-manager-core.js";
import { assembleManagedModelPrompt } from "./managed-prompt-assembly.js";

export interface ModelCompletionEnd {
  finishReason: string;
  completionOutcome: "complete" | "truncated" | "incomplete";
}

function completionEnd(reason: string): ModelCompletionEnd {
  return { finishReason: reason, completionOutcome: reason === "length" ? "truncated"
    : ["stop", "done", "response"].includes(reason) ? "complete" : "incomplete" };
}

export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
  name?: string;
}

function endpoint(baseUrl: string, path: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ModelRequestError("模型地址无效，请在设置中检查 Base URL。", 400);
  }
  if (!(["http:", "https:"] as string[]).includes(parsed.protocol)) {
    throw new ModelRequestError("模型地址只能使用 HTTP 或 HTTPS。", 400);
  }
  if (parsed.username || parsed.password) {
    throw new ModelRequestError("请不要把账号或密钥写在模型地址中。", 400);
  }
  parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
  parsed.search = "";
  parsed.hash = "";
  return parsed;
}

function headers(apiKey?: string): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    const value = typeof body.error === "string"
      ? body.error
      : typeof body.error?.message === "string"
        ? body.error.message
        : typeof body.message === "string"
          ? body.message
          : "";
    if (value) return value.slice(0, 500);
  } catch {
    // Provider responses are untrusted; fall back to the status line.
  }
  return `${response.status} ${response.statusText}`.trim();
}

async function fetchWithTimeout(url: URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal });
  } catch (error) {
    if (init.signal?.aborted) throw init.signal.reason;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ModelRequestError("模型请求超时，请检查服务状态或缩短上下文。", 504);
    }
    throw new ModelRequestError("无法连接模型服务，请检查地址、网络和本地模型进程。", 502);
  } finally {
    clearTimeout(timer);
  }
}

export function requestChatCompletion(baseUrl: string, body: Record<string, unknown>, signal: AbortSignal, apiKey?: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const requestHeaders = new Headers(headers(apiKey));
  for (const [name, value] of Object.entries(extraHeaders)) requestHeaders.set(name, value);
  return fetch(endpoint(baseUrl, "chat/completions"), { method: "POST", headers: requestHeaders, signal, body: JSON.stringify(body) });
}

export async function testProviderConnection(
  settings: ProviderSettings,
  apiKey?: string,
): Promise<{ message: string; models: string[] }> {
  const response = await fetchWithTimeout(endpoint(settings.baseUrl, "models"), {
    method: "GET",
    headers: headers(apiKey),
  }, 15_000);
  if (!response.ok) {
    throw new ModelRequestError(`模型服务拒绝连接：${await errorMessage(response)}`, response.status);
  }
  const data = await response.json() as { data?: Array<{ id?: unknown }> };
  const models = Array.isArray(data.data)
    ? data.data.flatMap((item) => typeof item.id === "string" ? [item.id] : []).slice(0, 500)
    : [];
  return {
    message: models.length > 0
      ? `连接成功，读取到 ${models.length} 个模型。`
      : "连接成功；服务没有返回模型列表。",
    models,
  };
}

/**
 * 非流式补全（FR-MEM-002/006）：记忆提取与阶段摘要用。
 * 失败时抛 ModelRequestError，调用方负责降级（摘要失败不得阻止正常聊天）。
 */
export async function completeText(options: {
  settings: ProviderSettings;
  apiKey?: string;
  signal?: AbortSignal;
  messages: ModelMessage[];
}): Promise<string> {
  const response = await fetchWithTimeout(
    endpoint(options.settings.baseUrl, "chat/completions"),
    {
      method: "POST",
      headers: headers(options.apiKey),
      ...(options.signal ? { signal: options.signal } : {}),
      body: JSON.stringify({
        model: options.settings.model,
        messages: options.messages,
        temperature: 0.2,
        max_tokens: Math.min(options.settings.maxTokens, 1_024),
        stream: false,
      }),
    },
    60_000,
  );
  if (!response.ok) {
    throw new ModelRequestError(`模型补全失败：${await errorMessage(response)}`, response.status);
  }
  const data = await response.json() as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new ModelRequestError("模型返回了空内容或不兼容的响应格式。", 502);
  }
  return content.trim();
}

// Unlike memory extraction, raw generation uses the configured sampling and
// token limit. The timeout covers the response body as well as response headers.
export async function completeRawChat(options: RawChatRequest & {
  settings: ProviderSettings; apiKey?: string; signal: AbortSignal;
}): Promise<Record<string, unknown>> {
  const timeout = AbortSignal.timeout(120_000);
  const signal = AbortSignal.any([options.signal, timeout]);
  try {
    const schema = options.jsonSchema;
    const response = await fetch(endpoint(options.settings.baseUrl, "chat/completions"), {
      method: "POST", headers: headers(options.apiKey), signal,
      body: JSON.stringify({ model: options.settings.model, messages: options.messages,
        temperature: options.settings.temperature, max_tokens: options.responseLength ?? options.settings.maxTokens, stream: false,
        ...(schema ? { response_format: { type: "json_schema", json_schema: {
          name: schema.name, schema: schema.value,
          ...(schema.description !== undefined ? { description: schema.description } : {}),
          ...(schema.strict !== undefined ? { strict: schema.strict } : {}),
        } } } : {}),
      }),
    });
    if (!response.ok) throw new ModelRequestError(`模型生成失败：${await errorMessage(response)}`, response.status);
    const data: unknown = await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new ModelRequestError("模型返回了不兼容的响应格式。", 502);
    return data as Record<string, unknown>;
  } catch (error) {
    if (options.signal.aborted) throw options.signal.reason;
    if (timeout.aborted) throw new ModelRequestError("模型请求超时。", 504);
    if (error instanceof ModelRequestError) throw error;
    throw new ModelRequestError("无法读取模型响应，请检查服务地址和响应格式。", 502);
  }
}

interface MacroContext {
  experimentalMacroEngine?: boolean;
  macroSession?: MacroEvaluationSession;
  characterName: string;
  userName: string;
  model: string;
  contextLimitTokens: number;
  maxResponseTokens: number;
  // 同一轮生成内固定，保证 {{date}}/{{time}} 与 {{random}} 的结果稳定。
  now: Date;
  localVariables?: Record<string, unknown>;
  globalVariables?: Record<string, unknown>;
}

// FR-PROMPT-004 预览脱敏：凭据（密钥、Bearer 头）与内部敏感字段不进入提示词，
// 这里再做一层防御性替换，避免角色卡/插件内容里意外携带的密钥被原样展示。
const REDACTION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /sk-[A-Za-z0-9_-]{8,}/g, label: "密钥" },
  { pattern: /Bearer\s+[A-Za-z0-9._-]{8,}/gi, label: "Bearer" },
  { pattern: /\b(api[_-]?key|apikey)\b\s*[:=]\s*["']?[A-Za-z0-9._-]{8,}["']?/gi, label: "apiKey 字段" },
];

function redact(text: string, apiKey?: string): { text: string; redactions: number } {
  let redacted = text;
  let redactions = 0;
  if (apiKey && apiKey.length >= 8) {
    const parts = redacted.split(apiKey);
    if (parts.length > 1) {
      redacted = parts.join("••••");
      redactions += parts.length - 1;
    }
  }
  for (const { pattern } of REDACTION_PATTERNS) {
    const matches = redacted.match(pattern);
    if (matches) {
      redacted = redacted.replace(pattern, "••••");
      redactions += matches.length;
    }
  }
  return { text: redacted, redactions };
}

export interface PromptAssemblyOptions {
  generationType?: string;
  quietPrompt?: string;
  bias?: string;
  messageExamples?: ModelMessage[][];
  macroSession?: MacroEvaluationSession;
  /** Native generation begins with an eager card read; public assembly does not. */
  prepareNativeCharacterFields?: boolean;
  skipAuthorNote?: boolean;
  extensionPrompts?: ExtensionPrompt[];
  /** One-request persona override supplied by a compatible extension. */
  personaDescriptionOverride?: string;
  chatMetadata?: Record<string, unknown>;
  /** Extension assembly already carries its one-request character overrides. */
  characterOverridesResolved?: boolean;
  extensionSettings?: Record<string, unknown>;
  userTurnCount?: number;
  settings: ProviderSettings;
  character: CharacterDetail;
  plugins: InstalledPlugin[];
  lorebook: LorebookReport;
  memory: MemoryRetrievalReport;
  stageSummary?: string;
  history: ChatMessage[];
}

export function characterWithChatOverrides(
  character: CharacterDetail,
  metadata: Record<string, unknown>,
): CharacterDetail {
  const field = (key: string, original: string): string => {
    const value = metadata[key];
    return typeof value === "string" && value.length > 0 ? value.trim() : original;
  };
  return { ...character,
    scenario: field("scenario", character.scenario),
    systemPrompt: field("system_prompt", character.systemPrompt),
    exampleDialogue: field("mes_example", character.exampleDialogue),
  };
}

/**
 * 组装一次生成的提示词（与 streamReply 共用，FR-PROMPT-002/003）。
 * 不发送请求；宏副作用仅写本轮草稿，持久化由生成入口在校验通过后提交。
 */
export function assembleModelPrompt(options: PromptAssemblyOptions) {
  const sourceCharacter = options.characterOverridesResolved ? options.character
    : characterWithChatOverrides(options.character, options.chatMetadata ?? {});
  const macroContext: MacroContext = {
    macroSession: options.macroSession ?? new MacroEvaluationSession(options.chatMetadata, options.extensionSettings),
    characterName: sourceCharacter.name,
    userName: getPersonaUserName(options.extensionSettings ?? {}, options.chatMetadata ?? {}),
    model: options.settings.model,
    contextLimitTokens: options.settings.contextLimitTokens,
    maxResponseTokens: options.settings.maxTokens,
    now: new Date(),
    ...macroVariableStores(options.chatMetadata ?? {}, options.extensionSettings ?? {}),
  };
  return assembleManagedModelPrompt(options, sourceCharacter,
    readPromptManagerSettings(options.extensionSettings ?? {}), macroContext.macroSession!);
}

/**
 * 发送前的提示词预览（FR-PROMPT-004）：与真实请求相同的组装与预算，
 * 但把即将发送的草稿作为“当前用户输入”参与计算；凭据与内部敏感字段脱敏，
 * 并给出每个区域的 token 估算与总计数。
 */
export function buildPromptPreview(options: PromptAssemblyOptions & {
  draft?: string;
  apiKey?: string;
}): {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  regions: Pick<PromptBudgetReport["regions"][number], "key" | "label" | "tokens">[];
  totalTokens: number;
  recentMessageCount: number;
  redactions: number;
  diagnostics: string[];
} {
  const draft = options.draft?.trim();
  const history = draft
    ? [...options.history, {
        id: crypto.randomUUID(),
        conversationId: options.history.at(-1)?.conversationId ?? "",
        branchId: options.history.at(-1)?.branchId ?? "",
        parentMessageId: options.history.at(-1)?.id ?? null,
        role: "user" as const,
        content: draft,
        status: "complete" as const,
        createdAt: new Date().toISOString(),
      }]
    : options.history;
  const { budget, messages } = assembleModelPrompt({ ...options, history });
  let redactions = 0;
  const preview = messages.map((message) => {
    const result = redact(message.content, options.apiKey);
    redactions += result.redactions;
    return { role: message.role, content: result.text, ...(message.name ? { name: message.name } : {}) };
  });
  return {
    messages: preview,
    regions: budget.regions.map((region) => ({ key: region.key, label: region.label, tokens: region.tokens })),
    totalTokens: budget.totalTokens,
    recentMessageCount: budget.recentMessages.length,
    redactions,
    diagnostics: budget.diagnostics,
  };
}

/**
 * 生成一条回复；预处理可以选择流式或非流式请求。
 * 通过 onDelta 把文本传给调用方（由调用方转发为 SSE 事件）。
 *
 * 取消语义：
 * - 外部 signal（用户点击“停止”）触发中止时，返回已接收的文本（可能为空），不抛错；
 * - 120 秒总超时或网络故障时抛 ModelRequestError，调用方按失败处理。
 */
export async function streamReply(options: {
  preparePrompt?: (assemble: () => ReturnType<typeof assembleModelPrompt>) => Promise<ReturnType<typeof assembleModelPrompt>>;
  generationType?: string;
  quietPrompt?: string;
  bias?: string;
  macroSession?: MacroEvaluationSession;
  /** Structured output callers handle empty output and preserve invalid text. */
  preserveOutput?: boolean;
  skipAuthorNote?: boolean;
  extensionPrompts?: ExtensionPrompt[];
  chatMetadata?: Record<string, unknown>;
  extensionSettings?: Record<string, unknown>;
  userTurnCount?: number;
  settings: ProviderSettings;
  apiKey?: string;
  character: CharacterDetail;
  history: ChatMessage[];
  plugins: InstalledPlugin[];
  // 世界书匹配报告（FR-LORE-002/003）：由调用方对当前上下文匹配后传入。
  lorebook: LorebookReport;
  // 长期记忆检索报告（FR-MEM-005）：由调用方对本轮上下文检索后传入。
  memory: MemoryRetrievalReport;
  // 阶段摘要（FR-MEM-006）：压缩较早剧情；为空则不插入该区域。
  stageSummary?: string;
  signal?: AbortSignal;
  onRequest?: (request: NativeCompletionRequest, signal: AbortSignal) => Promise<NativeCompletionRequest>;
  onReady?: (request: NativeCompletionRequest) => void;
  dryRun?: boolean;
  onDelta: (delta: string) => void;
  onFinish?: (end: ModelCompletionEnd) => void;
  // 预算诊断的接收方（FR-PROMPT-003）：调用方据此下发 prompt_budget 事件。
  onBudget?: (budget: PromptBudgetReport) => void;
}): Promise<string> {
  const { budget, messages } = options.preparePrompt ? await options.preparePrompt(() => assembleModelPrompt(options)) : assembleModelPrompt(options);

  const controller = new AbortController();
  let stopped = false;
  const onExternalAbort = (): void => {
    stopped = true;
    controller.abort();
  };
  if (options.signal) {
    if (options.signal.aborted) {
      onExternalAbort();
    } else {
      options.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }
  const timeout = setTimeout(() => controller.abort(), 120_000);

  let full = "";
  try {
    let request: NativeCompletionRequest = { model: options.settings.model, messages: messages.map(message => ({ ...message })),
      temperature: options.settings.temperature, max_tokens: options.settings.maxTokens, stream: true };
    if (options.onRequest) request = await options.onRequest(request, controller.signal);
    controller.signal.throwIfAborted();
    const transport = normalizeChatCompletionRequest(request, options.settings, options.apiKey);
    // Count the actual outgoing payload after extension and custom-body changes.
    // Never expand macros twice or silently discard an extension's replacement.
    const measured = measureChatCompletionRequest(transport.body, options.settings, budget.contextLimitTokens);
    const finalRequest = measured.request;
    budget.reserveTokens = measured.reserveTokens;
    budget.availableTokens = measured.availableTokens;
    budget.totalTokens = measured.totalTokens;
    if (options.onRequest) budget.diagnostics.push("总量按扩展处理后的实际请求重新计数；区域明细为处理前组装结果。");
    options.onBudget?.(budget);
    assertChatCompletionBudget(budget);
    if (options.dryRun) return "";
    controller.signal.throwIfAborted();
    options.onReady?.(finalRequest);
    const response = await requestChatCompletion(transport.baseUrl, transport.body, controller.signal, transport.apiKey, transport.extraHeaders);
    if (!response.ok) {
      throw new ModelRequestError(`模型生成失败：${await errorMessage(response)}`, response.status);
    }
    if (!finalRequest.stream) {
      const result = await response.json() as { choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }> };
      const text = result.choices?.[0]?.message?.content;
      if (typeof text !== "string" || (!options.preserveOutput && !text.trim())) throw new ModelRequestError("模型返回了空内容或不兼容的响应格式。", 502);
      full = text;
      options.onDelta(text);
      const finish = completionEnd(typeof result.choices?.[0]?.finish_reason === "string" ? result.choices[0].finish_reason : "response");
      options.onFinish?.(finish);
      if (finish.completionOutcome === "incomplete") throw new ModelRequestError("模型未正常完成回复，已保留接收的文本。", 502);
      return options.preserveOutput ? text : text.trim();
    }
    if (!response.body) {
      throw new ModelRequestError("模型服务没有提供流式响应。", 502);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let terminal = false;
    let finishReason: string | undefined;
    const parser = createParser({ onEvent: event => {
      if (terminal) return;
      if (event.data.trim() === "[DONE]") { terminal = true; return; }
      let chunk: { choices?: Array<{ delta?: { content?: unknown }; finish_reason?: unknown }> };
      try { chunk = JSON.parse(event.data) as typeof chunk; }
      catch { return; } // Ignore an individual malformed provider event.
      const choice = chunk.choices?.[0];
      if (typeof choice?.finish_reason === "string" && choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        full += delta;
        options.onDelta(delta);
      }
    } });
    try {
      while (!terminal) {
        const { done, value } = await reader.read();
        if (done) { parser.feed(decoder.decode()); break; }
        parser.feed(decoder.decode(value, { stream: true }));
      }
    } finally {
      try { await reader.cancel(); } catch { /* Preserve the provider/read error. */ }
      reader.releaseLock();
    }
    const finish = completionEnd(finishReason ?? (terminal ? "done" : "eof"));
    options.onFinish?.(finish);
    if (!stopped && finish.completionOutcome === "incomplete") throw new ModelRequestError("模型流在正常结束前中断，已保留接收的文本。", 502);
    if (!options.preserveOutput && !full.trim()) {
      throw new ModelRequestError("模型返回了空内容或不兼容的响应格式。", 502);
    }
    return options.preserveOutput ? full : full.trim();
  } catch (error) {
    if (stopped) {
      // 用户停止：保留已接收文本（可能为空），交给上层标记为 stopped。
      return full;
    }
    if (error instanceof ModelRequestError || error instanceof MacroVariableConflictError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ModelRequestError("模型请求超时，请检查服务状态或缩短上下文。", 504);
    }
    throw new ModelRequestError("无法连接模型服务，请检查地址、网络和本地模型进程。", 502);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}
