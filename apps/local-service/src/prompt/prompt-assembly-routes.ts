import type { FastifyInstance } from "fastify";

import {
  promptPreviewRequestSchema,
  promptPreviewResponseSchema,
  type CharacterDetail,
  type ChatMessage,
  type MemoryRetrievalReport,
} from "@mycompanion/shared";

import type { CharacterRepository } from "./character-repository.js";
import type { GenerationPipeline } from "./generation-pipeline.js";
import { buildPromptPreview } from "./model-client.js";
import type { RuntimeRepository } from "./runtime-repository.js";
import { sendError } from "./http-errors.js";
import type { IdParams, SecretCodec } from "./route-types.js";
import { worldInfoOutletsFromPrompts } from "./world-info-activation.js";

export function registerPromptAssemblyRoutes(app: FastifyInstance, runtime: RuntimeRepository, characters: CharacterRepository, pipeline: GenerationPipeline, secretCodec?: SecretCodec): void {
  const { applyRegexStage, buildLorebookReport, memoryShutdown, createRegexContext, retrieveMemory, snapshotKey } = pipeline;

  // 提示词预览（FR-PROMPT-004）：发送前查看即将发给模型的提示词。
  // 组装与预算和真实生成完全一致（含世界书/记忆/摘要/正则阶段），
  // 凭据与内部敏感字段脱敏，并给出每个区域的 token 估算。
  app.post<{ Params: IdParams; Body: unknown }>(
    "/api/conversations/:id/prompt-preview",
    async (request, reply) => {
      const conversation = runtime.getConversation(request.params.id);
      if (!conversation) {
        return sendError(reply, 404, "CONVERSATION_NOT_FOUND", "故事不存在。");
      }
      const character = characters.get(conversation.characterId);
      if (!character) {
        return sendError(reply, 409, "CHARACTER_NOT_FOUND", "故事关联的角色已不存在。");
      }
      const parsed = promptPreviewRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, "INVALID_REQUEST", "预览草稿无效或过长。");
      }
      const regexContext = createRegexContext(character, conversation.id);
      const macroSession = regexContext.macroSession;
      macroSession.bindWorldInfoOutlets(worldInfoOutletsFromPrompts(parsed.data.extensionPrompts ?? []));
      const rawHistory = runtime.listMessages(conversation.id, 80);
      runtime.syncMemoryReachability(conversation.id);
      const memories = runtime.listMemories(conversation.id);
      const draftId = crypto.randomUUID(), draftCreatedAt = new Date().toISOString();
      // Macro evaluation replays this closure; an unchanged query must not
      // charge the embedding provider twice or share a mutable budget report.
      const memoryQueries = new Map<string, Promise<MemoryRetrievalReport>>();
      const previewSignal = memoryShutdown.signal;
      // 草稿作为“当前用户输入”参与组装；与真实发送一致：先 input 阶段改写，
      // 再对全部用户消息应用 prompt 阶段（只改发给模型的副本）。
      const draft = parsed.data.draft?.trim();
      const fullHistory: ChatMessage[] = draft
        ? [...rawHistory, {
            id: draftId,
            conversationId: conversation.id,
            branchId: conversation.activeBranchId,
            parentMessageId: rawHistory.at(-1)?.id ?? null,
            role: "user",
            content: await applyRegexStage(character, "input", draft, "user", undefined, false, previewSignal, regexContext),
            status: "complete",
            createdAt: draftCreatedAt,
          }]
        : rawHistory;
      const history: ChatMessage[] = [];
      for (const [index, message] of fullHistory.entries()) {
        history.push({ ...message, content: await applyRegexStage(character, "prompt", message.content, message.role, fullHistory.length - index - 1,
          false, previewSignal, regexContext) });
      }
      // 世界书/记忆基于已保存原文 + 草稿（与真实发送时一致）。
      const lorebook = await buildLorebookReport(character, fullHistory, conversation.id, parsed.data.extensionPrompts, draft ? 1 : 0, false,
        regexContext.settings, macroSession, { regexContext, signal: previewSignal, dryRun: true, trigger: "normal",
          worldInfoSourceMessages: draft ? [...conversation.messages, fullHistory.at(-1)!] : conversation.messages,
          worldInfoBranchId: conversation.activeBranchId });
      const scanText = fullHistory.map((message) => message.content).join("\n");
      const semanticQuery = [...fullHistory].reverse().find(message => message.role === "user")?.content ?? fullHistory.at(-1)?.content ?? "";
      const queryKey = JSON.stringify([scanText, semanticQuery]);
      if (!memoryQueries.has(queryKey)) memoryQueries.set(queryKey, retrieveMemory({
        conversationId: conversation.id,
        memories,
        model: regexContext.settings.model,
        scanText, semanticQuery, signal: previewSignal, dryRun: true,
        embeddingSelection: regexContext.embeddingSelection,
        embeddingSelectionUnavailable: regexContext.embeddingSelectionUnavailable,
      }));
      const memory = structuredClone(await memoryQueries.get(queryKey)!);
      const summary = runtime.getSummary(conversation.id);
      const apiKey = snapshotKey(regexContext);
      return promptPreviewResponseSchema.parse(buildPromptPreview({
        macroSession,
        ...(parsed.data.extensionPrompts ? { extensionPrompts: parsed.data.extensionPrompts } : {}),
        chatMetadata: regexContext.metadata,
        extensionSettings: regexContext.extensionSettings,
        userTurnCount: conversation.messages.filter(message => message.role === "user").length + (draft ? 1 : 0),
        settings: regexContext.settings,
        character,
        plugins: runtime.activePlugins(),
        lorebook,
        memory,
        ...(summary?.valid === true ? { stageSummary: summary.content } : {}),
        history,
        ...(apiKey ? { apiKey } : {}),
      }));
    },
  );
}
