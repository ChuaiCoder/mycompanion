import { z } from "zod";

import { characterRegexRuleSchema } from "./character-card.js";

// 正则规则作用阶段（FR-REGEX-002）。与 SillyTavern 的 placement 语义对齐：
// input=用户输入，prompt=仅模型上下文，output=助手回复，display=仅界面渲染。
export const regexStageSchema = z.enum(["input", "prompt", "output", "display"]);

// 单条规则执行结果（FR-REGEX-005/007 的诊断来源）。
// failed=该规则因超时/语法错误/超输出上限而未生效；其余阶段不受影响。
export const regexRuleResultSchema = z.object({
  name: z.string().min(1),
  stage: regexStageSchema,
  status: z.enum(["applied", "no_match", "skipped", "failed"]),
  output: z.string().max(2 * 1024 * 1024),
  durationMs: z.number().nonnegative(),
  diagnostics: z.array(z.string()).max(50),
});

// 规则测试器请求（FR-REGEX-007）：对示例文本跑完整四阶段流水线，不修改聊天。
export const regexTestRequestSchema = z
  .object({
    input: z.string().max(1024 * 1024).default(""),
  })
  .strict();

// 规则测试器响应：逐阶段、逐规则的输入/输出/耗时/错误。
export const regexTestResponseSchema = z.object({
  characterId: z.string().uuid(),
  stages: z.array(
    z.object({
      stage: regexStageSchema,
      input: z.string().max(2 * 1024 * 1024),
      output: z.string().max(2 * 1024 * 1024),
      rules: z.array(regexRuleResultSchema),
    }),
  ),
  finalOutput: z.string().max(2 * 1024 * 1024),
  durationMs: z.number().nonnegative(),
});

// 启用状态切换请求。
export const regexRuleStateRequestSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

// 角色的正则规则列表（含运行时启用状态，FR-REGEX-007）。
export const characterRegexRuleListResponseSchema = z.object({
  characterId: z.string().uuid(),
  rules: z.array(characterRegexRuleSchema),
});

export type RegexStage = z.infer<typeof regexStageSchema>;
export type RegexRuleResult = z.infer<typeof regexRuleResultSchema>;
export type RegexTestRequest = z.infer<typeof regexTestRequestSchema>;
export type RegexTestResponse = z.infer<typeof regexTestResponseSchema>;
export type RegexRuleStateRequest = z.infer<typeof regexRuleStateRequestSchema>;
