import type { FastifyInstance } from "fastify";

import {
  extensionPromptAssemblyRequestSchema,
  promptPreviewRequestSchema,
  promptPreviewResponseSchema,
  quietGenerationRequestSchema,
  type ApiErrorResponse,
  type CharacterDetail,
  type ChatMessage,
  type LorebookReport,
  type GenerationSseEvent,
  type NativeCompletionRequest,
} from "@mycompanion/shared";

import type { CharacterRepository } from "./character-repository.js";
import { convertedExamplesMatchCard } from "./character-routes.js";
import type { GenerationPipeline } from "./generation-pipeline.js";
import { retrieveMemories } from "./memory-engine.js";
import {
  assembleModelPrompt,
  buildPromptPreview,
  characterWithChatOverrides,
  ModelRequestError,
  streamReply,
} from "./model-client.js";
import type { RuntimeRepository } from "./runtime-repository.js";
import { countTextTokens } from "./tokenizer-service.js";
import { sendError } from "./http-errors.js";
import type { IdParams, SecretCodec } from "./route-types.js";
import { normalizeStructuredOutput } from "./structured-output.js";
import { MacroEvaluationSession } from "./prompt-macros.js";
import { MacroVariableConflictError } from "./macro-variable-conflict.js";
import { bindCharacterMacroEnvironment } from "./character-macros.js";
import { completeMacroApi, runMacroBoundary } from "./macro-boundary.js";
import { commitWorldInfoEffects, getCommittedWorldInfoState } from "./world-info-effects.js";

export function registerPromptAssemblyRoutes(app: FastifyInstance, runtime: RuntimeRepository, characters: CharacterRepository, pipeline: GenerationPipeline, secretCodec?: SecretCodec): void {
  const { applyRegexStage, buildLorebookReport, memoryShutdown, preflight, macroRpc, createRegexContext } = pipeline;

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
      const rawHistory = runtime.listMessages(conversation.id, 80);
      runtime.syncMemoryReachability(conversation.id);
      const memories = runtime.listMemories(conversation.id);
      const draftId = crypto.randomUUID(), draftCreatedAt = new Date().toISOString();
      return completeMacroApi(app, reply, { conversationId: conversation.id, branchId: conversation.activeBranchId }, macroSession, parsed.data.browserMacros, async browserSignal => {
      const previewSignal = browserSignal ? AbortSignal.any([browserSignal, memoryShutdown.signal]) : memoryShutdown.signal;
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
      const memory = retrieveMemories({
        conversationId: conversation.id,
        memories,
        model: runtime.getProvider().model,
        scanText: fullHistory.map((message) => message.content).join("\n"),
      });
      const summary = runtime.getSummary(conversation.id);
      const encrypted = runtime.getEncryptedApiKey();
      const apiKey = encrypted ? secretCodec?.unseal(encrypted) : undefined;
      return promptPreviewResponseSchema.parse(buildPromptPreview({
        macroSession,
        ...(parsed.data.extensionPrompts ? { extensionPrompts: parsed.data.extensionPrompts } : {}),
        chatMetadata: regexContext.metadata,
        extensionSettings: regexContext.extensionSettings,
        userTurnCount: conversation.messages.filter(message => message.role === "user").length + (draft ? 1 : 0),
        settings: regexContext.settings,
        character,
        plugins: [
          ...runtime.activePlugins(),
          ...runtime.activeCodePluginsAsInstalled(),
        ],
        lorebook,
        memory,
        ...(summary?.valid === true ? { stageSummary: summary.content } : {}),
        history,
        ...(apiKey ? { apiKey } : {}),
      }));
      });
    },
  );

  // The extension assembly path uses the same unredacted assembler as native
  // generation. The user-facing prompt preview above deliberately redacts text.
  app.post<{ Params: IdParams; Body: unknown }>("/api/conversations/:id/extension-prompt-assembly",
    { bodyLimit: 8 * 1024 * 1024 }, async (request, reply) => {
    const parsed = extensionPromptAssemblyRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: { code: "INVALID_EXTENSION_PROMPT",
      message: "扩展提示词参数无效。", details: parsed.error.issues.map(issue => issue.message) } });
    const data = parsed.data;
    const extensionPrompts = [...data.extensionPrompts];
    if (!["normal", "quiet", "regenerate", "swipe", "impersonate"].includes(data.type)) return sendError(reply, 422, "UNSUPPORTED_GENERATION_MODE", `提示词组装尚不支持生成模式：${data.type}`);
    const allMessages = [...data.messages, ...data.messageExamples.flat()];
    if (allMessages.some(message => message.image != null || message.tool_calls != null ||
      (typeof message.reasoning === "string" ? message.reasoning.trim().length > 0 : message.reasoning != null) ||
      message.signature != null || (Array.isArray(message.media) && message.media.length > 0) ||
      (Array.isArray(message.invocations) && message.invocations.length > 0))) {
      return sendError(reply, 422, "UNSUPPORTED_PROMPT_MEDIA", "当前提示词组装尚不支持图片、工具调用或推理签名；请求未发送到模型。");
    }
    const conversation = runtime.getConversation(request.params.id);
    if (!conversation) return sendError(reply, 404, "CONVERSATION_NOT_FOUND", "故事不存在。");
    const storedCharacter = characters.get(conversation.characterId);
    if (!storedCharacter) return sendError(reply, 409, "CHARACTER_NOT_FOUND", "故事关联的角色已不存在。");
    const baseCharacter = characterWithChatOverrides(storedCharacter, conversation.chatMetadata ?? {});
    const character: CharacterDetail = { ...baseCharacter,
      name: data.name2 ?? storedCharacter.name,
      description: data.charDescription ?? baseCharacter.description,
      personality: data.charPersonality ?? baseCharacter.personality,
      scenario: data.scenario ?? data.Scenario ?? baseCharacter.scenario,
      systemPrompt: data.systemPromptOverride ?? baseCharacter.systemPrompt,
      postHistoryInstructions: data.jailbreakPromptOverride ?? baseCharacter.postHistoryInstructions,
      // An empty outer array means the extension intentionally omitted examples.
      // A non-empty array of empty converted blocks means its parser could not
      // represent the card's examples (for example a full-width name separator).
      // Keep the original card text in that case instead of silently dropping it.
      exampleDialogue: data.messageExamples.length === 0 ? ""
        : data.messageExamples.every(block => block.length === 0) ? baseCharacter.exampleDialogue
        : convertedExamplesMatchCard(baseCharacter.exampleDialogue, baseCharacter.name, data.messageExamples)
          ? baseCharacter.exampleDialogue
        : data.messageExamples.map(block => block.map(message => `${message.name ?? message.role}: ${message.content}`).join("\n")).join("\n\n"),
    };
    const now = new Date().toISOString();
    const history: ChatMessage[] = data.messages.toReversed().map((message, index) => ({
      id: crypto.randomUUID(), conversationId: conversation.id, branchId: conversation.activeBranchId,
      parentMessageId: null, role: message.role === "system" ? "assistant" : message.role,
      content: message.content, status: "complete", createdAt: now,
      extensionData: { ...(message.role === "system" ? { modelRole: "system" } : {}),
        ...(message.name ? { modelName: message.name } : {}) },
    }));
    const provider = runtime.getProvider();
    const settings = { ...provider,
      contextLimitTokens: data.contextLimitTokens ?? provider.contextLimitTokens,
      maxTokens: data.maxTokens ?? provider.maxTokens };
    const macroSession = new MacroEvaluationSession(conversation.chatMetadata,runtime.getExtensionSettings());
    bindCharacterMacroEnvironment(baseCharacter, conversation.chatMetadata ?? {}, runtime.getExtensionSettings(), settings, macroSession);
    // Like prepareOpenAIMessages, assembly consumes supplied WI. Scanning is a
    // separate public operation; omitted/null strings do not request a scan.
    const lorebook: LorebookReport = (() => {
      const texts = [data.worldInfoBefore ?? "", data.worldInfoAfter ?? ""];
      const results = texts.flatMap((content, index) => content.trim() ? [{
        index, name: index === 0 ? "扩展·角色前世界书" : "扩展·角色后世界书",
        status: "injected" as const, matchedKey: null, tokens: countTextTokens(content, settings.model),
        diagnostics: [], content, position: index, insertionOrder: index,
      }] : []);
      return { characterId: character.id, results, block: texts.filter(Boolean).join("\n\n"),
        constantBlock: "", position: "after_character_core", budgetTokens: settings.contextLimitTokens,
        injectedCount: results.length, durationMs: 0 };
    })();
    runtime.syncMemoryReachability(conversation.id);
    const memory = retrieveMemories({ conversationId: conversation.id, memories: runtime.listMemories(conversation.id),
      model: runtime.getProvider().model, scanText: history.map(message => message.content).join("\n") });
    const summary = runtime.getSummary(conversation.id);
    const recentSaved = conversation.messages.at(-1);
    const latestInput = data.messages[0];
    const pendingTurn = latestInput?.role === "user" && latestInput.content !== recentSaved?.content ? 1 : 0;
    return completeMacroApi(app, reply, { conversationId: conversation.id, branchId: conversation.activeBranchId }, macroSession, data.browserMacros, () => {
    const { messages, budget } = assembleModelPrompt({ settings, character, history, lorebook, memory,
      macroSession,
      prepareNativeCharacterFields: false,
      generationType: data.type,
      ...(data.quietPrompt === undefined ? {} : { quietPrompt: data.quietPrompt }),
      ...(data.bias === undefined ? {} : { bias: data.bias }),
      messageExamples: data.messageExamples.map(block => block.map(message => ({ role: message.role, content: message.content,
        ...(message.name ? { name: message.name } : {}) }))),
      characterOverridesResolved: true,
      extensionPrompts,
      extensionSettings: runtime.getExtensionSettings(), chatMetadata: conversation.chatMetadata ?? {},
      userTurnCount: conversation.messages.filter(message => message.role === "user").length + pendingTurn,
      plugins: [...runtime.activePlugins(), ...runtime.activeCodePluginsAsInstalled()],
      ...(summary?.valid === true ? { stageSummary: summary.content } : {}),
      ...(data.personaDescription !== undefined ? { personaDescriptionOverride: data.personaDescription } : {}),
    });
    if (budget.totalTokens > budget.contextLimitTokens && data.browserMacros) throw new ModelRequestError("固定提示词与当前输入超出上下文上限。", 400);
    if (budget.totalTokens > budget.contextLimitTokens) return reply.status(400).send({ error: {
      code: "PROMPT_CONTEXT_EXCEEDED", message: "固定提示词与当前输入超出上下文上限。",
      details: budget.diagnostics } });
    const macroChanges = macroSession.changes();
    if(data.commitVariables){
      try{runtime.commitMacroVariables(conversation.id,macroChanges);}
      catch(error){
        if(data.browserMacros)throw error;
        if(error instanceof MacroVariableConflictError)return sendError(reply,409,"MACRO_VARIABLE_CONFLICT",error.message);
        throw error;
      }
    }
    reply.header("Cache-Control", "no-store");
    return { messages, totalTokens: budget.totalTokens,
      ...(data.commitVariables ? {macroChanges} : {}),
      contextLimitTokens: budget.contextLimitTokens, diagnostics: budget.diagnostics,
      regions: budget.regions.map(region => ({ key: region.key, label: region.label, tokens: region.tokens })) };
    });
  });

  // Quiet generation shares the native prompt/regex/budget pipeline but never
  // creates a message or starts memory extraction. Explicit macro variable
  // effects commit only for an accepted non-preview request.
  app.post<{ Params: IdParams; Body: unknown }>("/api/conversations/:id/quiet-generation", async (request, reply) => {
    const parsed = quietGenerationRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "后台生成参数无效。");
    const input = parsed.data;
    if (input.quietImage || input.forceChId !== null) {
      return sendError(reply, 422, "UNSUPPORTED_QUIET_OPTION", "当前后台生成尚不支持图片或群组强制角色。");
    }
    const conversation = runtime.getConversation(request.params.id);
    if (!conversation) return sendError(reply, 404, "CONVERSATION_NOT_FOUND", "故事不存在。");
    const character = characters.get(conversation.characterId);
    if (!character) return sendError(reply, 409, "CHARACTER_NOT_FOUND", "故事关联的角色已不存在。");
    const controller = new AbortController();
    request.raw.once("aborted", () => controller.abort());
    reply.raw.once("close", () => controller.abort());
    const signal = AbortSignal.any([controller.signal, memoryShutdown.signal]);
    const streamed = input.browserPreflight || input.browserMacros;
    const send = (event: GenerationSseEvent) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    if (streamed) {
      reply.hijack();
      reply.raw.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
    }
    const failure = (status: number, code: string, message: string) => {
      if (!streamed) return sendError(reply, status, code, message);
      if (!signal.aborted) send({ type: "error", message });
      send({ type: "generation_end", reason: "stopped" });
      return reply;
    };
    let prepared: NativeCompletionRequest | undefined;
    try {
      const regexContext = createRegexContext(character, conversation.id);
      const macroSession = regexContext.macroSession;
      const resolver = macroRpc(signal, (requestId, call) => send({ type: "macro_request", requestId, conversationId: conversation.id,
        branchId: conversation.activeBranchId, evaluation: { ...call } }));
      const phase = <T>(work: () => T | Promise<T>): Promise<T> => input.browserMacros ? runMacroBoundary(macroSession, signal, resolver, work) : Promise.resolve().then(work);
      const rawHistory = runtime.listMessages(conversation.id, 80);
      const history: ChatMessage[] = [];
      for (const [index, message] of rawHistory.entries()) {
        history.push({ ...message, content: await phase(() => applyRegexStage(character, "prompt", message.content, message.role,
          rawHistory.length - index - 1, false, signal, regexContext)) });
      }
      const quietPrompt = input.quietPrompt.trim();
      const extensionPrompts = [...input.extensionPrompts];
      const provider = regexContext.settings;
      const settings = input.responseLength ? { ...provider, maxTokens: input.responseLength } : provider;
      const lorebook: LorebookReport = input.skipWIAN
        ? { characterId: character.id, results: [], block: "", constantBlock: "", position: "after_character_core",
            budgetTokens: 0, injectedCount: 0, durationMs: 0 }
        : await phase(() => buildLorebookReport(character, rawHistory, conversation.id, extensionPrompts, 0, false, settings, macroSession,
          { regexContext, signal, dryRun: input.dryRun, trigger: "quiet", worldInfoSourceMessages: conversation.messages,
            worldInfoBranchId: conversation.activeBranchId }));
      const memory = retrieveMemories({ conversationId: conversation.id, memories: runtime.listMemories(conversation.id),
        model: runtime.getProvider().model, scanText: rawHistory.map(message => message.content).join("\n") });
      const summary = runtime.getSummary(conversation.id);
      const encrypted = runtime.getEncryptedApiKey();
      const apiKey = encrypted ? secretCodec?.unseal(encrypted) : undefined;
      let text = await streamReply({ settings, generationType: "quiet", quietPrompt,
        ...(input.browserMacros ? { preparePrompt: phase } : {}),
        macroSession,
        onReady: () => {
          signal.throwIfAborted();
          const changes=macroSession.changes();
          runtime.withTransaction(() => {
            runtime.commitMacroVariables(conversation.id,changes);
            commitWorldInfoEffects(runtime, conversation.id, conversation.activeBranchId, lorebook);
          });
          macroSession.checkpointChanges();
          const worldInfoState=getCommittedWorldInfoState(runtime,conversation.id,lorebook);
          if(streamed&&(changes.length||worldInfoState))send({type:"macro_variables",conversationId:conversation.id,
            branchId:conversation.activeBranchId,changes,...(worldInfoState?{worldInfoState}:{})});
        },
        dryRun: input.dryRun, skipAuthorNote: input.skipWIAN, preserveOutput: input.jsonSchema !== null,
        onRequest: async (request, requestSignal) => {
          const initial = { ...request, ...(input.jsonSchema ? { json_schema: input.jsonSchema } : {}) };
          prepared = input.browserPreflight ? await preflight(requestSignal, requestId => send({ type: "completion_request", requestId, request: initial, dryRun: input.dryRun })) : initial;
          return prepared;
        },
        onBudget: budget => { if (streamed) send({type:"prompt_budget",report:{
          contextLimitTokens:budget.contextLimitTokens,reserveTokens:budget.reserveTokens,availableTokens:budget.availableTokens,
          regions:budget.regions,recentMessageCount:budget.recentMessages.length,diagnostics:budget.diagnostics,totalTokens:budget.totalTokens,
        }}); }, ...(apiKey ? { apiKey } : {}), character, history,
        chatMetadata: regexContext.metadata, extensionSettings: regexContext.extensionSettings,
        userTurnCount: conversation.messages.filter(message => message.role === "user").length,
        plugins: [...runtime.activePlugins(), ...runtime.activeCodePluginsAsInstalled()], lorebook, memory,
        extensionPrompts, ...(summary?.valid === true ? { stageSummary: summary.content } : {}), signal, onDelta: () => {} });
      if (signal.aborted) return failure(499, "GENERATION_CANCELLED", "后台生成已取消。");
      if (input.dryRun) {
        if (streamed) { send({ type: "generation_end", reason: "preview" }); return reply; }
        return reply.header("Cache-Control", "no-store").send({ text: "", messages: prepared?.messages });
      }
      text = input.jsonSchema ? normalizeStructuredOutput(text, input.jsonSchema.returnInvalid === true)
        : await phase(() => applyRegexStage(character, "output", text, "assistant", undefined, false, signal, regexContext));
      const outputChanges = macroSession.changes();
      runtime.commitMacroVariables(conversation.id, outputChanges); macroSession.checkpointChanges();
      if (streamed && outputChanges.length) send({ type: "macro_variables", conversationId: conversation.id, changes: outputChanges });
      if (streamed) { send({ type: "quiet_result", text }); return reply; }
      return reply.header("Cache-Control", "no-store").send({ text });
    } catch (error) {
      if (signal.aborted) return failure(499, "GENERATION_CANCELLED", "后台生成已取消。");
      if (error instanceof MacroVariableConflictError) return failure(409, "MACRO_VARIABLE_CONFLICT", error.message);
      const known = error instanceof ModelRequestError;
      return failure(known ? error.statusCode : 502,
        known ? "MODEL_REQUEST_FAILED" : "QUIET_GENERATION_FAILED",
        known ? error.message : "后台生成失败。");
    } finally { if (streamed) reply.raw.end(); }
  });
}
