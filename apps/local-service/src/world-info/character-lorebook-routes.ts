import type { FastifyInstance } from "fastify";

import {
  lorebookEntryStateRequestSchema,
  lorebookReportSchema,
  lorebookTestRequestSchema,
} from "@mycompanion/shared";

import type { CharacterRepository } from "../character/character-repository.js";
import { matchLorebookEntries } from "./worldbook-engine.js";
import { sendError } from "../http-errors.js";
import type { CharacterParams } from "../route-types.js";

export function registerCharacterLorebookRoutes(app: FastifyInstance, characters: CharacterRepository): void {
  // 角色的世界书条目（FR-LORE-001/002）：展示导入的条目及其运行时启用状态。
  app.get<{
    Params: CharacterParams;
    Reply: unknown;
  }>("/api/characters/:id/lorebook", async (request, reply) => {
    const character = characters.get(request.params.id);
    if (!character) {
      return sendError(reply, 404, "CHARACTER_NOT_FOUND", "The requested character does not exist.");
    }
    return { characterId: character.id, entries: character.lorebookEnabled };
  });

  // 启用/停用单条世界书条目（FR-LORE-002）。
  app.put<{
    Params: { id: string; index: string };
    Body: unknown;
    Reply: unknown;
  }>("/api/characters/:id/lorebook/:index", async (request, reply) => {
    const parsed = lorebookEntryStateRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "INVALID_REQUEST", "世界书条目状态无效。");
    }
    const index = Number(request.params.index);
    if (!Number.isInteger(index) || index < 0) {
      return sendError(reply, 400, "INVALID_REQUEST", "条目序号无效。");
    }
    const entries = characters.setLorebookEntryEnabled(request.params.id, index, parsed.data.enabled);
    if (!entries) {
      return sendError(reply, 404, "LOREBOOK_ENTRY_NOT_FOUND", "世界书条目不存在或角色已删除。");
    }
    return entries;
  });

  // 一次性启用/停用当前角色全部世界书条目（FR-LORE-002）。
  app.put<{ Params: CharacterParams; Body: unknown; Reply: unknown }>(
    "/api/characters/:id/lorebook/all",
    async (request, reply) => {
      const parsed = lorebookEntryStateRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, "INVALID_REQUEST", "世界书条目状态无效。");
      }
      const entries = characters.setAllLorebookEntriesEnabled(request.params.id, parsed.data.enabled);
      if (!entries) {
        return sendError(reply, 404, "CHARACTER_NOT_FOUND", "角色不存在。");
      }
      return entries;
    },
  );

  // 世界书测试器（FR-LORE-003）：对示例文本跑一次匹配，不修改真实聊天。
  app.post<{
    Params: CharacterParams;
    Body: unknown;
    Reply: unknown;
  }>("/api/characters/:id/lorebook/test", async (request, reply) => {
    const character = characters.get(request.params.id);
    if (!character) {
      return sendError(reply, 404, "CHARACTER_NOT_FOUND", "The requested character does not exist.");
    }
    const parsed = lorebookTestRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "INVALID_REQUEST", "示例文本无效或过长。");
    }
    return lorebookReportSchema.parse(
      matchLorebookEntries(character.id, character.lorebookEnabled, character.name, parsed.data.input),
    );
  });
}
