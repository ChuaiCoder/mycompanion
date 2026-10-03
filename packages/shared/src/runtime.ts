import { z } from "zod";
import { toolInvocationSchema } from "./tools.js";
export const browserMacroResultSchema = z.object({
  content: z.string(), local: z.record(z.string(), z.unknown()), global: z.record(z.string(), z.unknown()),
});

import { memoryRetrievalReportSchema } from "./memory.js";
import { lorebookReportSchema } from "./worldbook.js";
import { tokenAccountingSchema, providerTokenUsageSchema } from "./tokens.js";

export const MAX_CONTEXT_TOKENS = 2_000_000;

export const extensionPromptSchema = z.object({
  key: z.string(), value: z.string(), position: z.union([z.literal(-1), z.literal(0), z.literal(1), z.literal(2)]),
  depth: z.number().int().min(0).max(10000), scan: z.boolean(), role: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  // Raw snapshots remain false; only explicitly pre-evaluated callers set true.
  macrosResolved: z.boolean().optional(),
}).strict();
export const extensionPromptRequestSchema = z.object({ extensionPrompts: z.array(extensionPromptSchema).optional() }).strict();
export type ExtensionPrompt = z.infer<typeof extensionPromptSchema>;

// 提示词预算报告（FR-PROMPT-003）：每轮生成计算一次，
// 说明各区域保留/裁剪情况；被裁剪内容必须出现在 diagnostics 中。
const promptRegionKeySchema = z.enum([
  "character_core",
  "example_dialogue",
  "worldbook_constant",
  "worldbook",
  "memory",
  "memory_pinned",
  "stage_summary",
  "plugins",
  "extension_prompts",
  "post_history",
]);

export const promptBudgetReportSchema = z.object({
  tokenAccounting: tokenAccountingSchema.optional(),
  contextLimitTokens: z.number().int().nonnegative(),
  reserveTokens: z.number().int().nonnegative(),
  availableTokens: z.number().int().nonnegative(),
  regions: z.array(z.object({
    key: promptRegionKeySchema,
    label: z.string().max(200),
    content: z.string().max(2 * 1024 * 1024),
    tokens: z.number().int().nonnegative(),
  })),
  // 本轮实际进入模型上下文的近期消息（当前用户输入必然保留）。
  recentMessageCount: z.number().int().nonnegative(),
  diagnostics: z.array(z.string()).max(50),
  totalTokens: z.number().int().nonnegative(),
});

// 发送前的提示词预览（FR-PROMPT-004）：与真实请求相同的组装与预算，
// 凭据与内部敏感字段已脱敏；每个区域给出 token 估算与总计数。
export const promptPreviewRequestSchema = z.object({
  browserMacros: z.boolean().default(false),
  // 即将发送的草稿；为空则只预览当前分支已有上下文。
  draft: z.string().max(100_000).optional(),
  extensionPrompts: z.array(extensionPromptSchema).optional(),
}).strict();

export const promptPreviewResponseSchema = z.object({
  tokenAccounting: tokenAccountingSchema.optional(),
  // 即将发给模型的消息（已脱敏）。
  messages: z.array(z.object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string().max(8 * 1024 * 1024),
    name: z.string().max(200).optional(),
  })),
  // 每个逻辑区域的 token 估算（FR-PROMPT-002 顺序）。
  regions: z.array(z.object({
    key: promptRegionKeySchema,
    label: z.string().max(200),
    tokens: z.number().int().nonnegative(),
  })),
  totalTokens: z.number().int().nonnegative(),
  recentMessageCount: z.number().int().nonnegative(),
  // 本次预览被脱敏替换的凭据/敏感字段数量。
  redactions: z.number().int().nonnegative(),
  diagnostics: z.array(z.string()).max(50),
});

export type PromptPreviewRequest = z.infer<typeof promptPreviewRequestSchema>;
export type PromptPreviewResponse = z.infer<typeof promptPreviewResponseSchema>;

// Browser extensions send their already transformed, newest-first chat here.
// Keep this separate from the redacted user-facing preview contract.
const extensionAssemblyMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().max(200_000),
  name: z.string().max(200).optional(),
  image: z.string().max(8 * 1024 * 1024).nullable().optional(),
  tool_calls: z.unknown().optional(),
  reasoning: z.unknown().optional(),
  signature: z.unknown().optional(),
}).passthrough();

export const extensionPromptAssemblyRequestSchema = z.object({
  browserMacros: z.boolean().default(false),
  commitVariables: z.boolean().default(false),
  messages: z.array(extensionAssemblyMessageSchema).max(80),
  messageExamples: z.array(z.array(extensionAssemblyMessageSchema).max(50)).max(50).default([]),
  imageQuality:z.enum(["low","high","auto","original"]).default("auto"),
  extensionPrompts: z.array(extensionPromptSchema).max(200).default([]),
  name2: z.string().max(200).optional(),
  charDescription: z.string().max(200_000).optional(),
  charPersonality: z.string().max(200_000).optional(),
  scenario: z.string().max(200_000).optional(),
  Scenario: z.string().max(200_000).optional(),
  worldInfoBefore: z.string().max(200_000).nullable().optional(),
  worldInfoAfter: z.string().max(200_000).nullable().optional(),
  systemPromptOverride: z.string().max(200_000).optional(),
  jailbreakPromptOverride: z.string().max(200_000).optional(),
  personaDescription: z.string().max(200_000).optional(),
  bias: z.string().max(100_000).optional(),
  quietPrompt: z.string().max(100_000).optional(),
  quietImage: z.string().max(8 * 1024 * 1024).nullable().optional(),
  cyclePrompt: z.string().max(100_000).optional(),
  type: z.string().max(40).default("normal"),
  contextLimitTokens: z.number().int().min(1).max(MAX_CONTEXT_TOKENS).optional(),
  maxTokens: z.number().int().min(1).max(131_072).optional(),
}).strict();
export type ExtensionPromptAssemblyRequest = z.infer<typeof extensionPromptAssemblyRequestSchema>;

/** Background generation against the selected story without writing a turn. */
export const quietGenerationRequestSchema = z.object({
  browserMacros: z.boolean().default(false),
  quietPrompt: z.string().max(100_000).default(""),
  quietPromptMacrosResolved: z.boolean().default(false),
  browserPreflight: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  quietToLoud: z.boolean().default(false),
  skipWIAN: z.boolean().default(false),
  quietName: z.string().max(200).nullable().default(null),
  responseLength: z.number().int().min(1).max(131_072).nullable().default(null),
  quietImage: z.string().max(8 * 1024 * 1024).nullable().default(null),
  forceChId: z.number().int().nonnegative().nullable().default(null),
  jsonSchema: z.record(z.string(), z.unknown()).nullable().default(null),
  extensionPrompts: z.array(extensionPromptSchema).default([]),
}).strict();
export type QuietGenerationRequest = z.infer<typeof quietGenerationRequestSchema>;

export const providerKindSchema = z.enum(["openai-compatible", "ollama", "anthropic", "gemini"]);

export const providerSettingsSchema = z.object({
  kind: providerKindSchema,
  baseUrl: z.string().min(1).max(2_048),
  model: z.string().min(1).max(200),
  hasApiKey: z.boolean(),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().min(1).max(131_072),
  // 模型上下文上限（FR-PROMPT-003）：提示词预算据此裁剪各区域。
  contextLimitTokens: z.number().int().min(1).max(MAX_CONTEXT_TOKENS),
});

export const updateProviderSettingsSchema = z.object({
  kind: providerKindSchema,
  baseUrl: z.string().min(1).max(2_048),
  model: z.string().min(1).max(200),
  apiKey: z.string().max(8_192).optional(),
  clearApiKey: z.boolean().optional().default(false),
  temperature: z.number().min(0).max(2).default(0.8),
  maxTokens: z.number().int().min(1).max(131_072).default(1_024),
  contextLimitTokens: z.number().int().min(1).max(MAX_CONTEXT_TOKENS).default(32_768),
});

export const providerConnectionResponseSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  models: z.array(z.string()).max(500).default([]),
  testedModel: z.string().optional(),
  capability: z.enum(["chat-completion", "embedding"]).optional(),
  issue: z.object({
    code: z.string(), field: z.enum(["baseUrl", "apiKey", "model", "connection"]),
    suggestion: z.string(), retryable: z.boolean(),
  }).optional(),
});

// 消息状态与规格数据模型一致：streaming（生成中）、complete（完成）、
// stopped（用户停止，保留已接收文本）、failed（失败）。
export const chatMessageStatusSchema = z.enum(["streaming", "complete", "stopped", "failed"]);

// 生成配置摘要：记录每条助手回复生成时的模型与参数（FR-CHAT-002）。
export const modelResponseStateSchema = z.object({
  protocol: z.enum(["openai", "claude", "gemini"]),
  model: z.string().min(1).max(200).optional(),
  reasoning: z.string(), signature: z.string(),
  toolCalls: z.array(z.object({id:z.string(),type:z.literal("function"),function:z.object({name:z.string(),arguments:z.string()}),signature:z.string().optional()})),
  media: z.array(z.object({mimeType:z.string(),data:z.string(),signature:z.string().optional()})),
  providerContent: z.array(z.record(z.string(),z.unknown())),
});
export type ModelResponseState = z.infer<typeof modelResponseStateSchema>;
// Native candidates share a request's usage and input budget, but never its
// reasoning, media, tool-call ordinals or per-choice finish state.
export const modelCandidateSnapshotSchema = z.object({
  index: z.number().int().nonnegative(), content: z.string(), responseState: modelResponseStateSchema,
  finishReason: z.string().max(200).optional(),
});
export type ModelCandidateSnapshot = z.infer<typeof modelCandidateSnapshotSchema>;
export const nativeCandidateInfoSchema = modelCandidateSnapshotSchema.omit({content:true}).extend({
  version:z.literal(1), originalContent:z.string(), status:chatMessageStatusSchema,
  completionOutcome:z.enum(["complete","truncated","incomplete"]).optional(),
});
export type NativeCandidateInfo = z.infer<typeof nativeCandidateInfoSchema>;
export const modelToolRoundSchema = z.object({
  content:z.string(),responseState:modelResponseStateSchema,usage:providerTokenUsageSchema.optional(),
  tokenAccounting:tokenAccountingSchema.optional(),
  invocations:z.array(toolInvocationSchema),
});
export type ModelToolRound = z.infer<typeof modelToolRoundSchema>;

export const messageGenerationMetadataSchema = z.object({
  nativeCandidates: z.literal(true).optional(),
  responseState: modelResponseStateSchema.optional(),
  toolRounds: z.array(modelToolRoundSchema).optional(),
  tokenAccounting: tokenAccountingSchema.optional(),
  usage: providerTokenUsageSchema.optional(),
  model: z.string().min(1),
  temperature: z.number(),
  maxTokens: z.number().int().nonnegative(),
  finishReason: z.string().max(200).optional(),
  completionOutcome: z.enum(["complete", "truncated", "incomplete"]).optional(),
});

export const chatMessageSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  // 消息属于哪个故事分支；编辑历史/重新生成会派生新分支，原分支保持可访问。
  branchId: z.string().uuid(),
  parentMessageId: z.string().uuid().nullable(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  status: chatMessageStatusSchema,
  generationMetadata: messageGenerationMetadataSchema.optional(),
  extensionData: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string().datetime(),
});

export const conversationSummarySchema = z.object({
  id: z.string().uuid(),
  characterId: z.string().uuid(),
  characterName: z.string(),
  title: z.string(),
  lastMessagePreview: z.string(),
  messageCount: z.number().int().nonnegative(),
  activeBranchId: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const conversationDetailSchema = conversationSummarySchema.extend({
  messages: z.array(chatMessageSchema),
  chatMetadata: z.record(z.string(), z.unknown()).optional(),
  chatHeader: z.record(z.string(), z.unknown()).optional(),
});

export const conversationListResponseSchema = z.object({
  items: z.array(conversationSummarySchema),
  total: z.number().int().nonnegative(),
});

export const createConversationRequestSchema = z.object({
  characterId: z.string().uuid(),
  greetingIndex: z.number().int().min(0).optional(),
});

export const sendMessageRequestSchema = z.object({
  browserMacros: z.boolean().default(false),
  content: z.string().trim().max(100_000),
  extensionPrompts: z.array(extensionPromptSchema).optional(),
  allowEmpty: z.boolean().default(false),
  browserPreflight: z.boolean().default(false),
  dryRun: z.boolean().default(false),
}).refine(value => value.content.length > 0 || value.allowEmpty || value.dryRun, "消息不能为空。");

export const nativeCompletionRequestSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(["system", "user", "assistant", "tool", "developer"]),
    content: z.union([z.string(), z.array(z.record(z.string(), z.unknown())), z.null()]).optional(),
  }).passthrough()).min(1),
  model: z.string().min(1),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  stream: z.boolean(),
  n: z.number().int().positive().nullable().optional(),
}).passthrough();
export type NativeCompletionRequest = z.infer<typeof nativeCompletionRequestSchema>;

export const nativeGenerationRequestSchema = extensionPromptRequestSchema.extend({
  browserMacros: z.boolean().default(false),
  browserPreflight: z.boolean().default(false), dryRun: z.boolean().default(false),
});

export const sendMessageResponseSchema = z.object({
  userMessage: chatMessageSchema,
  assistantMessage: chatMessageSchema,
});

// SSE 生成流事件。服务端以 text/event-stream 逐事件发送，
// 客户端按 type 分发；delta 是增量文本，done 携带最终消息（complete 或 stopped）。
export const generationSseEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("macro_request"), requestId: z.string().uuid(), conversationId: z.string().uuid().nullable(),
    branchId: z.string().uuid().nullable(), evaluation: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("effect_request"), requestId: z.string().uuid(), conversationId: z.string().uuid().nullable(),
    branchId: z.string().uuid().nullable(), evaluation: z.object({ invocationId: z.string().uuid(),
      ordinal: z.number().int().nonnegative(), kind: z.string(), payload: z.unknown() }).passthrough() }),
  z.object({ type: z.literal("effect_end"), invocationId: z.string().uuid() }),
  z.object({ type: z.literal("macro_result"), result: z.record(z.string(), z.unknown()) }),
  z.object({type:z.literal("macro_variables"),conversationId:z.string().uuid(),branchId:z.string().uuid().optional(),
    worldInfoState:z.record(z.string(),z.unknown()).optional(),changes:z.array(z.object({
    scope:z.enum(["local","global"]),key:z.string(),beforeExists:z.boolean(),afterExists:z.boolean(),before:z.unknown().optional(),after:z.unknown().optional(),
  }))}),
  z.object({ type: z.literal("quiet_result"), text: z.string() }),
  z.object({ type: z.literal("impersonate_result"), text: z.string() }),
  z.object({ type: z.literal("completion_request"), requestId: z.string().uuid(), request: nativeCompletionRequestSchema, dryRun: z.boolean(), provider: providerSettingsSchema.optional() }),
  z.object({ type: z.literal("generation_end"), reason: z.enum(["stopped", "preview"]) }),
  z.object({ type: z.literal("user_message"), message: chatMessageSchema }),
  z.object({ type: z.literal("assistant_start"), message: chatMessageSchema }),
  z.object({ type: z.literal("delta"), delta: z.string().min(1) }),
  z.object({ type: z.literal("done"), message: chatMessageSchema }),
  z.object({ type: z.literal("error"), message: z.string().min(1) }),
  // 本轮世界书匹配报告（FR-LORE-003）：高级模式用于展示触发条目、原因与注入位置。
  z.object({ type: z.literal("lorebook"), report: lorebookReportSchema }),
  // 本轮提示词预算报告（FR-PROMPT-003）：展示各区域保留/裁剪与总 token 估算。
  z.object({ type: z.literal("prompt_budget"), report: promptBudgetReportSchema }),
  // 本轮长期记忆检索报告（FR-MEM-005）：展示得分、注入与否与原因。
  z.object({ type: z.literal("memory"), report: memoryRetrievalReportSchema }),
]);

// 重新生成最后一条助手回复：在“最后一个用户消息”处派生新分支并替换该分支内的旧助手回复。
// 原分支保持可访问；返回新分支中的新回复与新的当前分支 ID。
export const regenerateMessageResponseSchema = z.object({
  message: chatMessageSchema,
  activeBranchId: z.string().uuid(),
  createdBranch: z.boolean(),
});

export const activateBranchResponseSchema = z.object({
  conversation: conversationDetailSchema,
});

export const editMessageRequestSchema = z.object({
  content: z.string().trim().min(1).max(100_000),
});

export const stopGenerationResponseSchema = z.object({
  message: chatMessageSchema,
});

export const deleteMessageResponseSchema = z.object({
  conversation: conversationDetailSchema,
});

export type ChatMessageStatus = z.infer<typeof chatMessageStatusSchema>;
export type MessageGenerationMetadata = z.infer<typeof messageGenerationMetadataSchema>;
export type GenerationSseEvent = z.infer<typeof generationSseEventSchema>;
export type RegenerateMessageResponse = z.infer<typeof regenerateMessageResponseSchema>;
export type ActivateBranchResponse = z.infer<typeof activateBranchResponseSchema>;
export type EditMessageRequest = z.infer<typeof editMessageRequestSchema>;
export type StopGenerationResponse = z.infer<typeof stopGenerationResponseSchema>;
export type DeleteMessageResponse = z.infer<typeof deleteMessageResponseSchema>;

const pluginCommandSchema = z.object({
  name: z.string().regex(/^[a-z0-9_-]{1,32}$/),
  description: z.string().max(300).default(""),
  prompt: z.string().min(1).max(10_000),
});

export const pluginManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/),
  name: z.string().min(1).max(100),
  version: z.string().min(1).max(50),
  description: z.string().max(1_000).default(""),
  author: z.string().max(200).default(""),
  license: z.string().min(1).max(100),
  homepage: z.string().url().optional(),
  permissions: z.array(z.enum(["prompt:system", "command:register"])).max(2).default([]),
  contributes: z.object({
    systemPrompt: z.string().max(20_000).optional(),
    commands: z.array(pluginCommandSchema).max(50).default([]),
  }).default({ commands: [] }),
}).strict();

export const installedPluginSchema = pluginManifestSchema.extend({
  enabled: z.boolean(),
  installedAt: z.string().datetime(),
});

export const pluginListResponseSchema = z.object({
  items: z.array(installedPluginSchema),
  total: z.number().int().nonnegative(),
});

export const setPluginEnabledRequestSchema = z.object({
  enabled: z.boolean(),
});

export const codePluginSchema = z.object({
  kind: z.literal("sillytavern-js"),
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/),
  displayName: z.string().min(1).max(200),
  version: z.string().max(100),
  author: z.string().max(300),
  license: z.string().max(100),
  homepage: z.string().url().optional(),
  sourceUrl: z.string().url().optional(),
  sourceRef: z.string().max(200).optional(),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/i).optional(),
  extensionName: z.string().min(1).max(255).regex(/^[^/\\\u0000]+$/).optional(),
  installationScope: z.enum(["local", "global"]).optional(),
  js: z.string().max(500).nullable(),
  css: z.string().max(500).nullable(),
  enabled: z.boolean(),
  installedAt: z.string().datetime(),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  warnings: z.array(z.string()).max(50),
});

export const installCodePluginRequestSchema = z.object({
  url: z.string().trim().min(1).max(2_048),
  branch: z.string().trim().max(200).default(""),
}).strict();

export const updateCodePluginRequestSchema = z.object({
  expectedRevision: z.string().regex(/^[a-f0-9]{40}$/i),
  branch: z.string().trim().min(1).max(200).optional(),
}).strict();

export const codePluginUpdateCheckSchema = z.object({
  sourceUrl: z.string().url(),
  sourceRef: z.string().max(200),
  installedRevision: z.string().regex(/^[a-f0-9]{40}$/i),
  remoteRevision: z.string().regex(/^[a-f0-9]{40}$/i).nullable(),
  state: z.enum(["up_to_date", "update_available", "ref_missing"]),
  defaultRef: z.string().nullable(),
  refs: z.array(z.object({
    ref: z.string(),
    name: z.string(),
    kind: z.enum(["branch", "tag"]),
    revision: z.string().regex(/^[a-f0-9]{40}$/i),
  })),
  checkedAt: z.string().datetime(),
});

export type CodePluginUpdateCheck = z.infer<typeof codePluginUpdateCheckSchema>;

export const codePluginListResponseSchema = z.object({
  items: z.array(codePluginSchema),
  total: z.number().int().nonnegative(),
});

export const codePluginContributionSchema = z.object({
  systemPrompt: z.string().max(20_000).default(""),
  // Tavern slash-command help can contain full usage guides and examples.
  commands: z.array(pluginCommandSchema.extend({
    description: z.string().max(20_000).default(""),
  })).max(50).default([]),
});

export type ProviderKind = z.infer<typeof providerKindSchema>;
export type ProviderSettings = z.infer<typeof providerSettingsSchema>;
export type PromptBudgetReport = z.infer<typeof promptBudgetReportSchema>;
export type UpdateProviderSettings = z.infer<typeof updateProviderSettingsSchema>;
export type ProviderConnectionResponse = z.infer<typeof providerConnectionResponseSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;
export type ConversationListResponse = z.infer<typeof conversationListResponseSchema>;
export type SendMessageResponse = z.infer<typeof sendMessageResponseSchema>;
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export type InstalledPlugin = z.infer<typeof installedPluginSchema>;
export type PluginListResponse = z.infer<typeof pluginListResponseSchema>;
export type CodePlugin = z.infer<typeof codePluginSchema>;
export type CodePluginListResponse = z.infer<typeof codePluginListResponseSchema>;
export type CodePluginContribution = z.infer<typeof codePluginContributionSchema>;
