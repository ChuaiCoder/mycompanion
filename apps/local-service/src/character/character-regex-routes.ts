import type { FastifyInstance } from "fastify";

import {
  regexRuleStateRequestSchema,
  regexTestRequestSchema,
  regexTestResponseSchema,
  type ApiErrorResponse,
  type RegexTestResponse,
} from "@mycompanion/shared";

import type { CharacterRepository } from "./character-repository.js";
import type { GenerationPipeline } from "../chat/generation-pipeline.js";
import { testRegexRules } from "../prompt/regex-engine.js";
import { sendError } from "../http-errors.js";
import type { CharacterParams } from "../route-types.js";

export function registerCharacterRegexRoutes(app: FastifyInstance, characters: CharacterRepository, pipeline: GenerationPipeline): void {
  const { allowNativeCharacterRegex } = pipeline;

  // 角色的正则规则（FR-REGEX-001/007）：展示导入的规则及其启用状态。
  app.get<{
    Params: CharacterParams;
    Reply: unknown;
  }>("/api/characters/:id/regex", async (request, reply) => {
    const character = characters.get(request.params.id);
    if (!character) {
      return sendError(reply, 404, "CHARACTER_NOT_FOUND", "The requested character does not exist.");
    }
    return { characterId: character.id, rules: character.regexEnabled };
  });

  // 启用/停用单条正则规则（FR-REGEX-007）。
  app.put<{
    Params: { id: string; order: string };
    Body: unknown;
    Reply: unknown;
  }>("/api/characters/:id/regex/:order", async (request, reply) => {
    const parsed = regexRuleStateRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "INVALID_REQUEST", "正则规则状态无效。");
    }
    const order = Number(request.params.order);
    if (!Number.isInteger(order) || order < 0) {
      return sendError(reply, 400, "INVALID_REQUEST", "规则序号无效。");
    }
    const rules = characters.setRegexRuleEnabled(request.params.id, order, parsed.data.enabled);
    if (!rules) {
      return sendError(reply, 404, "REGEX_RULE_NOT_FOUND", "正则规则不存在或角色已删除。");
    }
    if (parsed.data.enabled) allowNativeCharacterRegex(request.params.id);
    return rules;
  });

  // 一次性启用/停用当前角色全部规则（FR-REGEX-007）。
  app.put<{ Params: CharacterParams; Body: unknown; Reply: unknown }>(
    "/api/characters/:id/regex/all",
    async (request, reply) => {
      const parsed = regexRuleStateRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, "INVALID_REQUEST", "正则规则状态无效。");
      }
      const rules = characters.setAllRegexRulesEnabled(request.params.id, parsed.data.enabled);
      if (!rules) {
        return sendError(reply, 404, "CHARACTER_NOT_FOUND", "角色不存在。");
      }
      if (parsed.data.enabled) allowNativeCharacterRegex(request.params.id);
      return rules;
    },
  );

  // 正则规则测试器（FR-REGEX-007）：对示例文本跑四阶段流水线，不修改真实聊天。
  app.post<{
    Params: CharacterParams;
    Body: unknown;
    Reply: RegexTestResponse | ApiErrorResponse;
  }>("/api/characters/:id/regex/test", async (request, reply) => {
    const character = characters.get(request.params.id);
    if (!character) {
      return sendError(reply, 404, "CHARACTER_NOT_FOUND", "The requested character does not exist.");
    }
    const parsed = regexTestRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "INVALID_REQUEST", "示例文本无效或过长。");
    }
    const report = await testRegexRules(character.regexEnabled, character.name, parsed.data.input);
    return regexTestResponseSchema.parse({
      characterId: character.id,
      stages: report.stages,
      finalOutput: report.finalOutput,
      durationMs: report.durationMs,
    });
  });
}
