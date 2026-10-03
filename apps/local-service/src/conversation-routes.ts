import type { FastifyInstance } from "fastify";

import {
  autoSummaryRequestSchema,
  conversationDetailSchema,
  conversationListResponseSchema,
  createConversationRequestSchema,
  extensionChatSaveSchema,
  memoryListQuerySchema,
  memoryRecordSchema,
  memoryRestoreRequestSchema,
  memoryRetrievalReportSchema,
  memoryTestRequestSchema,
  memoryUpdateRequestSchema,
  stageSummarySchema,
  stageSummaryUpdateRequestSchema,
  type MemoryListQuery,
} from "@mycompanion/shared";

import { buildCharacterGreeting } from "./character-greeting.js";
import type { CharacterRepository } from "./character-repository.js";
import type { GenerationPipeline } from "./generation-pipeline.js";
import type { RuntimeRepository } from "./runtime-repository.js";
import { sendError } from "./http-errors.js";
import type { IdParams } from "./route-types.js";

export function registerConversationRoutes(app: FastifyInstance, runtime: RuntimeRepository, characters: CharacterRepository, pipeline: GenerationPipeline): void {
  const { applyRegexStage, createRegexContext } = pipeline;

  app.get("/api/conversations", async () => {
    return conversationListResponseSchema.parse(runtime.listConversations());
  });

  app.post<{ Body: unknown }>("/api/conversations", async (request, reply) => {
    const result = createConversationRequestSchema.safeParse(request.body);
    if (!result.success) {
      return sendError(reply, 400, "INVALID_REQUEST", "新故事参数无效。");
    }
    const character = characters.get(result.data.characterId);
    if (!character) {
      return sendError(reply, 404, "CHARACTER_NOT_FOUND", "所选角色不存在。");
    }
    const greetingIndex = result.data.greetingIndex;
    const originalGreeting = greetingIndex ? character.alternateGreetings[greetingIndex - 1] ?? character.firstMessage : character.firstMessage;
    const regexContext = createRegexContext(character);
    const greeting = await applyRegexStage(character, "output", originalGreeting, "assistant", undefined, false, pipeline.memoryShutdown.signal, regexContext);
    // Preserve the native greeting's existing name expansion with the selected persona.
    const firstMessage = greeting.replaceAll(/{{\s*(char|user)\s*}}/gi, (_match, name: string) =>
      name.toLowerCase() === "char" ? character.name : regexContext.macroContext.userName ?? "User");
    const conversation = runtime.withTransaction(() => {
      const created = runtime.createConversation({ ...character, firstMessage });
      runtime.commitMacroVariables(created.id, regexContext.macroSession.changes());
      return runtime.getConversation(created.id)!;
    });
    return reply.status(201).send(conversationDetailSchema.parse(conversation));
  });

  app.get<{ Params: IdParams; Querystring: { messageLimit?: number } }>("/api/conversations/:id", {
    schema: { querystring: { type: "object", properties: { messageLimit: { type: "integer", minimum: 1, maximum: 1000 } }, additionalProperties: false } },
  }, async (request, reply) => {
    const conversation = runtime.getConversation(request.params.id, request.query.messageLimit);
    if (!conversation) {
      return sendError(reply, 404, "CONVERSATION_NOT_FOUND", "故事不存在。");
    }
    return conversationDetailSchema.parse(conversation);
  });

  // 记忆中心（FR-MEM-007）：按作用域/类型/状态筛选。
  app.get<{ Params: IdParams; QueryString: MemoryListQuery }>(
    "/api/conversations/:id/memories",
    async (request, reply) => {
      const conversation = runtime.getConversation(request.params.id);
      if (!conversation) {
        return sendError(reply, 404, "CONVERSATION_NOT_FOUND", "故事不存在。");
      }
      const query = memoryListQuerySchema.parse(request.query);
      // 列表展示前刷新分支可达性（FR-MEM-008）：切回原分支后 orphaned 记忆立即恢复。
      runtime.syncMemoryReachability(conversation.id);
      const items = runtime.listMemories(conversation.id, query);
      return { conversationId: conversation.id, items, total: items.length };
    },
  );

  // 记忆测试器（FR-MEM-005）：对示例文本跑一次检索，不修改聊天。
  app.post<{ Params: IdParams; Body: unknown }>(
    "/api/conversations/:id/memories/test",
    async (request, reply) => {
      if (!runtime.conversationExists(request.params.id)) {
        return sendError(reply, 404, "CONVERSATION_NOT_FOUND", "故事不存在。");
      }
      const parsed = memoryTestRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, "INVALID_REQUEST", "示例文本无效或过长。");
      }
      return memoryRetrievalReportSchema.parse(
        await pipeline.retrieveMemory({
          conversationId: request.params.id,
          memories: runtime.listMemories(request.params.id),
          model: runtime.getProvider().model,
          scanText: parsed.data.input,
          semanticQuery: parsed.data.input,
          signal: pipeline.memoryShutdown.signal,
        }),
      );
    },
  );

  app.put<{ Params: { id: string; memoryId: string }; Body: unknown }>(
    "/api/conversations/:id/memories/:memoryId",
    async (request, reply) => {
      const conversation = runtime.getConversation(request.params.id);
      if (!conversation) {
        return sendError(reply, 404, "CONVERSATION_NOT_FOUND", "故事不存在。");
      }
      const parsed = memoryUpdateRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, "INVALID_REQUEST", "记忆更新字段无效。");
      }
      const existing = runtime.getMemoryForConversation(request.params.memoryId, conversation.id);
      if (!existing) {
        return sendError(reply, 404, "MEMORY_NOT_FOUND", "记忆不存在。");
      }
      const updated = runtime.updateMemory(request.params.memoryId, parsed.data);
      if (!updated) {
        return sendError(reply, 404, "MEMORY_NOT_FOUND", "记忆不存在。");
      }
      return memoryRecordSchema.parse(updated);
    },
  );

  // 恢复记忆的上一版本（FR-MEM-007 审计历史）。
  app.post<{ Params: { id: string; memoryId: string } }>(
    "/api/conversations/:id/memories/:memoryId/restore",
    async (request, reply) => {
      const conversation = runtime.getConversation(request.params.id);
      if (!conversation) {
        return sendError(reply, 404, "CONVERSATION_NOT_FOUND", "故事不存在。");
      }
      if (!runtime.getMemoryForConversation(request.params.memoryId, conversation.id)) {
        return sendError(reply, 404, "MEMORY_NOT_FOUND", "记忆不存在。");
      }
      const parsed = memoryRestoreRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "记忆恢复模式无效。");
      const restored = runtime.restoreMemory(request.params.memoryId, parsed.data.mode);
      if (!restored) {
        return sendError(reply, 404, "MEMORY_NOT_FOUND", "记忆不存在。");
      }
      return memoryRecordSchema.parse(restored);
    },
  );

  app.delete<{ Params: { id: string; memoryId: string } }>(
    "/api/conversations/:id/memories/:memoryId",
    async (request, reply) => {
      const conversation = runtime.getConversation(request.params.id);
      if (!conversation) {
        return sendError(reply, 404, "CONVERSATION_NOT_FOUND", "故事不存在。");
      }
      if (!runtime.getMemoryForConversation(request.params.memoryId, conversation.id)
        || !runtime.deleteMemory(request.params.memoryId)) {
        return sendError(reply, 404, "MEMORY_NOT_FOUND", "记忆不存在。");
      }
      return { deleted: true };
    },
  );

  // 阶段摘要（FR-MEM-006）：读取 / 编辑 / 恢复 / 开关自动摘要。
  app.get<{ Params: IdParams }>("/api/conversations/:id/summary", async (request, reply) => {
    const conversation = runtime.getConversation(request.params.id);
    if (!conversation) {
      return sendError(reply, 404, "CONVERSATION_NOT_FOUND", "故事不存在。");
    }
    const summary = runtime.getSummary(conversation.id);
    return {
      conversationId: conversation.id,
      autoSummaryEnabled: runtime.isAutoSummaryEnabled(conversation.id),
      summary,
    };
  });

  app.put<{ Params: IdParams; Body: unknown }>(
    "/api/conversations/:id/summary",
    async (request, reply) => {
      const conversation = runtime.getConversation(request.params.id);
      if (!conversation) {
        return sendError(reply, 404, "CONVERSATION_NOT_FOUND", "故事不存在。");
      }
      const parsed = stageSummaryUpdateRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, "INVALID_REQUEST", "摘要内容无效。");
      }
      const existing = runtime.getSummary(conversation.id);
      const saved = existing
        ? runtime.editSummary(conversation.id, parsed.data.content)
        : runtime.saveSummary(conversation.id, parsed.data.content, 0, runtime.getProvider().model);
      if (!saved) {
        return sendError(reply, 404, "SUMMARY_NOT_FOUND", "摘要不存在。");
      }
      return stageSummarySchema.parse(saved);
    },
  );

  app.post<{ Params: IdParams }>(
    "/api/conversations/:id/summary/restore",
    async (request, reply) => {
      const conversation = runtime.getConversation(request.params.id);
      if (!conversation) {
        return sendError(reply, 404, "CONVERSATION_NOT_FOUND", "故事不存在。");
      }
      const restored = runtime.restoreSummary(conversation.id);
      // 从未有过摘要时返回空摘要占位（model 使用当前模型，满足契约）。
      return stageSummarySchema.parse(restored ?? {
        id: conversation.id,
        conversationId: conversation.id,
        content: "",
        coveredMessageCount: 0,
        model: runtime.getProvider().model,
        previousContent: null,
        createdAt: new Date().toISOString(),
      });
    },
  );

  app.put<{ Params: IdParams; Body: unknown }>(
    "/api/conversations/:id/summary/auto",
    async (request, reply) => {
      const conversation = runtime.getConversation(request.params.id);
      if (!conversation) {
        return sendError(reply, 404, "CONVERSATION_NOT_FOUND", "故事不存在。");
      }
      const parsed = autoSummaryRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, "INVALID_REQUEST", "自动摘要开关无效。");
      }
      runtime.setAutoSummaryEnabled(conversation.id, parsed.data.enabled);
      return { conversationId: conversation.id, autoSummaryEnabled: parsed.data.enabled };
    },
  );

  // Preview only: the editor applies the result through the shared chat bridge,
  // after extension events, and explicitly saves it just like other chat edits.
  app.get<{ Params: IdParams }>("/api/conversations/:id/greeting", async (request, reply) => {
    const conversation = runtime.getConversation(request.params.id);
    const character = conversation && characters.get(conversation.characterId);
    if (!conversation || !character) return reply.code(404).send({ error: { message: "故事或角色不存在。" } });
    const regexContext = createRegexContext(character, conversation.id);
    const message = await buildCharacterGreeting(character, regexContext.extensionSettings, {
      transform: text => applyRegexStage(character, "output", text, "assistant", undefined, false, pipeline.memoryShutdown.signal, regexContext),
    });
    const latest = runtime.getConversation(request.params.id);
    if (!latest) return reply.code(404).send({ error: { message: "故事已删除。" } });
    if (latest.activeBranchId !== conversation.activeBranchId) return sendError(reply, 409, "BRANCH_CHANGED", "预览期间故事分支已改变，请重新读取开场白。");
    return reply.header("Cache-Control", "no-store").send({
      characterId: character.id, branchId: latest.activeBranchId,
      tainted: Boolean(latest.chatMetadata?.tainted), message,
    });
  });

  app.put<{ Params: IdParams; Body: unknown }>("/api/conversations/:id/extension-state", { bodyLimit: 500 * 1024 * 1024 }, async (request, reply) => {
    const parsed = extensionChatSaveSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: { code: "INVALID_EXTENSION_CHAT", message: "扩展聊天数据无效。", details: parsed.error.issues.map(issue => issue.message) } });
    const conversation = runtime.getConversation(request.params.id);
    if (!conversation) return sendError(reply, 404, "CONVERSATION_NOT_FOUND", "故事不存在。");
    if (parsed.data.branchId !== conversation.activeBranchId && !runtime.listAllBranchMessages(conversation.id).some(message => message.branchId === parsed.data.branchId)) {
      return sendError(reply, 409, "BRANCH_NOT_FOUND", "要保存的故事分支不存在，请重新载入故事。");
    }
    return conversationDetailSchema.parse(runtime.saveExtensionChatState(request.params.id, parsed.data));
  });
}
