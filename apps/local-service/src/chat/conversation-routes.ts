import type { FastifyInstance } from "fastify";

import {
  autoSummaryRequestSchema,
  conversationDetailSchema,
  conversationListResponseSchema,
  createConversationRequestSchema,
  deleteConversationResponseSchema,
  deleteConversationsRequestSchema,
  deleteConversationsResponseSchema,
  purgeDeletedConversationsResponseSchema,
  displayRegexRequestSchema,
  displayRegexResponseSchema,
  memoryListQuerySchema,
  memoryInventoryResponseSchema,
  memoryRecordSchema,
  memoryRestoreRequestSchema,
  memoryRetrievalReportSchema,
  memoryTestRequestSchema,
  memoryUpdateRequestSchema,
  stageSummarySchema,
  stageSummaryUpdateRequestSchema,
  type MemoryListQuery,
} from "@mycompanion/shared";

import { buildCharacterGreeting } from "../character/character-greeting.js";
import type { CharacterRepository } from "../character/character-repository.js";
import type { GenerationPipeline } from "./generation-pipeline.js";
import type { RuntimeRepository } from "../persistence/runtime-repository.js";
import { sendError } from "../http-errors.js";
import type { IdParams } from "../route-types.js";

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
    // 备用开场白**不在此处预转换**：输出正则会写入变量（宏副作用），提前转换所有候选会让
    // 副作用多跑一遍。未选中的候选留给切换接口按需转换（见 selectMessageSwipe 的路由）。
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

  // 批量删除故事：与单条删除同为软删除，一次事务落库。
  // 单独列为一个路由而不是让客户端循环调用，是为了让"一批"只发生一次写入，
  // 并且能一次性回报哪些没删掉（已删/不存在），而不是把幂等伪装成全部成功。
  app.post<{ Body: unknown }>("/api/conversations/delete-batch", async (request, reply) => {
    const parsed = deleteConversationsRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "请选择要删除的故事（1 到 200 个）。");
    const { ids } = parsed.data;
    // 先取消这些故事的在途生成，否则模型请求会继续跑完，把新消息写进已删除的故事里。
    for (const id of ids) pipeline.inFlightGenerations.get(id)?.abort();
    return deleteConversationsResponseSchema.parse(runtime.softDeleteConversations(ids));
  });

  // 彻底删除所有已软删除的故事（不可恢复）。
  // 软删除只打标记，内容会一直占着库；这个入口让用户决定何时真正释放空间，
  // 并且顺带回收磁盘（VACUUM）——实测一份库里有 141 个软删除故事、2250 个空闲页。
  // 路径写死在 :id 之前，避免被当成某个故事的 id。
  app.delete("/api/conversations/deleted", async (_request, reply) => {
    const removed = runtime.purgeDeletedConversations();
    // VACUUM 不能在事务里执行，因此放在删除之后；失败不影响删除结果，只是空间没回收。
    try { runtime.vacuum(); } catch { /* 空间回收失败不影响已完成的删除 */ }
    return purgeDeletedConversationsResponseSchema.parse({ removed });
  });

  // 删除故事（FR-DATA-004）：默认软删除，可恢复；已有删除标记时幂等返回同一时间。
  app.delete<{ Params: IdParams }>("/api/conversations/:id", async (request, reply) => {
    const { id } = request.params;
    // 先取消在途生成：否则模型请求会继续跑完，把新消息写进一个已经删除的故事里。
    pipeline.inFlightGenerations.get(id)?.abort();
    const deletedAt = runtime.softDeleteConversation(id) ?? runtime.conversationDeletedAt(id);
    if (!deletedAt) {
      return sendError(reply, 404, "CONVERSATION_NOT_FOUND", "故事不存在。");
    }
    return deleteConversationResponseSchema.parse({ id, deletedAt });
  });

  // 恢复软删除的故事：内容从未被改写，恢复后立即可读。
  app.post<{ Params: IdParams }>("/api/conversations/:id/restore", async (request, reply) => {
    const { id } = request.params;
    if (!runtime.undeleteConversation(id)) {
      // 区分「本来就没删」与「根本不存在」，避免把幂等写成误报成功。
      return runtime.conversationDeletedAt(id) === null
        ? sendError(reply, 409, "CONVERSATION_NOT_DELETED", "这个故事没有被删除。")
        : sendError(reply, 404, "CONVERSATION_NOT_FOUND", "故事不存在。");
    }
    return conversationDetailSchema.parse(runtime.getConversation(id));
  });

  // 记忆中心（FR-MEM-007）：按作用域/类型/状态筛选。
  app.get<{ Params: IdParams; Querystring: MemoryListQuery }>(
    "/api/conversations/:id/memories",
    async (request, reply) => {
      const conversation = runtime.getConversation(request.params.id);
      if (!conversation) {
        return sendError(reply, 404, "CONVERSATION_NOT_FOUND", "故事不存在。");
      }
      const query = memoryListQuerySchema.safeParse(request.query);
      if (!query.success) {
        return sendError(reply, 400, "INVALID_REQUEST", "记忆筛选条件无效。");
      }
      // 列表展示前刷新分支可达性（FR-MEM-008）：切回原分支后 orphaned 记忆立即恢复。
      runtime.syncMemoryReachability(conversation.id);
      const items = runtime.listMemories(conversation.id, query.data);
      return { conversationId: conversation.id, items, total: items.length };
    },
  );

  // 记忆库（跨故事清单）：供「记忆」一级页面一次列出全部记忆。
  // 与 /api/conversations/:id/memories 的区别是不按故事过滤，且每条记忆只出现一次。
  app.get<{ Querystring: MemoryListQuery }>(
    "/api/memories",
    async (request, reply) => {
      const query = memoryListQuerySchema.safeParse(request.query);
      if (!query.success) {
        return sendError(reply, 400, "INVALID_REQUEST", "记忆筛选条件无效。");
      }
      const items = runtime.listMemoryInventory(query.data);
      return memoryInventoryResponseSchema.parse({ items, total: items.length });
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

  // 显示阶段正则（`markdownOnly` 规则）——只影响渲染，不改动已存内容。
  //
  // 为什么需要单独一条通路：`markdownOnly` 规则在酒馆语义里属于"显示"阶段，
  // 只有 `isMarkdown` 为真时才会被执行（见 tavern-regex-core 的 applies 判定）。
  // 卡普遍把整段界面放进这类规则，靠它把占位符换成真实界面；若没有显示阶段，
  // 这些规则无论启用与否都不会生效。
  //
  // 两条克制：
  //  1. 用**独立的** regexContext，且**不提交**它的宏会话——显示转换不产生任何副作用；
  //  2. 只转换调用方明确送来的内容，未送来的消息保持原样。
  app.post<{ Params: IdParams; Body: unknown }>("/api/conversations/:id/display-regex", async (request, reply) => {
    const conversation = runtime.getConversation(request.params.id);
    const character = conversation && characters.get(conversation.characterId);
    if (!conversation || !character) return sendError(reply, 404, "CONVERSATION_NOT_FOUND", "故事或角色不存在。");
    const parsed = displayRegexRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "显示转换请求无效。");
    // 独立上下文：读取当前变量用于宏求值，但不把任何变更写回。
    const regexContext = createRegexContext(character, conversation.id);
    const results: Array<{ messageId: string; text: string }> = [];
    for (const item of parsed.data.items) {
      let text = item.text;
      try {
        text = await applyRegexStage(character, "display", item.text, "assistant", undefined, false,
          pipeline.memoryShutdown.signal, regexContext);
      } catch {
        // 单条转换失败退回原文，不影响其它消息。
        text = item.text;
      }
      results.push({ messageId: item.messageId, text });
    }
    return reply.header("Cache-Control", "no-store").send(displayRegexResponseSchema.parse({ results }));
  });

  // Preview only: the editor applies the result through the shared chat bridge,
  // after extension events, and explicitly saves it just like other chat edits.
  app.get<{ Params: IdParams }>("/api/conversations/:id/greeting", async (request, reply) => {
    const conversation = runtime.getConversation(request.params.id);
    const character = conversation && characters.get(conversation.characterId);
    if (!conversation || !character) return sendError(reply, 404, "CONVERSATION_NOT_FOUND", "故事或角色不存在。");
    const regexContext = createRegexContext(character, conversation.id);
    const message = await buildCharacterGreeting(character, regexContext.extensionSettings, {
      transform: text => applyRegexStage(character, "output", text, "assistant", undefined, false, pipeline.memoryShutdown.signal, regexContext),
    });
    const latest = runtime.getConversation(request.params.id);
    if (!latest) return sendError(reply, 404, "CONVERSATION_NOT_FOUND", "故事已删除。");
    if (latest.activeBranchId !== conversation.activeBranchId) return sendError(reply, 409, "BRANCH_CHANGED", "预览期间故事分支已改变，请重新读取开场白。");
    return reply.header("Cache-Control", "no-store").send({
      characterId: character.id, branchId: latest.activeBranchId,
      tainted: Boolean(latest.chatMetadata?.tainted), message,
    });
  });
}
