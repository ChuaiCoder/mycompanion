import type { FastifyInstance } from "fastify";

import {
  activateBranchResponseSchema,
  chatMessageSchema,
  deleteMessageResponseSchema,
  editMessageRequestSchema,
  nativeGenerationRequestSchema,
  selectMessageSwipeRequestSchema,
  sendMessageRequestSchema,
  stopGenerationResponseSchema,
} from "@mycompanion/shared";

import type { CharacterRepository } from "../character/character-repository.js";
import type { GenerationPipeline } from "./generation-pipeline.js";
import { SwipeSelectionError, type RuntimeRepository } from "../persistence/runtime-repository.js";
import { sendError } from "../http-errors.js";
import type { IdParams } from "../route-types.js";

export function registerGenerationRoutes(app: FastifyInstance, runtime: RuntimeRepository, characters: CharacterRepository, pipeline: GenerationPipeline): void {
  const { applyRegexStage, createRegexContext, streamGenerationToReply, inFlightGenerations } = pipeline;

  app.post<{ Params: IdParams; Body: unknown }>(
    "/api/conversations/:id/messages",
    async (request, reply) => {
      const parsed = sendMessageRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, "INVALID_MESSAGE", "消息不能为空或过长。");
      }
      const conversation = runtime.getConversation(request.params.id);
      if (!conversation) {
        return sendError(reply, 404, "CONVERSATION_NOT_FOUND", "故事不存在。");
      }
      const character = characters.get(conversation.characterId);
      if (!character) {
        return sendError(reply, 409, "CHARACTER_NOT_FOUND", "故事关联的角色已不存在。");
      }
      // 每个对话同时只允许一个进行中的生成，避免重复提交与并发冲突。
      const existing = inFlightGenerations.get(conversation.id);
      if (existing && !existing.signal.aborted) {
        return sendError(reply, 409, "GENERATION_IN_PROGRESS", "该故事正在生成回复，请稍候或先停止。");
      }
      const controller = new AbortController();
      inFlightGenerations.set(conversation.id, controller);
      const disconnected = () => { if (!reply.raw.writableFinished) controller.abort(); };
      reply.raw.on("close", disconnected);
      try {
        const regexContext = createRegexContext(character, conversation.id);
        const content = !parsed.data.dryRun && parsed.data.content
          ? await applyRegexStage(character, "input", parsed.data.content, "user", undefined, false, controller.signal, regexContext) : "";
        controller.signal.throwIfAborted();
        const userMessage = content ? runtime.addMessage(conversation.id, "user", content) : undefined;
        const history = runtime.listMessages(conversation.id, 80);
        await streamGenerationToReply(reply, conversation.id, character, undefined, controller, userMessage, history, [],
          { ...parsed.data, regexContext });
      } finally {
        reply.raw.off("close", disconnected);
        if (inFlightGenerations.get(conversation.id) === controller) inFlightGenerations.delete(conversation.id);
      }
      return reply;
    },
  );

  // 停止进行中的生成：保留已接收文本并标记为 stopped（FR-PROV-004）。
  app.post<{ Params: IdParams }>(
    "/api/conversations/:id/generation/stop",
    async (request, reply) => {
      const conversation = runtime.getConversation(request.params.id);
      if (!conversation) {
        return sendError(reply, 404, "CONVERSATION_NOT_FOUND", "故事不存在。");
      }
      const controller = inFlightGenerations.get(conversation.id);
      if (controller && !controller.signal.aborted) {
        controller.abort();
      }
      // 最终状态仍由 SSE 的 done 事件下发；这里返回当前最后一条消息作为即时确认。
      const last = conversation.messages.at(-1);
      if (!last) {
        return sendError(reply, 404, "NO_MESSAGE", "故事中没有消息可以停止。");
      }
      return stopGenerationResponseSchema.parse({ message: last });
    },
  );

  // 重新生成最后一条助手回复：在最后一个用户消息处分叉出新分支（FR-CHAT-003）。
  // 返回新分支 ID 与锚点；客户端随后调用 POST messages 以 SSE 重新生成。
  app.post<{ Params: IdParams; Body: unknown }>(
    "/api/conversations/:id/messages/regenerate",
    async (request, reply) => {
      const parsed = nativeGenerationRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "扩展提示词格式无效。");
      const conversation = runtime.getConversation(request.params.id);
      if (!conversation) {
        return sendError(reply, 404, "CONVERSATION_NOT_FOUND", "故事不存在。");
      }
      const last = conversation.messages.at(-1);
      if (!last || last.role !== "assistant") {
        return sendError(reply, 409, "NOTHING_TO_REGENERATE", "最后一条消息不是助手回复，无需重新生成。");
      }
      const character = characters.get(conversation.characterId);
      if (!character) {
        return sendError(reply, 409, "CHARACTER_NOT_FOUND", "故事关联的角色已不存在。");
      }
      const existing = inFlightGenerations.get(conversation.id);
      if (existing && !existing.signal.aborted) return sendError(reply, 409, "GENERATION_IN_PROGRESS", "该故事正在生成回复，请稍候或先停止。");
      const controller = new AbortController();
      inFlightGenerations.set(conversation.id, controller);
      // Do not create a branch or placeholder for a preview/cancelled preflight.
      const history = conversation.messages.slice(0, -1).slice(-80);
      await streamGenerationToReply(reply, conversation.id, character, undefined, controller, undefined, history, [], {
        ...parsed.data,
        prepareAssistant: () => {
          if (!runtime.prepareRegenerateLastAssistant(conversation.id)) throw new Error("没有可重新生成的助手回复。");
          return runtime.createAssistantMessage(conversation.id);
        },
      });
      return reply;
    },
  );

  // 编辑一条消息（FR-CHAT-002）。
  for (const mode of ["continue", "impersonate"] as const) {
    app.post<{ Params: IdParams; Body: unknown }>(`/api/conversations/:id/messages/${mode}`, async (request, reply) => {
      const parsed = nativeGenerationRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "生成参数无效。");
      const conversation = runtime.getConversation(request.params.id);
      if (!conversation) return sendError(reply, 404, "CONVERSATION_NOT_FOUND", "故事不存在。");
      const character = characters.get(conversation.characterId);
      if (!character) return sendError(reply, 409, "CHARACTER_NOT_FOUND", "故事关联的角色已不存在。");
      const last = conversation.messages.at(-1);
      if (mode === "continue" && (!last || last.role !== "assistant" || last.status === "streaming")) {
        return sendError(reply, 409, "NOTHING_TO_CONTINUE", "最后一条消息不是可续写的角色回复。");
      }
      const existing = inFlightGenerations.get(conversation.id);
      if (existing && !existing.signal.aborted) return sendError(reply, 409, "GENERATION_IN_PROGRESS", "该故事正在生成回复，请稍候或先停止。");
      const controller = new AbortController(); inFlightGenerations.set(conversation.id, controller);
      await streamGenerationToReply(reply, conversation.id, character, undefined, controller, undefined,
        conversation.messages.slice(-80), [], { ...parsed.data, generationType: mode,
          ...(mode === "continue" ? { continueFrom: last!, prepareAssistant: () => runtime.prepareContinueMessage(conversation.id, last!) } : { ephemeral: true }) });
      return reply;
    });
  }

  // 编辑一条消息（FR-CHAT-002）。
  app.patch<{ Params: { id: string; messageId: string }; Body: unknown }>(
    "/api/conversations/:id/messages/:messageId",
    async (request, reply) => {
      const parsed = editMessageRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, "INVALID_MESSAGE", "消息不能为空或过长。");
      }
      const conversation = runtime.getConversation(request.params.id);
      if (!conversation) {
        return sendError(reply, 404, "CONVERSATION_NOT_FOUND", "故事不存在。");
      }
      const original = conversation.messages.find(message => message.id === request.params.messageId);
      if (!original) return sendError(reply, 404, "MESSAGE_NOT_FOUND", "要编辑的消息不存在或不在当前分支。");
      inFlightGenerations.get(conversation.id)?.abort();
      const character = characters.get(conversation.characterId);
      const regexContext = character ? createRegexContext(character, conversation.id) : undefined;
      const content = original && character ? await applyRegexStage(character, original.role === "user" ? "input" : "output", parsed.data.content,
        original.role, undefined, true, pipeline.memoryShutdown.signal, regexContext) : parsed.data.content;
      if (runtime.getConversation(conversation.id)?.activeBranchId !== conversation.activeBranchId) {
        return sendError(reply, 409, "BRANCH_CHANGED", "编辑期间故事分支已改变，请重新打开消息。");
      }
      const edited = runtime.withTransaction(() => {
        const result = runtime.editMessage(request.params.id, request.params.messageId, content);
        if (result && regexContext) runtime.commitMacroVariables(conversation.id, regexContext.macroSession.changes());
        return result;
      });
      if (!edited) {
        return sendError(reply, 404, "MESSAGE_NOT_FOUND", "要编辑的消息不存在或不在当前分支。");
      }
      return edited;
    },
  );

  // 选择候选回复（FR-CHAT）：swipe_id/内容/扩展数据由仓储层原子更新。
  app.post<{ Params: { id: string; messageId: string }; Body: unknown }>(
    "/api/conversations/:id/messages/:messageId/swipe",
    async (request, reply) => {
      const parsed = selectMessageSwipeRequestSchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "候选回复序号无效。");
      const conversation = runtime.getConversation(request.params.id);
      if (!conversation) return sendError(reply, 404, "CONVERSATION_NOT_FOUND", "故事不存在。");
      const message = conversation.messages.find(item => item.id === request.params.messageId);
      if (!message) return sendError(reply, 404, "MESSAGE_NOT_FOUND", "要切换的消息不存在或不在当前分支。");
      inFlightGenerations.get(conversation.id)?.abort();
      try {
        return chatMessageSchema.parse(runtime.selectMessageSwipe(conversation.id, message, parsed.data.swipeId));
      } catch (error) {
        if (error instanceof SwipeSelectionError) return sendError(reply, 409, "SWIPE_NOT_AVAILABLE", error.message);
        throw error;
      }
    },
  );

  // 删除一条消息（FR-CHAT-002）。
  app.delete<{ Params: { id: string; messageId: string }; Reply: unknown }>(
    "/api/conversations/:id/messages/:messageId",
    async (request, reply) => {
      const conversation = runtime.getConversation(request.params.id);
      if (!conversation) {
        return sendError(reply, 404, "CONVERSATION_NOT_FOUND", "故事不存在。");
      }
      inFlightGenerations.get(conversation.id)?.abort();
      const deleted = runtime.deleteMessage(request.params.id, request.params.messageId);
      if (!deleted) {
        return sendError(reply, 404, "MESSAGE_NOT_FOUND", "要删除的消息不存在或不在当前分支。");
      }
      // 删除来源消息后同步记忆可达性（FR-MEM-008）。
      runtime.syncMemoryReachability(request.params.id);
      const updated = runtime.getConversation(request.params.id);
      if (!updated) {
        return sendError(reply, 500, "CONVERSATION_NOT_FOUND", "故事不存在。");
      }
      return deleteMessageResponseSchema.parse({ conversation: updated });
    },
  );

  // 切换分支（FR-CHAT-003）。
  app.post<{ Params: { id: string; branchId: string }; Body: unknown }>(
    "/api/conversations/:id/branches/:branchId/activate",
    async (request, reply) => {
      inFlightGenerations.get(request.params.id)?.abort();
      const conversation = runtime.activateBranch(request.params.id, request.params.branchId);
      if (conversation) {
        // 切分支后同步记忆可达性（FR-MEM-008）：orphaned 恢复 / active 转 orphaned。
        runtime.syncMemoryReachability(conversation.id);
      }
      if (!conversation) {
        return sendError(reply, 404, "BRANCH_NOT_FOUND", "分支不存在或没有消息。");
      }
      return activateBranchResponseSchema.parse({ conversation });
    },
  );
}
