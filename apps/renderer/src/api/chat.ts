import {
  promptPreviewResponseSchema,
  type ChatMessage,
  type ConversationDetail,
  type GenerationSseEvent,
  type PromptPreviewResponse,
} from "@mycompanion/shared";

import { readApiPayload } from "./core";

// 提示词预览（FR-PROMPT-004）：发送前查看即将发给模型的提示词（已脱敏）。
export async function promptPreview(
  conversationId: string,
  draft: string,
  signal?: AbortSignal,
): Promise<PromptPreviewResponse> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/prompt-preview`,
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ draft }),
      ...(signal ? { signal } : {}),
    },
  );
  return promptPreviewResponseSchema.parse(await readApiPayload(response));
}

export interface NativeGenerationOptions { allowEmpty?: boolean; dryRun?: boolean; signal?: AbortSignal; mode?: "continue" | "impersonate" }

// Installed code may return a promise that never settles. Stop/shutdown must
// release our generation even though JavaScript cannot cancel that promise.
export function waitForGenerationHook<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const clean = () => signal.removeEventListener("abort", aborted);
    const aborted = () => { clean(); reject(signal.reason); };
    signal.addEventListener("abort", aborted, { once: true });
    // Always observe eventual rejection, including when already cancelled.
    operation.then(value => { clean(); resolve(value); }, error => { clean(); reject(error); });
    if (signal.aborted) aborted();
  });
}

// 原生生成链路：不传 browserMacros/extensionPrompts，宏展开完全在服务端完成，
// 因此不再有 macro_request/effect_request/completion_request 浏览器 RPC。
async function streamNativeGeneration(id: string, content: string | undefined, signal: AbortSignal,
  onEvent: (event: GenerationSseEvent) => void, options: NativeGenerationOptions): Promise<void> {
  const type = options.mode ?? (content === undefined ? "regenerate" : "normal");
  const suffix = `/messages${type === "normal" ? "" : "/" + type}`;
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}${suffix}`, {
    method: "POST", headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({ content, allowEmpty: content === undefined ? undefined : options.allowEmpty ?? false,
      dryRun: options.dryRun ?? false }), signal,
  });
  if (!response.ok || !response.body) { await readApiPayload(response); throw new Error("生成请求失败。"); }
  await readSseStream(response.body, async event => {
    // 服务端只下发原生生成事件；macro_variables 透传给调用方同步本地草稿。
    onEvent(event);
  });
}
export function streamChatMessage(id: string, content: string, signal: AbortSignal,
  onEvent: (event: GenerationSseEvent) => void, options: NativeGenerationOptions = {}): Promise<void> {
  return streamNativeGeneration(id, content, signal, onEvent, options);
}
export function streamRegenerate(id: string, signal: AbortSignal,
  onEvent: (event: GenerationSseEvent) => void, options: NativeGenerationOptions = {}): Promise<void> {
  return streamNativeGeneration(id, undefined, signal, onEvent, options);
}

export async function readSseStream(body: ReadableStream<Uint8Array>,
  onEvent: (event: GenerationSseEvent) => void | Promise<void>): Promise<void> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n\n");
      while (newlineIndex >= 0) {
        const rawEvent = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 2);
        newlineIndex = buffer.indexOf("\n\n");
        for (const line of rawEvent.split("\n")) {
          if (!line.startsWith("data:")) continue;
          let event: GenerationSseEvent;
          try { event = JSON.parse(line.slice(5).trim()) as GenerationSseEvent; }
          catch { continue; }
          await onEvent(event);
        }
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function stopGeneration(id: string): Promise<ChatMessage | null> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}/generation/stop`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as { message?: ChatMessage };
  return payload.message ?? null;
}

export async function editMessage(
  id: string,
  messageId: string,
  content: string,
): Promise<ChatMessage> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}`,
    {
      method: "PATCH",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    },
  );
  return readApiPayload(response) as Promise<ChatMessage>;
}

export async function deleteMessage(id: string, messageId: string): Promise<ConversationDetail> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}`,
    { method: "DELETE", headers: { Accept: "application/json" } },
  );
  const payload = (await readApiPayload(response)) as { conversation: ConversationDetail };
  return payload.conversation;
}

export async function activateBranch(
  id: string,
  branchId: string,
): Promise<ConversationDetail> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(id)}/branches/${encodeURIComponent(branchId)}/activate`,
    { method: "POST", headers: { Accept: "application/json" } },
  );
  const payload = (await readApiPayload(response)) as { conversation: ConversationDetail };
  return payload.conversation;
}

export function streamForegroundMode(id: string, mode: "continue" | "impersonate", signal: AbortSignal,
  onEvent: (event: GenerationSseEvent) => void, options: NativeGenerationOptions = {}): Promise<void> {
  return streamNativeGeneration(id, undefined, signal, onEvent, { ...options, mode });
}
