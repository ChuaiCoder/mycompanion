import { createGenerationPreflight } from "./generation-preflight.js";
import type { FastifyInstance, FastifyReply } from "fastify";

import type {
  CharacterDetail,
  ChatMessage,
  ExtensionPrompt,
  GenerationSseEvent,
  LorebookReport,
  MessageGenerationMetadata,
  NativeCompletionRequest,
  ProviderSettings,
} from "@mycompanion/shared";

import type { CharacterRepository } from "./character-repository.js";
import {
  characterWithChatOverrides,
  completeText,
  ModelRequestError,
  streamReply,
} from "./model-client.js";
import { extractMemories, summarizeMessages } from "./memory-extractor.js";
import { reconcileMemoryReport, retrieveMemories } from "./memory-engine.js";
import type { RuntimeRepository } from "./runtime-repository.js";
import { collectNativeRegexScripts, TavernRegexExecutor } from "./tavern-regex-service.js";
import { buildWorldInfoReport, finalizeWorldInfoRegex } from "./world-info-service.js";
import { commitWorldInfoEffects, getCommittedWorldInfoState } from "./world-info-effects.js";
import { buildAuthorNotePrompt } from "./author-note-core.js";
import { getPersonaUserName } from "./power-user-core.js";
import { MacroEvaluationSession } from "./prompt-macros.js";
import { MacroVariableConflictError } from "./macro-variable-conflict.js";
import { bindCharacterMacroEnvironment, buildCharacterDepthPrompt, prepareCharacterMacroFields } from "./character-macros.js";
import type { SecretCodec } from "./route-types.js";
import { createMacroBoundaryRpc, runMacroBoundary } from "./macro-boundary.js";

export interface GenerationPipelineDeps {
  runtime: RuntimeRepository;
  characters: CharacterRepository;
  secretCodec?: SecretCodec | undefined;
}

export interface NativeRegexContext {
  macroSession: MacroEvaluationSession;
  metadata: Record<string, unknown>;
  extensionSettings: Record<string, unknown>;
  settings: ProviderSettings;
  macroContext: Parameters<MacroEvaluationSession["evaluate"]>[1];
}

// The generation pipeline bundles the closures that native generation, prompt
// preview, quiet generation and the regex routes all share. It owns its own
// lifecycle hooks (registered on the given app) exactly like the inline
// version did: regex executor close, preClose shutdown, memory job drain.
export function createGenerationPipeline(app: FastifyInstance, deps: GenerationPipelineDeps) {
  const { runtime, characters, secretCodec } = deps;
  const preflight = createGenerationPreflight(app);
  const macroRpc = createMacroBoundaryRpc(app);

  // 每个对话同时最多一个进行中的流式生成；用于“停止”时中止请求。
  const inFlightGenerations = new Map<string, AbortController>();
  const memoryJobs = new Set<Promise<void>>();
  const memoryShutdown = new AbortController();
  let isClosing = false;
  const regexExecutor = new TavernRegexExecutor();
  app.addHook("onClose", async () => regexExecutor.close());
  const allowNativeCharacterRegex = (id: string): void => {
    const settings = runtime.getExtensionSettings(), character = characters.get(id);
    const allowed = settings.character_allowed_regex;
    const avatar = character?.avatar ?? `${id}.png`;
    if (character && Array.isArray(allowed) && !allowed.includes(avatar)) {
      allowed.push(avatar); runtime.saveExtensionSettings(settings);
    }
  };

  const createRegexContext = (character: CharacterDetail, conversationId?: string): NativeRegexContext => {
    const metadata = conversationId ? runtime.getConversation(conversationId)?.chatMetadata ?? {} : {};
    const extensionSettings = runtime.getExtensionSettings(), settings = runtime.getProvider();
    const macroSession = new MacroEvaluationSession(metadata, extensionSettings);
    const { context: macroContext } = bindCharacterMacroEnvironment(characterWithChatOverrides(character, metadata),
      metadata, extensionSettings, settings, macroSession);
    return { macroSession, metadata, extensionSettings, settings, macroContext };
  };

  // Regex matching stays in a cancellable worker. The caller's request session
  // evaluates only the find/trim/replacement macros that actually execute.
  const applyRegexStage = async (
    character: CharacterDetail,
    stage: "input" | "prompt" | "output" | "display",
    text: string,
    role: "user" | "assistant" = "user",
    depth?: number,
    isEdit = false,
    signal: AbortSignal = memoryShutdown.signal,
    regexContext = createRegexContext(character),
  ): Promise<string> => {
    return regexExecutor.run(text, stage === "input" ? 1 : stage === "output" ? 2 : role === "user" ? 1 : 2,
      collectNativeRegexScripts(regexContext.extensionSettings, character), character.name,
      {isPrompt:stage === "prompt",isMarkdown:stage === "display",isEdit,...(depth === undefined ? {} : {depth}),
        substitute: (value, escape, characterOverride) => regexContext.macroSession.evaluate(value, { ...regexContext.macroContext,
          ...(characterOverride === undefined ? {} : { characterName: characterOverride }),
          ...(escape === undefined ? {} : { postProcessFn: escape }) }) }, signal, regexContext.macroContext.userName);
  };

  // 对当前上下文做一次世界书匹配（FR-LORE-002/003）：
  // 只扫描已保存/待发送消息的副本，不修改聊天；报告通过 SSE 下发供高级模式查看。
  const buildLorebookReport = async (
    character: CharacterDetail,
    messages: ChatMessage[],
    conversationId: string,
    extensionPrompts: ExtensionPrompt[] = [],
    pendingUserTurns = 0,
    characterOverridesResolved = false,
    settings = runtime.getProvider(),
    macroSession?: MacroEvaluationSession,
    options: { prepareNativeCharacterFields?: boolean; signal?: AbortSignal; regexContext?: NativeRegexContext;
      dryRun?: boolean; trigger?: string; worldInfoSourceMessages?: ChatMessage[]; worldInfoBranchId?: string } = {},
  ): Promise<LorebookReport> => {
    const conversation = runtime.getConversation(conversationId);
    const metadata = options.regexContext?.metadata ?? conversation?.chatMetadata ?? {};
    const promptCharacter = characterOverridesResolved ? character
      : characterWithChatOverrides(character, metadata);
    const extensionSettings = options.regexContext?.extensionSettings ?? runtime.getExtensionSettings();
    const session = macroSession ?? new MacroEvaluationSession(metadata, extensionSettings);
    bindCharacterMacroEnvironment(promptCharacter, metadata, extensionSettings, settings, session);
    const fields = options.prepareNativeCharacterFields !== false
      ? prepareCharacterMacroFields(promptCharacter, metadata, extensionSettings, settings, session) : undefined;
    const note = buildAuthorNotePrompt(metadata, runtime.getExtensionSettings(),
      (conversation?.messages.filter(message => message.role === "user").length ?? 0) + pendingUserTurns).prompt;
    const prompts = [...extensionPrompts];
    if (note && !prompts.some(prompt => prompt.key === note.key)) prompts.push(note);
    const depthNote = fields ? buildCharacterDepthPrompt(promptCharacter, fields.charDepthPrompt, extensionSettings) : null;
    if (depthNote && !prompts.some(prompt => prompt.key === depthNote.key)) prompts.push(depthNote);
    const report = buildWorldInfoReport(runtime.worldInfo, promptCharacter, messages,
      metadata, settings.contextLimitTokens,
      { model: settings.model, userName: getPersonaUserName(extensionSettings, metadata),
        macroSession: session,
        ...(fields ? { globalScanData: { characterDescription: fields.description, characterPersonality: fields.personality,
          scenario: fields.scenario, creatorNotes: fields.creatorNotes, personaDescription: fields.persona,
          characterDepthPrompt: fields.charDepthPrompt } } : {}),
        maxResponseTokens: settings.maxTokens,
        dryRun: options.dryRun ?? true,
        ...(options.trigger === undefined ? {} : { trigger: options.trigger }),
        worldInfoSourceMessages: options.worldInfoSourceMessages ?? conversation?.messages ?? messages,
        worldInfoBranchId: options.worldInfoBranchId ?? conversation?.activeBranchId ?? character.id,
        extensionSettings,
        extensionScanPrompts: prompts.filter(prompt => prompt.scan) });
    return finalizeWorldInfoRegex(report, regexExecutor, promptCharacter, metadata, extensionSettings, session, {
      model: settings.model, userName: getPersonaUserName(extensionSettings, metadata), contextLimitTokens: settings.contextLimitTokens,
      maxResponseTokens: settings.maxTokens, signal: options.signal ?? memoryShutdown.signal,
    });
  };

  // 长期记忆后台刷新（FR-MEM-002/004/006）：
  // 从最近一轮已完成对话增量提取记忆，并更新阶段摘要。
  // 全部在事件流写完之后执行；任何一步失败都不影响已完成的聊天。
  const refreshLongTermMemory = async (options: {
    settings: ReturnType<RuntimeRepository["getProvider"]>;
    apiKey?: string;
    character: CharacterDetail;
    conversationId: string;
    userMessage: ChatMessage | undefined;
    assistant: ChatMessage;
    allMessages: ChatMessage[];
    autoSummary: boolean;
  }): Promise<void> => {
    if (isClosing) return;
    const branchId = options.assistant.branchId;
    const pair = options.userMessage ? [options.userMessage, options.assistant] : [options.assistant];
    if (!runtime.isMessageSnapshotCurrent(options.conversationId, branchId, pair)) return;
    const complete: typeof completeText = input => completeText({ ...input, signal: memoryShutdown.signal });
    // (1) 记忆提取：只处理最近一轮（最后一条用户消息 + 本轮助手回复）。
    if (options.userMessage && options.userMessage.status === "complete") {
      const existing = runtime.listMemories(options.conversationId);
      const extracted = await extractMemories({
        complete,
        settings: options.settings,
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        character: options.character,
        conversationId: options.conversationId,
        pair: [options.userMessage, options.assistant],
        alreadyExtractedSourceIds: new Set(
          existing.filter(memory => memory.sourceMessageIds.includes(options.assistant.id))
            .flatMap((memory) => memory.sourceMessageIds),
        ),
      });
      if (isClosing || !runtime.isMessageSnapshotCurrent(options.conversationId, branchId, pair)) return;
      runtime.withTransaction(() => {
        for (const record of extracted) {
          // Classification and insertion are atomic; failed inserts cannot leave dangling replacement links.
          runtime.recordSupersession(record);
          runtime.addMemory(record);
        }
      });
    }
    // (2) 阶段摘要：当消息数超过摘要覆盖范围时增量更新。
    if (options.autoSummary) {
      const savedSummary = runtime.getSummary(options.conversationId);
      const current = savedSummary?.valid ? savedSummary : undefined;
      const eligible = options.allMessages.filter(
        (message) => message.status === "complete" && message.content.trim().length > 0
          && (!message.generationMetadata?.completionOutcome || message.generationMetadata.completionOutcome === "complete"),
      );
      const covered = current?.coveredMessageCount ?? 0;
      // 摘要覆盖较早消息；至少保留最近 12 条作为原始对话。
      const summarySource = eligible.slice(0, Math.max(covered, eligible.length - 12));
      if (summarySource.length > covered + 1 || (summarySource.length >= 4 && !current)) {
        const summary = await summarizeMessages({
          complete,
          settings: options.settings,
          ...(options.apiKey ? { apiKey: options.apiKey } : {}),
          character: options.character,
          messages: summarySource,
          ...(current ? { existingSummary: current.content } : {}),
        });
        if (isClosing || !runtime.isMessageSnapshotCurrent(options.conversationId, branchId, summarySource, true)) return;
        const latestSummary = runtime.getSummary(options.conversationId);
        if (latestSummary?.createdAt !== savedSummary?.createdAt || latestSummary?.content !== savedSummary?.content) return;
        if (summary) {
          runtime.saveSummary(
            options.conversationId,
            summary.content,
            summary.coveredMessageCount,
            options.settings.model,
          );
        }
      }
    }
  };

  /**
   * 把一次模型生成以 SSE 事件流写回客户端（FR-PROV-004）。
   * 中止（用户停止）时保留已接收文本并标记为 stopped；网络/超时错误标记为 failed。
   * 未完成/失败/空回复不会进入后续完整状态，也就不会触发记忆提取。
   */
  const streamGenerationToReply = async (
    reply: FastifyReply,
    conversationId: string,
    character: CharacterDetail,
    assistant: ChatMessage | undefined,
    controller: AbortController,
    userMessage?: ChatMessage,
    sourceHistory?: ChatMessage[],
    extensionPrompts: ExtensionPrompt[] = [],
    options: { browserPreflight?: boolean; browserMacros?: boolean; inputContent?: string; dryRun?: boolean; prepareAssistant?: () => ChatMessage; regexContext?: NativeRegexContext; generationType?: string } = {},
  ): Promise<void> => {
    const regexContext = options.regexContext ?? createRegexContext(character, conversationId);
    const { settings, macroSession } = regexContext;
    const encrypted = runtime.getEncryptedApiKey();
    const apiKey = encrypted ? secretCodec?.unseal(encrypted) : undefined;
    const generation: MessageGenerationMetadata = {
      model: settings.model,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
    };

    // 接管原始响应，逐事件写出；hijack 后 Fastify 不再处理 onSend/onResponse。
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    });
    const send = (event: GenerationSseEvent): void => {
      raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    let macroBranchId = runtime.getConversation(conversationId)?.activeBranchId ?? null;
    const worldInfoScanBranchId = macroBranchId;
    const browserResolver = macroRpc(controller.signal, (requestId, call) => send({ type: "macro_request", requestId, conversationId, branchId: macroBranchId,
      evaluation: { ...call } }));
    const phase = <T>(work: () => T | Promise<T>): Promise<T> => options.browserMacros
      ? runMacroBoundary(macroSession, controller.signal, browserResolver, work) : Promise.resolve().then(work);
    if (userMessage) {
      send({ type: "user_message", message: userMessage });
    }
    if (assistant) send({ type: "assistant_start", message: assistant });
    const disconnected = () => { if (!raw.writableFinished) controller.abort(); };
    raw.on("close", disconnected);
    let content = "";
    try {
      if (options.inputContent !== undefined && !options.dryRun) {
        const value = options.inputContent ? await phase(() => applyRegexStage(character, "input", options.inputContent!, "user", undefined, false,
          controller.signal, regexContext)) : "";
        controller.signal.throwIfAborted();
        userMessage = value ? runtime.addMessage(conversationId, "user", value) : undefined;
        if (userMessage) send({ type: "user_message", message: userMessage });
        sourceHistory = runtime.listMessages(conversationId, 80);
      }
      // 模型上下文只带当前分支最近 80 条；更长的历史仍保存在数据库并完整展示在 UI。
      // 历史在创建 streaming 助手占位消息之前读取，避免占位消息占用窗口。
      const rawHistory = sourceHistory ?? runtime.listMessages(conversationId, 80);
      const fullSourceHistory = runtime.getConversation(conversationId)?.messages ?? [];
      const worldInfoSourceMessages = options.prepareAssistant ? fullSourceHistory.slice(0, -1) : fullSourceHistory;
      // 根据消息角色和倒数深度处理提示词副本，不覆盖已保存原文。
      const history: ChatMessage[] = [];
      for (const [index, message] of rawHistory.entries()) {
        history.push({ ...message, content: await phase(() => applyRegexStage(character, "prompt", message.content, message.role, rawHistory.length - index - 1, false, controller.signal, regexContext)) });
      }
      // 世界书匹配只基于已保存/待发送的原文，在 prompt 阶段改写之前执行（FR-LORE-002）。
      const lorebook = await phase(() => buildLorebookReport(character, rawHistory, conversationId, extensionPrompts, 0, false, settings, macroSession,
        { signal: controller.signal, regexContext, dryRun: options.dryRun ?? false,
          trigger: options.generationType ?? (options.prepareAssistant ? "regenerate" : "normal"),
          worldInfoSourceMessages, ...(macroBranchId ? { worldInfoBranchId: macroBranchId } : {}) }));
      send({ type: "lorebook", report: lorebook });
      // 长期记忆检索（FR-MEM-005）：基于当前分支可达记忆与本轮上下文；
      // 报告通过 SSE 下发，block 由预算决定最终是否进入提示词。
      if (!options.dryRun) runtime.syncMemoryReachability(conversationId);
      // A regenerate request uses the prefix preceding the old response even
      // before accepting a new branch. Its derived facts must not enter preflight.
      const excludedSourceId = options.prepareAssistant ? runtime.getConversation(conversationId)?.messages.at(-1)?.id : undefined;
      const memories = runtime.listMemories(conversationId).filter(memory => !excludedSourceId
        || memory.conversationId !== conversationId || !memory.sourceMessageIds.includes(excludedSourceId));
      const memory = retrieveMemories({
        conversationId,
        memories,
        model: settings.model,
        scanText: rawHistory.map((message) => message.content).join("\n"),
      });
      const savedSummary = runtime.getSummary(conversationId);
      const summary = savedSummary?.valid && (!excludedSourceId || !savedSummary.sourceMessageIds?.includes(excludedSourceId)) ? savedSummary : undefined;
      const result = await streamReply({
        ...(options.browserMacros ? { preparePrompt: phase } : {}),
        macroSession,
        generationType: options.generationType ?? (options.prepareAssistant ? "regenerate" : "normal"),
        dryRun: options.dryRun ?? false,
        ...(options.browserPreflight ? { onRequest: (request: NativeCompletionRequest, signal: AbortSignal) => preflight(signal, requestId => send({ type: "completion_request", requestId, request, dryRun: options.dryRun ?? false })) } : {}),
        onReady: request => {
          controller.signal.throwIfAborted();
          const changes=macroSession.changes();
          let readyAssistant = assistant;
          runtime.withTransaction(() => {
            runtime.commitMacroVariables(conversationId,changes);
            readyAssistant ??= options.prepareAssistant?.() ?? runtime.createAssistantMessage(conversationId);
            if (readyAssistant) commitWorldInfoEffects(runtime, conversationId, readyAssistant.branchId, lorebook);
            runtime.markMemoriesUsed(memory.results.filter(item => item.injected).map(item => item.memoryId));
          });
          macroSession.checkpointChanges();
          if (readyAssistant) macroBranchId = readyAssistant.branchId;
          const worldInfoState=getCommittedWorldInfoState(runtime,conversationId,lorebook);
          if(changes.length||worldInfoState)send({type:"macro_variables",conversationId,changes,
            ...(worldInfoScanBranchId ? {branchId:worldInfoScanBranchId} : {}),...(worldInfoState?{worldInfoState}:{})});
          generation.model = request.model;
          generation.maxTokens = request.max_completion_tokens ?? request.max_tokens ?? settings.maxTokens;
          if (typeof request.temperature === "number") generation.temperature = request.temperature;
          if (!assistant && readyAssistant) { assistant = readyAssistant; send({ type: "assistant_start", message: assistant }); }
        },
        extensionPrompts,
        chatMetadata: regexContext.metadata,
        extensionSettings: regexContext.extensionSettings,
        userTurnCount: runtime.getConversation(conversationId)?.messages.filter(message => message.role === "user").length ?? 0,
        settings,
        ...(apiKey ? { apiKey } : {}),
        character,
        history,
        plugins: [
          ...runtime.activePlugins(),
          ...runtime.activeCodePluginsAsInstalled(),
        ],
        lorebook,
        memory,
        ...(summary ? { stageSummary: summary.content } : {}),
        signal: controller.signal,
        onDelta: (delta) => { content += delta; send({ type: "delta", delta }); },
        onFinish: end => { generation.finishReason = end.finishReason; generation.completionOutcome = end.completionOutcome; },
        onBudget: (budget) => {
          if (budget.retainedMemoryIds) reconcileMemoryReport(memory, budget.retainedMemoryIds);
          send({ type: "memory", report: memory });
          send({
          type: "prompt_budget",
          report: {
            contextLimitTokens: budget.contextLimitTokens,
            reserveTokens: budget.reserveTokens,
            availableTokens: budget.availableTokens,
            regions: budget.regions,
            recentMessageCount: budget.recentMessages.length,
            diagnostics: budget.diagnostics,
            totalTokens: budget.totalTokens,
          },
          });
        },
      });
      if (!assistant) { send({ type: "generation_end", reason: controller.signal.aborted ? "stopped" : "preview" }); return; }
      content = result;
      // output 阶段在模型回复保存前执行（FR-REGEX-002）。
      if (!controller.signal.aborted) content = await phase(() => applyRegexStage(character, "output", content, "assistant", undefined, false, controller.signal, regexContext));
      const stopped = controller.signal.aborted;
      const outputChanges = stopped ? [] : macroSession.changes();
      const finalized = runtime.withTransaction(() => {
        runtime.commitMacroVariables(conversationId, outputChanges);
        return runtime.finalizeAssistantMessage(assistant!, stopped ? "stopped" : "complete", content, generation);
      });
      macroSession.checkpointChanges();
      if (outputChanges.length) send({ type: "macro_variables", conversationId, changes: outputChanges,
        ...(macroBranchId ? { branchId: macroBranchId } : {}) });
      send({ type: "done", message: finalized });
      // 只有完整完成的回复才触发记忆提取与摘要（FR-MEM-002/006），
      // 且在主流程之外执行：失败不阻止聊天，也不影响本轮事件流。
      if (finalized.status === "complete" && generation.completionOutcome === "complete") {
        const allMessages = runtime.listMessages(conversationId);
        const task: Promise<void> = refreshLongTermMemory({
          settings,
          ...(apiKey ? { apiKey } : {}),
          character,
          conversationId,
          // 最近一轮的用户消息（重新生成时该用户消息已提取过，会按来源去重跳过）。
          userMessage: [...allMessages].reverse().find((message) => message.role === "user"),
          assistant: finalized,
          allMessages,
          autoSummary: runtime.isAutoSummaryEnabled(conversationId),
        }).catch(error => { app.log.error(error, "Background memory update failed"); }).finally(() => { memoryJobs.delete(task); });
        memoryJobs.add(task);
      }
    } catch (error) {
      const message = error instanceof ModelRequestError || error instanceof MacroVariableConflictError
        ? error.message
        : "模型生成失败。";
      const stopped = controller.signal.aborted;
      if (!assistant) {
        if (!stopped) send({ type: "error", message });
        send({ type: "generation_end", reason: "stopped" });
        return;
      }
      const finalized = runtime.finalizeAssistantMessage(assistant, stopped ? "stopped" : "failed", content || message, generation);
      if (!stopped) send({ type: "error", message });
      send({ type: "done", message: finalized });
    } finally {
      if (inFlightGenerations.get(conversationId) === controller) inFlightGenerations.delete(conversationId);
      raw.off("close", disconnected);
      raw.end();
    }
  };

  app.addHook("preClose", async () => {
    isClosing = true;
    memoryShutdown.abort();
    for (const controller of inFlightGenerations.values()) controller.abort();
  });
  app.addHook("onClose", async () => {
    await Promise.allSettled(memoryJobs);
  });

  return {
    preflight,
    macroRpc,
    allowNativeCharacterRegex,
    createRegexContext,
    applyRegexStage,
    buildLorebookReport,
    streamGenerationToReply,
    inFlightGenerations,
    memoryShutdown,
  };
}

export type GenerationPipeline = ReturnType<typeof createGenerationPipeline>;
