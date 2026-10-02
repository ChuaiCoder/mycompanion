import { z } from "zod";

// 长期记忆（FR-MEM-001/002/003）。
// 类型：fact（事件/事实）、state（当前故事状态：地点/时间/关系/物品/目标）、
// goal（进行中目标）、relationship（角色关系）。
// 作用域：story（当前故事线，自动提取默认写入）、character（当前角色共享）、
// user（当前用户全局）。后两者只能由用户显式提升。
export const memoryTypeSchema = z.enum(["fact", "state", "goal", "relationship"]);
export const memoryScopeSchema = z.enum(["story", "character", "user"]);
// active=可注入；pending=低置信度冲突待确认（不自动注入，FR-MEM-004）；
// superseded=被新记忆取代（保留历史与来源）；disabled=用户停用；
// orphaned=来源消息全部不再可达（FR-MEM-008，分支回滚时停用，回到原分支可恢复）。
export const memoryStatusSchema = z.enum(["active", "pending", "superseded", "disabled", "orphaned"]);

// Structured claims are extraction evidence, never inferred from lexical similarity.
export const memoryClaimSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  predicate: z.string().trim().min(1).max(200),
  value: z.string().trim().min(1).max(500),
  temporality: z.enum(["stable", "current", "event"]),
  transition: z.object({
    from: z.string().trim().min(1).max(500),
    sourceMessageId: z.string().uuid(),
    quote: z.string().trim().min(1).max(2_000),
  }).optional(),
});

export const memoryReconciliationSchema = z.object({
  kind: z.enum(["duplicate", "conflict", "temporal_update", "unrelated", "uncertain"]),
  relatedMemoryIds: z.array(z.string().uuid()),
  reason: z.string().max(2_000),
});

export const memoryRecordSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  characterId: z.string().uuid(),
  type: memoryTypeSchema,
  content: z.string().min(1).max(2_000),
  scope: memoryScopeSchema,
  importance: z.number().int().min(1).max(5),
  status: memoryStatusSchema,
  pinned: z.boolean(),
  manuallyEdited: z.boolean().optional(),
  claim: memoryClaimSchema.optional(),
  reconciliation: memoryReconciliationSchema.optional(),
  // 来源消息 ID（FR-MEM-002）：全部不可达时记忆转 orphaned。
  sourceMessageIds: z.array(z.string().uuid()).max(50),
  sourceMessageFingerprints: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)).optional(),
  // 替代关系（FR-MEM-004）：指向取代它的新记忆。
  supersededBy: z.string().uuid().nullable(),
  // 上一次编辑前的内容，用于“恢复上一版本”（FR-MEM-007）。
  previousContent: z.string().max(2_000).nullable(),
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().nullable(),
});

// 单条记忆的检索结果（FR-MEM-005）：得分、是否注入与原因都要可见。
export const memoryRetrievalResultSchema = z.object({
  memoryId: z.string().uuid(),
  type: memoryTypeSchema,
  scope: memoryScopeSchema,
  score: z.number().nonnegative(),
  injected: z.boolean(),
  pinned: z.boolean().optional(),
  // 注入内容（宏已解析），供全局 Token 预算按得分裁剪（FR-PROMPT-003）。
  content: z.string().max(2_000).default(""),
  tokens: z.number().int().nonnegative().default(0),
  diagnostics: z.array(z.string()).max(50),
});

// 一次记忆检索报告：block 是注入提示词的记忆块（FR-PROMPT-002 第 4 区），
// position 固定为“近期消息之前”。
export const memoryRetrievalReportSchema = z.object({
  conversationId: z.string().uuid(),
  results: z.array(memoryRetrievalResultSchema),
  block: z.string().max(2 * 1024 * 1024),
  position: z.literal("before_recent_messages"),
  budgetTokens: z.number().int().nonnegative(),
  pinnedBudgetTokens: z.number().int().nonnegative().optional(),
  injectedCount: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
});

// 记忆中心（FR-MEM-007）筛选。
export const memoryListQuerySchema = z.object({
  scope: memoryScopeSchema.optional(),
  type: memoryTypeSchema.optional(),
  status: memoryStatusSchema.optional(),
});

export const memoryUpdateRequestSchema = z.object({
  content: z.string().trim().min(1).max(2_000).optional(),
  scope: memoryScopeSchema.optional(),
  pinned: z.boolean().optional(),
  status: z.enum(["active", "disabled"]).optional(),
}).strict();

export const memoryRestoreRequestSchema = z.object({
  mode: z.enum(["supersession", "previous_content"]).optional(),
}).strict();

// 检索测试器（FR-MEM-005）：对示例文本跑一次检索，不修改聊天。
export const memoryTestRequestSchema = z
  .object({
    input: z.string().max(1024 * 1024).default(""),
  })
  .strict();

// 阶段摘要（FR-MEM-006）：压缩较早剧情，保存覆盖范围与生成模型。
export const stageSummarySchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  branchId: z.string().uuid().optional(),
  sourceMessageIds: z.array(z.string().uuid()).optional(),
  valid: z.boolean().optional(),
  content: z.string().max(20_000),
  // 摘要覆盖的消息条数（按当前分支消息顺序的前缀）。
  coveredMessageCount: z.number().int().nonnegative(),
  model: z.string().min(1),
  previousContent: z.string().max(20_000).nullable(),
  createdAt: z.string().datetime(),
});

export const stageSummaryUpdateRequestSchema = z
  .object({
    content: z.string().trim().min(1).max(20_000),
  })
  .strict();

export const autoSummaryRequestSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

export type MemoryType = z.infer<typeof memoryTypeSchema>;
export type MemoryScope = z.infer<typeof memoryScopeSchema>;
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;
export type MemoryRetrievalResult = z.infer<typeof memoryRetrievalResultSchema>;
export type MemoryRetrievalReport = z.infer<typeof memoryRetrievalReportSchema>;
export type MemoryListQuery = z.infer<typeof memoryListQuerySchema>;
export type MemoryUpdateRequest = z.infer<typeof memoryUpdateRequestSchema>;
export type MemoryTestRequest = z.infer<typeof memoryTestRequestSchema>;
export type StageSummary = z.infer<typeof stageSummarySchema>;
export type StageSummaryUpdateRequest = z.infer<typeof stageSummaryUpdateRequestSchema>;
