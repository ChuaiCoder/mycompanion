import { z } from "zod";
import { worldInfoDocumentSchema } from "./world-info.js";
import { messageGenerationMetadataSchema } from "./runtime.js";
import { memoryClaimSchema, memoryReconciliationSchema } from "./memory.js";
import { characterCardFormatSchema } from "./character-card.js";
import { providerProfilesSchema } from "./providers.js";

// 数据导入、导出和备份（FR-DATA-001…004）。

// ── FR-DATA-002 故事导出 ─────────────────────────────────────────────

export const storyExportFormatSchema = z.enum(["markdown", "json"]);

// 机器可读故事导出：消息树（含分支/父子链接）、当前分支、角色引用与时间信息。
// API Key 不进入故事数据（单独加密存储），这里额外断言字段集合中不存在密钥。
export const storyExportJsonSchema = z.object({
  format: z.literal("mycompanion-story"),
  formatVersion: z.literal(1),
  conversation: z.object({
    id: z.string().uuid(),
    characterId: z.string().uuid(),
    characterName: z.string(),
    title: z.string(),
    activeBranchId: z.string().uuid(),
    chatMetadata: z.record(z.string(), z.unknown()).optional(),
    chatHeader: z.record(z.string(), z.unknown()).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }),
  messages: z.array(
    z.object({
      id: z.string().uuid(),
      branchId: z.string().uuid(),
      parentMessageId: z.string().uuid().nullable(),
      role: z.enum(["user", "assistant"]),
      content: z.string(),
      status: z.enum(["streaming", "complete", "stopped", "failed"]),
      extensionData: z.record(z.string(), z.unknown()).optional(),
      createdAt: z.string().datetime(),
    }),
  ),
  stageSummary: z.string().max(20_000).nullable(),
  // 故事作用域记忆（FR-MEM-003）：随故事迁移，但不含角色共享/用户全局记忆。
  memories: z.array(
    z.object({
      id: z.string().uuid(),
      type: z.enum(["fact", "state", "goal", "relationship"]),
      content: z.string(),
      importance: z.number().int().min(1).max(5),
      status: z.enum(["active", "pending", "superseded", "disabled", "orphaned"]),
      pinned: z.boolean(),
      createdAt: z.string().datetime(),
    }),
  ),
});

// ── FR-DATA-004 角色删除（软删除 / 恢复 / 永久删除）─────────────────

// 删除前说明关联数量（FR-DATA-004：删除角色前说明关联故事和记忆数量）。
export const characterRelatedCountsSchema = z.object({
  characterId: z.string().uuid(),
  conversationCount: z.number().int().nonnegative(),
  memoryCount: z.number().int().nonnegative(),
});

export const characterDeleteRequestSchema = z.object({
  // 默认软删除（可恢复）；permanent 需要用户再次确认。
  permanent: z.boolean().default(false),
}).strict();

export const characterDeleteResponseSchema = z.object({
  characterId: z.string().uuid(),
  permanent: z.boolean(),
  // 软删除：关联内容随之隐藏但保留；永久删除：级联删除后给出数量。
  hiddenConversations: z.number().int().nonnegative(),
  hiddenMemories: z.number().int().nonnegative(),
});

export const characterRestoreResponseSchema = z.object({
  characterId: z.string().uuid(),
  restored: z.boolean(),
});

// ── FR-DATA-001 导出兼容性检查 ──────────────────────────────────────

// 角色卡导出格式（区别于故事导出的 markdown|json）。
export const characterExportFormatSchema = z.enum(["json", "png", "charx"]);

export const characterExportCheckRequestSchema = z.object({
  format: characterExportFormatSchema.optional(),
}).strict();

export const characterExportCheckResponseSchema = z.object({
  characterId: z.string().uuid(),
  // 目标格式无法可靠表示或第三方工具可能无法识别的字段/风险。
  warnings: z.array(z.string()).max(50),
});

// ── FR-DATA-003 完整备份 ────────────────────────────────────────────

const backupCharacterSchema = z.object({
  avatar: z.string().min(1).regex(/^[^/\\\u0000]+\.png$/).optional(),
  id: z.string().uuid(),
  rawCard: z.record(z.string(), z.unknown()),
  // 原始 PNG 头像（base64），无则省略。
  sourcePngBase64: z.string().optional(),
  assets: z.record(z.string(), z.string()).optional(),
  // Optional without a default, preserving checksums of existing backups.
  sourceFormat: characterCardFormatSchema.optional(),
  // 运行时启用状态（正则/世界书），恢复时一并还原。
  regexEnabledIndexes: z.array(z.number().int().nonnegative()).default([]),
  lorebookEnabledIndexes: z.array(z.number().int().nonnegative()).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const backupConversationSchema = z.object({
  id: z.string().uuid(),
  characterId: z.string().uuid(),
  characterName: z.string(),
  title: z.string(),
  activeBranchId: z.string().uuid(),
  chatMetadata: z.record(z.string(), z.unknown()).optional(),
  chatHeader: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /**
   * 软删除时间（可选，旧备份没有这个字段）。
   * 不带它的话，恢复后已删除的故事会重新出现，且覆盖恢复也回不到删除前的状态。
   */
  deletedAt: z.string().datetime().optional(),
  // 全部分支的完整消息树。
  messages: z.array(
    z.object({
      id: z.string().uuid(),
      branchId: z.string().uuid(),
      parentMessageId: z.string().uuid().nullable(),
      role: z.enum(["user", "assistant"]),
      content: z.string(),
      status: z.enum(["streaming", "complete", "stopped", "failed"]),
      generationMetadata: messageGenerationMetadataSchema.optional(),
      extensionData: z.record(z.string(), z.unknown()).optional(),
      createdAt: z.string().datetime(),
    }),
  ),
});

const backupMemorySchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  characterId: z.string().uuid(),
  type: z.enum(["fact", "state", "goal", "relationship"]),
  content: z.string(),
  scope: z.enum(["story", "character", "user"]),
  importance: z.number().int().min(1).max(5),
  status: z.enum(["active", "pending", "superseded", "disabled", "orphaned"]),
  pinned: z.boolean(),
  manuallyEdited: z.boolean().optional(),
  claim: memoryClaimSchema.optional(),
  reconciliation: memoryReconciliationSchema.optional(),
  sourceMessageIds: z.array(z.string().uuid()),
  sourceMessageFingerprints: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)).optional(),
  supersededBy: z.string().uuid().nullable(),
  previousContent: z.string().nullable(),
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().nullable(),
});

const backupStageSummarySchema = z.object({
  conversationId: z.string().uuid(),
  branchId: z.string().uuid().optional(),
  sourceMessageIds: z.array(z.string().uuid()).optional(),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/).or(z.literal("")).optional(),
  previousSource: z.object({
    sourceMessageIds: z.array(z.string().uuid()),
    sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/).or(z.literal("")),
    coveredMessageCount: z.number().int().nonnegative(),
  }).nullable().optional(),
  content: z.string(),
  coveredMessageCount: z.number().int().nonnegative(),
  model: z.string(),
  previousContent: z.string().nullable(),
  createdAt: z.string().datetime(),
});

const backupConversationSettingSchema = z.object({
  conversationId: z.string().uuid(),
  autoSummaryEnabled: z.boolean(),
});

// Tavern removes the card while retaining its avatar-named chat directory.
// Our detached histories contain no character card or avatar image.
export const retainedCharacterChatsSchema = z.object({
  avatar: z.string().min(1).regex(/^[^/\\\u0000]+\.png$/i),
  characterId: z.string().uuid(),
  conversations: z.array(backupConversationSchema),
  memories: z.array(backupMemorySchema),
  stageSummaries: z.array(backupStageSummarySchema),
  conversationSettings: z.array(backupConversationSettingSchema),
}).superRefine((entry, context) => {
  const ids = new Set(entry.conversations.map(item => item.id));
  const messageKeys = entry.conversations.flatMap(item => item.messages.map(message => `${message.id}/${message.branchId}`));
  const invalid = ids.size !== entry.conversations.length
    || new Set(messageKeys).size !== messageKeys.length
    || new Set(entry.memories.map(item => item.id)).size !== entry.memories.length
    || new Set(entry.stageSummaries.map(item => `${item.conversationId}/${item.branchId ?? entry.conversations.find(story => story.id === item.conversationId)?.activeBranchId}`)).size !== entry.stageSummaries.length
    || new Set(entry.conversationSettings.map(item => item.conversationId)).size !== entry.conversationSettings.length
    || entry.conversations.some(item => item.characterId !== entry.characterId)
    || entry.memories.some(item => item.characterId !== entry.characterId || !ids.has(item.conversationId))
    || [...entry.stageSummaries, ...entry.conversationSettings].some(item => !ids.has(item.conversationId));
  if (invalid) context.addIssue({ code: "custom", message: "保留聊天的身份或关联关系无效。" });
});
export type RetainedCharacterChats = z.infer<typeof retainedCharacterChatsSchema>;

const backupPluginSchema = z.object({
  id: z.string(),
  manifest: z.record(z.string(), z.unknown()),
  enabled: z.boolean(),
  installedAt: z.string().datetime(),
});

const backupSettingsSchema = z.object({
  // 非秘密设置（FR-DATA-003）：kind/地址/模型/参数；API Key 以 hasApiKey 占位，不含密文。
  kind: z.enum(["openai-compatible", "ollama", "anthropic", "gemini"]),
  baseUrl: z.string(),
  model: z.string(),
  hasApiKey: z.boolean(),
  temperature: z.number(),
  maxTokens: z.number().int(),
  contextLimitTokens: z.number().int(),
});

const backupPayloadSchema = z.object({
  format: z.literal("mycompanion-backup"),
  formatVersion: z.literal(1),
  createdAt: z.string().datetime(),
  manifest: z.object({
    characterCount: z.number().int().nonnegative(),
    conversationCount: z.number().int().nonnegative(),
    messageCount: z.number().int().nonnegative(),
    memoryCount: z.number().int().nonnegative(),
    pluginCount: z.number().int().nonnegative(),
    settingsIncluded: z.boolean(),
    // 内容完整性校验：sha256(规范化 JSON)，恢复前必须通过。
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  characters: z.array(backupCharacterSchema),
  conversations: z.array(backupConversationSchema),
  memories: z.array(backupMemorySchema),
  stageSummaries: z.array(backupStageSummarySchema),
  conversationSettings: z.array(backupConversationSettingSchema),
  plugins: z.array(backupPluginSchema),
  // Optional without a default: old backup checksums must remain unchanged.
  extensionSettings: z.record(z.string(), z.unknown()).optional(),
  userAvatars: z.array(z.object({ avatarId: z.string().min(5).max(200), bytesBase64: z.string().min(1) })).optional(),
  worldbooks: z.array(z.object({ name: z.string().min(1), data: worldInfoDocumentSchema })).optional(),
  worldInfoSettings: z.record(z.string(), z.unknown()).optional(),
  retainedCharacterChats: z.array(retainedCharacterChatsSchema).optional(),
  providerSettings: backupSettingsSchema.nullable(),
  providerProfiles: providerProfilesSchema.optional(),
});

export const backupPayloadSchemaShared = backupPayloadSchema;
export type BackupPayload = z.infer<typeof backupPayloadSchema>;

// 恢复预览：各分区的 新增 / 覆盖 / 跳过 / 冲突 数量（FR-DATA-003）。
const backupSectionPreviewSchema = z.object({
  new: z.number().int().nonnegative(),
  overwrite: z.number().int().nonnegative(),
  skip: z.number().int().nonnegative(),
  conflict: z.number().int().nonnegative(),
});

export const backupRestorePreviewResponseSchema = z.object({
  valid: z.boolean(),
  errors: z.array(z.string()).max(50),
  sections: z.object({
    characters: backupSectionPreviewSchema,
    conversations: backupSectionPreviewSchema,
    memories: backupSectionPreviewSchema,
    plugins: backupSectionPreviewSchema,
    extensionSettings: backupSectionPreviewSchema,
    userAvatars: backupSectionPreviewSchema,
    worldbooks: backupSectionPreviewSchema,
    worldInfoSettings: backupSectionPreviewSchema,
    retainedCharacterChats: backupSectionPreviewSchema,
    providerProfiles: backupSectionPreviewSchema.optional(),
  }),
  totals: backupSectionPreviewSchema,
});

export const backupRestoreRequestSchema = z.object({
  backup: backupPayloadSchema,
  // 冲突处理：overwrite=覆盖现有（默认）；skip=保留现有、跳过冲突项。
  strategy: z.enum(["overwrite", "skip"]).default("overwrite"),
}).strict();

export const backupRestoreResponseSchema = z.object({
  applied: z.object({
    characters: z.number().int().nonnegative(),
    conversations: z.number().int().nonnegative(),
    memories: z.number().int().nonnegative(),
    plugins: z.number().int().nonnegative(),
    extensionSettings: z.number().int().nonnegative(),
    userAvatars: z.number().int().nonnegative(),
    worldbooks: z.number().int().nonnegative(),
    worldInfoSettings: z.number().int().nonnegative(),
    retainedCharacterChats: z.number().int().nonnegative(),
    conversationSettings: z.number().int().nonnegative().default(0),
    providerProfiles: z.number().int().nonnegative().optional(),
  }),
  skipped: z.object({
    characters: z.number().int().nonnegative(),
    conversations: z.number().int().nonnegative(),
    memories: z.number().int().nonnegative(),
    plugins: z.number().int().nonnegative(),
    extensionSettings: z.number().int().nonnegative(),
    userAvatars: z.number().int().nonnegative(),
    worldbooks: z.number().int().nonnegative(),
    worldInfoSettings: z.number().int().nonnegative(),
    retainedCharacterChats: z.number().int().nonnegative(),
    conversationSettings: z.number().int().nonnegative().default(0),
    providerProfiles: z.number().int().nonnegative().optional(),
  }),
});

export type StoryExportFormat = z.infer<typeof storyExportFormatSchema>;
export type StoryExportJson = z.infer<typeof storyExportJsonSchema>;
export type CharacterRelatedCounts = z.infer<typeof characterRelatedCountsSchema>;
export type CharacterDeleteRequest = z.infer<typeof characterDeleteRequestSchema>;
export type CharacterDeleteResponse = z.infer<typeof characterDeleteResponseSchema>;
export type CharacterRestoreResponse = z.infer<typeof characterRestoreResponseSchema>;
export type CharacterExportCheckRequest = z.infer<typeof characterExportCheckRequestSchema>;
export type CharacterExportCheckResponse = z.infer<typeof characterExportCheckResponseSchema>;
export type BackupRestorePreviewResponse = z.infer<typeof backupRestorePreviewResponseSchema>;
export type BackupRestoreRequest = z.infer<typeof backupRestoreRequestSchema>;
export type BackupRestoreResponse = z.infer<typeof backupRestoreResponseSchema>;
