import { z } from "zod";

import { characterLorebookEntrySchema } from "./character-card.js";

// 单条世界书条目的匹配结果（FR-LORE-002/003 的诊断来源）。
// injected=进入提示词；no_match=关键词未命中；budget_dropped=命中但超出 Token 预算被舍弃；
// disabled=运行时未启用（导入默认停用）。
export const lorebookEntryResultSchema = z.object({
  index: z.number().int().nonnegative(),
  name: z.string(),
  status: z.enum(["injected", "no_match", "budget_dropped", "disabled"]),
  matchedKey: z.string().nullable(),
  tokens: z.number().int().nonnegative(),
  diagnostics: z.array(z.string()).max(50),
  // 注入条目宏解析后的内容；仅 status=injected 时有值，供全局 Token 预算按条目裁剪。
  content: z.string().max(200_000).default(""),
  constant: z.boolean().optional(),
  insertionOrder: z.number().optional(),
  world: z.string().optional(),
  uid: z.union([z.string(), z.number()]).optional(),
  position: z.number().optional(),
  depth: z.number().optional(),
  role: z.number().optional(),
  outletName: z.string().optional(),
});

// 一次世界书匹配报告（FR-LORE-003：触发的条目、原因与注入位置都要可见）。
// block 是最终插入提示词的文本（宏已解析）；空字符串表示本轮没有注入。
// constantBlock 是常驻条目的独立块：FR-PROMPT-003 的全局 Token 预算
// 优先保留常驻内容，它不参与“较旧内容先被裁剪”的顺序。
export const lorebookReportSchema = z.object({
  characterId: z.string().uuid(),
  results: z.array(lorebookEntryResultSchema),
  block: z.string().max(2 * 1024 * 1024),
  constantBlock: z.string().max(2 * 1024 * 1024).default(""),
  // 注入位置固定为系统提示词的“世界书与当前故事状态”区域（FR-PROMPT-002 第 3 区），
  // 位于角色核心设定之后、记忆与近期消息之前。
  position: z.literal("after_character_core"),
  budgetTokens: z.number().int().nonnegative(),
  injectedCount: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
});

// 世界书测试器请求（FR-LORE-003）：对示例文本跑一次匹配，不修改聊天。
export const lorebookTestRequestSchema = z
  .object({
    input: z.string().max(1024 * 1024).default(""),
  })
  .strict();

// 启用状态切换请求。
export const lorebookEntryStateRequestSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

// 角色的世界书条目列表（含运行时启用状态）。
export const characterLorebookEntryListResponseSchema = z.object({
  characterId: z.string().uuid(),
  entries: z.array(characterLorebookEntrySchema),
});

export type LorebookEntryResult = z.infer<typeof lorebookEntryResultSchema>;
export type LorebookReport = z.infer<typeof lorebookReportSchema>;
export type LorebookTestRequest = z.infer<typeof lorebookTestRequestSchema>;
export type LorebookEntryStateRequest = z.infer<typeof lorebookEntryStateRequestSchema>;
