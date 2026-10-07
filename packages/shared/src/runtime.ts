import { z } from "zod";
import { toolInvocationSchema } from "./tools.js";

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

// 卡片脚本可用的变量作用域。这是本应用自己的实现，不依赖宏引擎的内部模型。
// `character` 与 `chat` 共用故事级存储：本应用把每个对话视为一次独立开档，
// 角色级跨故事共享会破坏这个原则。
export const cardVariableTypeSchema = z.enum(["chat", "character", "preset", "global", "message"]);
export type CardVariableType = z.infer<typeof cardVariableTypeSchema>;

export const cardVariableValuesSchema = z.record(z.string(), z.unknown());

/** 读取一级变量；不给作用域时返回三级合并视图。 */
export const cardVariablesResponseSchema = z.object({
  variables: cardVariableValuesSchema,
  /** 各级原始视图，便于调用方区分来源而不是只看合并结果。 */
  scopes: z.object({
    global: cardVariableValuesSchema,
    chat: cardVariableValuesSchema,
    character: cardVariableValuesSchema,
    preset: cardVariableValuesSchema,
    message: cardVariableValuesSchema,
  }),
});
export type CardVariablesResponse = z.infer<typeof cardVariablesResponseSchema>;

const cardVariableTargetSchema = z.object({
  type: cardVariableTypeSchema,
  /** 仅 `message` 作用域可用；省略表示当前最后一条消息。 */
  messageId: z.string().uuid().optional(),
}).strict();

/**
 * 一次变量写入。分成明确的动作而不是一个宽泛的 setter，
 * 这样 `insertVariables`（只补缺失）与 `replaceVariables`（整体替换）不会互相混淆。
 */
export const cardVariableMutationSchema = z.discriminatedUnion("action", [
  cardVariableTargetSchema.extend({ action: z.literal("set"), key: z.string().min(1), value: z.unknown(), remove: z.boolean().default(false) }),
  cardVariableTargetSchema.extend({ action: z.literal("replace"), values: cardVariableValuesSchema }),
  cardVariableTargetSchema.extend({ action: z.literal("insert"), values: cardVariableValuesSchema }),
  cardVariableTargetSchema.extend({ action: z.literal("delete"), subject: z.enum(["key", "value"]), target: z.unknown() }),
]);
export type CardVariableMutation = z.infer<typeof cardVariableMutationSchema>;

export const cardVariableMutationRequestSchema = z.object({ mutation: cardVariableMutationSchema }).strict();

// 显示阶段正则（`markdownOnly` 规则）：只影响渲染，不落库、不提交宏变量副作用。
// 卡常把整段界面放在这类规则里，靠它把占位符换成真实界面——例如把 `[重塑仙缘]`
// 替换成人物创建界面。没有这条通路时，这类规则无论启用与否都不会执行。
export const displayRegexRequestSchema = z.object({
  /** 待转换的文本；按顺序与响应 results 对应。 */
  items: z.array(z.object({ messageId: z.string().uuid(), text: z.string() })).max(200),
}).strict();

export const displayRegexResponseSchema = z.object({
  results: z.array(z.object({ messageId: z.string().uuid(), text: z.string() })),
});
export type DisplayRegexResponse = z.infer<typeof displayRegexResponseSchema>;

// 软删除（FR-DATA-004）：删除后可恢复，列表与详情默认不再返回该故事。
export const deleteConversationResponseSchema = z.object({
  id: z.string().uuid(),
  deletedAt: z.string().datetime(),
});

/**
 * 批量删除故事（同为软删除）。
 *
 * 上限 200 与其它批量接口一致，避免一次请求把整个库拖进长事务；重复 id 由服务端去重，
 * 因此客户端重试是安全的。
 */
export const deleteConversationsRequestSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
}).strict();

export const deleteConversationsResponseSchema = z.object({
  deleted: z.array(z.object({ id: z.string().uuid(), deletedAt: z.string().datetime() })),
  /** 已删除或不存在而未能删除的 id，单独回报，避免客户端把"没删掉"当成成功。 */
  skipped: z.array(z.string().uuid()),
});
export type DeleteConversationsResponse = z.infer<typeof deleteConversationsResponseSchema>;

/** 彻底删除所有已软删除的故事：不可恢复，返回真正移除的条数。 */
export const purgeDeletedConversationsResponseSchema = z.object({
  removed: z.number().int().min(0),
});
export type PurgeDeletedConversationsResponse = z.infer<typeof purgeDeletedConversationsResponseSchema>;

export const createConversationRequestSchema = z.object({
  characterId: z.string().uuid(),
  greetingIndex: z.number().int().min(0).optional(),
});

export const sendMessageRequestSchema = z.object({
  content: z.string().trim().max(100_000),
  allowEmpty: z.boolean().default(false),
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

export const nativeGenerationRequestSchema = z.object({
  dryRun: z.boolean().default(false),
});

export const sendMessageResponseSchema = z.object({
  userMessage: chatMessageSchema,
  assistantMessage: chatMessageSchema,
});

// SSE 生成流事件。服务端以 text/event-stream 逐事件发送，
// 客户端按 type 分发；delta 是增量文本，done 携带最终消息（complete 或 stopped）。
export const generationSseEventSchema = z.discriminatedUnion("type", [
  z.object({type:z.literal("macro_variables"),conversationId:z.string().uuid(),branchId:z.string().uuid().optional(),
    worldInfoState:z.record(z.string(),z.unknown()).optional(),changes:z.array(z.object({
    scope:z.enum(["local","global"]),key:z.string(),beforeExists:z.boolean(),afterExists:z.boolean(),before:z.unknown().optional(),after:z.unknown().optional(),
  }))}),
  z.object({ type: z.literal("impersonate_result"), text: z.string() }),
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

// 选择候选回复（FR-CHAT）：swipe_id/内容/扩展数据由服务端原子更新。
export const selectMessageSwipeRequestSchema = z.object({
  swipeId: z.number().int().nonnegative(),
}).strict();

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
export type SelectMessageSwipeRequest = z.infer<typeof selectMessageSwipeRequestSchema>;
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

export type ProviderKind = z.infer<typeof providerKindSchema>;

/**
 * 列出模型时的草稿校验（比写入宽松）：模型名可以为空。
 * 「获取模型」的目的正是**还不知道**该填哪个模型，要求 model 非空会让自定义服务
 * 永远拿不到列表（400）。
 *
 * 注意：**不要**加 `.strict()`。前端发来的是完整草稿（还带 temperature / maxTokens /
 * contextLimitTokens / clearApiKey 等），多余字段必须被忽略而不是拒绝——否则同样 400。
 */
export const listProviderModelsRequestSchema = z.object({
  kind: providerKindSchema,
  baseUrl: z.string().min(1).max(2_048),
  model: z.string().max(200).default(""),
  apiKey: z.string().max(8_192).optional(),
  clearApiKey: z.boolean().optional().default(false),
});
export type ListProviderModelsRequest = z.infer<typeof listProviderModelsRequestSchema>;

/**
 * 模型列表（设置页「测试获取模型」）：按协议向服务商要一份可选的模型名，
 * 让用户从真实结果里挑，而不是手打模型名猜。
 */
export const providerModelsResponseSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  models: z.array(z.string()).max(500),
});
export type ProviderModelsResponse = z.infer<typeof providerModelsResponseSchema>;
export type ProviderSettings = z.infer<typeof providerSettingsSchema>;
export type PromptBudgetReport = z.infer<typeof promptBudgetReportSchema>;
export type UpdateProviderSettings = z.infer<typeof updateProviderSettingsSchema>;
export type ProviderConnectionResponse = z.infer<typeof providerConnectionResponseSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;
export type ConversationListResponse = z.infer<typeof conversationListResponseSchema>;
export type DeleteConversationResponse = z.infer<typeof deleteConversationResponseSchema>;
export type SendMessageResponse = z.infer<typeof sendMessageResponseSchema>;
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export type InstalledPlugin = z.infer<typeof installedPluginSchema>;
export type PluginListResponse = z.infer<typeof pluginListResponseSchema>;
