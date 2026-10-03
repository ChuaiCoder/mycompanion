import {
  apiErrorResponseSchema,
  characterCardPreviewResponseSchema,
  characterDetailSchema,
  characterListResponseSchema,
  conversationDetailSchema,
  conversationListResponseSchema,
  healthResponseSchema,
  installedPluginSchema,
  pluginListResponseSchema,
  pluginManifestSchema,
  providerConnectionResponseSchema,
  providerSettingsSchema,
  promptPreviewResponseSchema,
  storyExportJsonSchema,
  backupPayloadSchemaShared,
  backupRestorePreviewResponseSchema,
  backupRestoreResponseSchema,
  type BackupPayload,
  type BackupRestorePreviewResponse,
  type BackupRestoreResponse,
  type StoryExportJson,
  type CharacterDetail,
  type CharacterExportCheckResponse,
  type CharacterRelatedCounts,
  type CharacterRestoreResponse,
  type CharacterListResponse,
  type CharacterCardPreviewResponse,
  type CharacterLorebookEntry,
  type ChatMessage,
  type ConversationDetail,
  type ConversationListResponse,
  type CharacterRegexRule,
  type GenerationSseEvent,
  type HealthResponse,
  type InstalledPlugin,
  type LorebookReport,
  type PluginListResponse,
  type PromptPreviewResponse,
  type ProviderConnectionResponse,
  type ProviderSettings,
  type MemoryListQuery,
  type MemoryRecord,
  type MemoryRetrievalReport,
  type MemoryUpdateRequest,
  type RegexTestResponse,
  type StageSummary,
  type UpdateProviderSettings,
} from "@mycompanion/shared";

const maximumJsonCardBytes = 20 * 1024 * 1024;

export class ApiRequestError extends Error {
  readonly code: string;
  readonly details: string[];

  constructor(code: string, message: string, details: string[] = []) {
    super(message);
    this.name = "ApiRequestError";
    this.code = code;
    this.details = details;
  }
}

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const response = await fetch("/api/health", {
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    throw new Error(`Health check failed with status ${response.status}.`);
  }

  return healthResponseSchema.parse(await response.json());
}

export async function previewCharacterCard(
  file: File,
  signal?: AbortSignal,
): Promise<CharacterCardPreviewResponse> {
  if (file.size > maximumJsonCardBytes) {
    throw new ApiRequestError(
      "FILE_TOO_LARGE",
      "角色卡超过 20 MiB，无法导入。",
    );
  }

  const { body: requestBody, contentType, filename } =
    await prepareCharacterCardRequest(file);

  const response = await fetch("/api/characters/import/preview", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": contentType,
      ...(filename ? { "X-Character-Filename": encodeURIComponent(filename) } : {}),
    },
    body: requestBody,
    ...(signal ? { signal } : {}),
  });
  const payload = (await response.json()) as unknown;

  if (!response.ok) {
    const error = apiErrorResponseSchema.safeParse(payload);
    if (error.success) {
      throw new ApiRequestError(
        error.data.error.code,
        error.data.error.message,
        error.data.error.details ?? [],
      );
    }
    throw new ApiRequestError(
      "IMPORT_PREVIEW_FAILED",
      `角色卡预览失败（HTTP ${response.status}）。`,
    );
  }

  return characterCardPreviewResponseSchema.parse(payload);
}

const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];

async function prepareCharacterCardRequest(
  file: File,
): Promise<{ body: BodyInit; contentType: string; filename?: string }> {
  const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const isPng =
    header.length === pngSignature.length &&
    pngSignature.every((byte, index) => header[index] === byte);
  if (isPng) {
    return { body: file, contentType: "image/png" };
  }

  // CHARX can carry a JPEG prefix, so inspect bytes rather than trusting its name.
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hasZip = bytes.some((byte, index) => byte === 80 && bytes[index + 1] === 75
    && ((bytes[index + 2] === 3 && bytes[index + 3] === 4) || (bytes[index + 2] === 5 && bytes[index + 3] === 6)));
  if (hasZip || /\.(charx|zip|byaf)$/i.test(file.name)) {
    return { body: file, contentType: /\.byaf$/i.test(file.name) ? "application/byaf" : "application/charx", filename: file.name };
  }

  if (/\.ya?ml$/i.test(file.name)) {
    return { body: JSON.stringify({ filename: file.name, card: await file.text() }), contentType: "application/json" };
  }

  let card: unknown;
  try {
    card = JSON.parse(await file.text()) as unknown;
  } catch {
    throw new ApiRequestError(
      "UNSUPPORTED_OR_INVALID_FILE",
      /\.jpe?g$/i.test(file.name) ? "这张 JPEG 图片没有检测到 CHARX 数据。请选择包含角色设定的卡片文件。" : "无法识别这个文件。请选择有效的 PNG、JSON、YAML 或 CHARX 角色卡。",
    );
  }
  return {
    body: JSON.stringify({ filename: file.name, card }),
    contentType: "application/json",
  };
}

async function readApiPayload(response: Response): Promise<unknown> {
  const payload = (await response.json()) as unknown;
  if (response.ok) {
    return payload;
  }

  const error = apiErrorResponseSchema.safeParse(payload);
  if (error.success) {
    throw new ApiRequestError(
      error.data.error.code,
      error.data.error.message,
      error.data.error.details ?? [],
    );
  }
  throw new ApiRequestError(
    "API_REQUEST_FAILED",
    `请求失败（HTTP ${response.status}）。`,
  );
}

export async function commitCharacterCard(
  file: File,
  idempotencyKey: string,
  signal?: AbortSignal,
  options?: { mode: "copy" | "replace"; targetId?: string; expectedUpdatedAt?: string },
): Promise<CharacterDetail> {
  if (file.size > maximumJsonCardBytes) {
    throw new ApiRequestError(
      "FILE_TOO_LARGE",
      "角色卡超过 20 MiB，无法导入。",
    );
  }
  const { body, contentType, filename } = await prepareCharacterCardRequest(file);
  const query = options ? new URLSearchParams(Object.entries(options).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : null;
  const response = await fetch("/api/characters/import/commit" + (query ? "?" + query : ""), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": contentType,
      ...(filename ? { "X-Character-Filename": encodeURIComponent(filename) } : {}),
      "Idempotency-Key": idempotencyKey,
    },
    body,
    ...(signal ? { signal } : {}),
  });
  return characterDetailSchema.parse(await readApiPayload(response));
}

export async function listCharacters(
  signal?: AbortSignal,
): Promise<CharacterListResponse> {
  const response = await fetch("/api/characters", {
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  return characterListResponseSchema.parse(await readApiPayload(response));
}

export async function fetchCharacter(
  id: string,
  signal?: AbortSignal,
): Promise<CharacterDetail> {
  const response = await fetch(`/api/characters/${encodeURIComponent(id)}`, {
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  return characterDetailSchema.parse(await readApiPayload(response));
}

// 原生角色编辑：读取完整角色卡 JSON（保留未知字段往返），PUT 更新后返回 CharacterDetail。
export async function fetchCharacterCard(id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(characterExportUrl(id, "json"), {
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) await readApiPayload(response);
  const card: unknown = JSON.parse(await response.text());
  if (!card || typeof card !== "object" || Array.isArray(card)) {
    throw new ApiRequestError("INVALID_CHARACTER_CARD", "角色卡数据无效。");
  }
  return card as Record<string, unknown>;
}

export async function updateCharacter(id: string, card: unknown): Promise<CharacterDetail> {
  const response = await fetch(`/api/characters/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ card }),
  });
  return characterDetailSchema.parse(await readApiPayload(response));
}

export function characterExportUrl(
  id: string,
  format: "json" | "png" | "charx",
): string {
  return `/api/characters/${encodeURIComponent(id)}/export?format=${format}`;
}

// 导出兼容性检查（FR-DATA-001）：导出前列出目标格式无法表示/第三方可能无法识别的字段。
export async function checkCharacterExport(
  id: string,
  format: "json" | "png" | "charx",
): Promise<CharacterExportCheckResponse> {
  const response = await fetch(`/api/characters/${encodeURIComponent(id)}/export/check`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ format }),
  });
  return readApiPayload(response) as Promise<CharacterExportCheckResponse>;
}

// 删除角色（FR-DATA-004）：关联计数、软删除（默认）、恢复、永久删除（permanent）。
export async function characterRelatedCounts(id: string): Promise<CharacterRelatedCounts> {
  const response = await fetch(`/api/characters/${encodeURIComponent(id)}/related-counts`, {
    headers: { Accept: "application/json" },
  });
  return readApiPayload(response) as Promise<CharacterRelatedCounts>;
}

export async function deleteCharacter(
  id: string,
  permanent = false,
): Promise<{ characterId: string; permanent: boolean; hiddenConversations: number; hiddenMemories: number }> {
  const query = permanent ? "?permanent=true" : "";
  const response = await fetch(
    `/api/characters/${encodeURIComponent(id)}${query}`,
    { method: "DELETE", headers: { Accept: "application/json" } },
  );
  return readApiPayload(response) as Promise<{
    characterId: string;
    permanent: boolean;
    hiddenConversations: number;
    hiddenMemories: number;
  }>;
}

export async function restoreCharacter(id: string): Promise<CharacterRestoreResponse> {
  const response = await fetch(`/api/characters/${encodeURIComponent(id)}/restore`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  return readApiPayload(response) as Promise<CharacterRestoreResponse>;
}

// 故事导出（FR-DATA-002）：Markdown 或 JSON。
export function storyExportUrl(id: string, format: "markdown" | "json"): string {
  return `/api/conversations/${encodeURIComponent(id)}/export?format=${format}`;
}

export async function fetchStoryExport(id: string, signal?: AbortSignal): Promise<StoryExportJson> {
  const response = await fetch(storyExportUrl(id, "json"), { headers: { Accept: "application/json" }, ...(signal ? { signal } : {}) });
  return storyExportJsonSchema.parse(await readApiPayload(response));
}

// 完整备份（FR-DATA-003）：导出 / 恢复预览 / 恢复。
export async function fetchBackup(): Promise<BackupPayload> {
  const response = await fetch("/api/backup", { headers: { Accept: "application/json" } });
  return backupPayloadSchemaShared.parse(await readApiPayload(response));
}

export async function previewBackupRestore(
  backup: BackupPayload,
  strategy: "overwrite" | "skip",
): Promise<BackupRestorePreviewResponse> {
  const response = await fetch("/api/backup/restore/preview", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ backup, strategy }),
  });
  if (response.status === 422) return backupRestorePreviewResponseSchema.parse(await response.json());
  return backupRestorePreviewResponseSchema.parse(await readApiPayload(response));
}

export async function applyBackupRestore(
  backup: BackupPayload,
  strategy: "overwrite" | "skip",
): Promise<BackupRestoreResponse> {
  const response = await fetch("/api/backup/restore", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ backup, strategy }),
  });
  return backupRestoreResponseSchema.parse(await readApiPayload(response));
}

// 正则规则（FR-REGEX-001/007）：读取、启用/停用、测试器。
export async function listRegexRules(id: string): Promise<CharacterRegexRule[]> {
  const response = await fetch(`/api/characters/${encodeURIComponent(id)}/regex`, {
    headers: { Accept: "application/json" },
  });
  const payload = (await readApiPayload(response)) as { rules: CharacterRegexRule[] };
  return payload.rules;
}

export async function setRegexRuleState(
  id: string,
  order: number,
  enabled: boolean,
): Promise<CharacterRegexRule[]> {
  const response = await fetch(
    `/api/characters/${encodeURIComponent(id)}/regex/${order}`,
    {
      method: "PUT",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    },
  );
  const rules = await readApiPayload(response) as CharacterRegexRule[];
  window.dispatchEvent(new CustomEvent('mycompanion:regex-rules', { detail: { id, enabled } }));
  return rules;
}

export async function setAllRegexRulesState(
  id: string,
  enabled: boolean,
): Promise<CharacterRegexRule[]> {
  const response = await fetch(
    `/api/characters/${encodeURIComponent(id)}/regex/all`,
    {
      method: "PUT",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    },
  );
  const rules = await readApiPayload(response) as CharacterRegexRule[];
  window.dispatchEvent(new CustomEvent('mycompanion:regex-rules', { detail: { id, enabled } }));
  return rules;
}

export async function testCharacterRegex(
  id: string,
  input: string,
): Promise<RegexTestResponse> {
  const response = await fetch(
    `/api/characters/${encodeURIComponent(id)}/regex/test`,
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ input }),
    },
  );
  return readApiPayload(response) as Promise<RegexTestResponse>;
}

// 世界书条目（FR-LORE-001/002）：读取、启用/停用、测试器。
export async function listLorebookEntries(id: string): Promise<CharacterLorebookEntry[]> {
  const response = await fetch(`/api/characters/${encodeURIComponent(id)}/lorebook`, {
    headers: { Accept: "application/json" },
  });
  const payload = (await readApiPayload(response)) as { entries: CharacterLorebookEntry[] };
  return payload.entries;
}

export async function setLorebookEntryState(
  id: string,
  index: number,
  enabled: boolean,
): Promise<CharacterLorebookEntry[]> {
  const response = await fetch(
    `/api/characters/${encodeURIComponent(id)}/lorebook/${index}`,
    {
      method: "PUT",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    },
  );
  return readApiPayload(response) as Promise<CharacterLorebookEntry[]>;
}

export async function setAllLorebookEntriesState(
  id: string,
  enabled: boolean,
): Promise<CharacterLorebookEntry[]> {
  const response = await fetch(
    `/api/characters/${encodeURIComponent(id)}/lorebook/all`,
    {
      method: "PUT",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    },
  );
  return readApiPayload(response) as Promise<CharacterLorebookEntry[]>;
}

export async function testCharacterLorebook(
  id: string,
  input: string,
): Promise<LorebookReport> {
  const response = await fetch(
    `/api/characters/${encodeURIComponent(id)}/lorebook/test`,
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ input }),
    },
  );
  return readApiPayload(response) as Promise<LorebookReport>;
}

export async function getProviderSettings(signal?: AbortSignal): Promise<ProviderSettings> {
  const response = await fetch("/api/settings/provider", {
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  return providerSettingsSchema.parse(await readApiPayload(response));
}

export async function saveProviderSettings(
  settings: UpdateProviderSettings,
): Promise<ProviderSettings> {
  const response = await fetch("/api/settings/provider", {
    method: "PUT",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  return providerSettingsSchema.parse(await readApiPayload(response));
}

export async function testProvider(settings?: UpdateProviderSettings): Promise<ProviderConnectionResponse> {
  const response = await fetch("/api/settings/provider/test", {
    method: "POST",
    headers: { Accept: "application/json", ...(settings ? { "Content-Type": "application/json" } : {}) },
    ...(settings ? { body: JSON.stringify(settings) } : {}),
  });
  return providerConnectionResponseSchema.parse(await readApiPayload(response));
}

export async function listConversations(signal?: AbortSignal): Promise<ConversationListResponse> {
  const response = await fetch("/api/conversations", {
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  return conversationListResponseSchema.parse(await readApiPayload(response));
}

export async function createConversation(characterId: string): Promise<ConversationDetail> {
  const response = await fetch("/api/conversations", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ characterId }),
  });
  return conversationDetailSchema.parse(await readApiPayload(response));
}

export async function fetchConversation(id: string, signal?: AbortSignal): Promise<ConversationDetail> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  return conversationDetailSchema.parse(await readApiPayload(response));
}

// 记忆中心（FR-MEM-005/007）：列表筛选、更新、恢复上一版本、删除、检索测试器。
export async function listMemories(
  conversationId: string,
  filters: MemoryListQuery = {},
): Promise<MemoryRecord[]> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined) params.set(key, value);
  }
  const query = params.toString();
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/memories${query ? `?${query}` : ""}`,
    { headers: { Accept: "application/json" } },
  );
  const payload = (await readApiPayload(response)) as { items: MemoryRecord[] };
  return payload.items;
}

export async function updateMemory(
  conversationId: string,
  memoryId: string,
  patch: MemoryUpdateRequest,
): Promise<MemoryRecord> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/memories/${encodeURIComponent(memoryId)}`,
    {
      method: "PUT",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  return readApiPayload(response) as Promise<MemoryRecord>;
}

export async function restoreMemory(
  conversationId: string,
  memoryId: string,
  mode?: "supersession" | "previous_content",
): Promise<MemoryRecord> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/memories/${encodeURIComponent(memoryId)}/restore`,
    { method: "POST", headers: { Accept: "application/json", ...(mode ? { "Content-Type": "application/json" } : {}) }, ...(mode ? { body: JSON.stringify({ mode }) } : {}) },
  );
  return readApiPayload(response) as Promise<MemoryRecord>;
}

export async function deleteMemory(
  conversationId: string,
  memoryId: string,
): Promise<void> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/memories/${encodeURIComponent(memoryId)}`,
    { method: "DELETE", headers: { Accept: "application/json" } },
  );
  if (!response.ok) await readApiPayload(response);
}

export async function testMemory(
  conversationId: string,
  input: string,
): Promise<MemoryRetrievalReport> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/memories/test`,
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ input }),
    },
  );
  return readApiPayload(response) as Promise<MemoryRetrievalReport>;
}

// 阶段摘要（FR-MEM-006）：读取 / 编辑 / 恢复 / 自动摘要开关。
export async function getSummary(conversationId: string): Promise<{
  autoSummaryEnabled: boolean;
  summary: StageSummary | null;
}> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/summary`,
    { headers: { Accept: "application/json" } },
  );
  const payload = (await readApiPayload(response)) as {
    autoSummaryEnabled: boolean;
    summary: StageSummary | null;
  };
  return payload;
}

export async function saveSummary(
  conversationId: string,
  content: string,
): Promise<StageSummary> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/summary`,
    {
      method: "PUT",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    },
  );
  return readApiPayload(response) as Promise<StageSummary>;
}

export async function restoreSummary(conversationId: string): Promise<StageSummary> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/summary/restore`,
    { method: "POST", headers: { Accept: "application/json" } },
  );
  return readApiPayload(response) as Promise<StageSummary>;
}

export async function setAutoSummary(
  conversationId: string,
  enabled: boolean,
): Promise<{ autoSummaryEnabled: boolean }> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/summary/auto`,
    {
      method: "PUT",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    },
  );
  return readApiPayload(response) as Promise<{ autoSummaryEnabled: boolean }>;
}

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
    // 原生路径下服务端不会发出浏览器 RPC 事件；macro_variables 透传给调用方同步本地草稿。
    if (event.type === "macro_request" || event.type === "effect_request" || event.type === "effect_end"
      || event.type === "completion_request") return;
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

export async function listPlugins(signal?: AbortSignal): Promise<PluginListResponse> {
  const response = await fetch("/api/plugins", {
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  return pluginListResponseSchema.parse(await readApiPayload(response));
}

export async function installPlugin(file: File): Promise<InstalledPlugin> {
  if (file.size > 1024 * 1024) {
    throw new ApiRequestError("FILE_TOO_LARGE", "插件清单不能超过 1 MiB。");
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(await file.text()) as unknown;
  } catch {
    throw new ApiRequestError("INVALID_PLUGIN_MANIFEST", "插件清单不是有效的 JSON。");
  }
  const localCheck = pluginManifestSchema.safeParse(manifest);
  if (!localCheck.success) {
    throw new ApiRequestError(
      "INVALID_PLUGIN_MANIFEST",
      "插件清单格式不兼容。",
      localCheck.error.issues.map((issue) => issue.message),
    );
  }
  const response = await fetch("/api/plugins/install", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(localCheck.data),
  });
  return installedPluginSchema.parse(await readApiPayload(response));
}

export async function setPluginEnabled(id: string, enabled: boolean): Promise<InstalledPlugin> {
  const response = await fetch(`/api/plugins/${encodeURIComponent(id)}/enabled`, {
    method: "PUT",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  return installedPluginSchema.parse(await readApiPayload(response));
}

export async function uninstallPlugin(id: string): Promise<void> {
  const response = await fetch(`/api/plugins/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) await readApiPayload(response);
}

export function streamForegroundMode(id: string, mode: "continue" | "impersonate", signal: AbortSignal,
  onEvent: (event: GenerationSseEvent) => void, options: NativeGenerationOptions = {}): Promise<void> {
  return streamNativeGeneration(id, undefined, signal, onEvent, { ...options, mode });
}
