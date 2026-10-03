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
  ModelResponseState,
  ModelCandidateSnapshot,
  ProviderSettings,
  ProviderTask,
} from "@mycompanion/shared";

import type { CharacterRepository } from "./character-repository.js";
import {
  characterWithChatOverrides,
  completeText,
  ModelRequestError,
  streamReply,
} from "./model-client.js";
import { extractMemories, summarizeMessages } from "./memory-extractor.js";
import { reconcileMemoryReport } from "./memory-engine.js";
import { SemanticMemoryRetriever, type SemanticMemoryInput, type EmbeddingSelection } from "./semantic-memory.js";
import type { RuntimeRepository } from "./runtime-repository.js";
import { collectNativeRegexScripts, TavernRegexExecutor } from "./tavern-regex-service.js";
import { buildWorldInfoReport, finalizeWorldInfoRegex, collectWorldInfoEntries } from "./world-info-service.js";
import { normalizeWorldInfoEntries } from "./worldbook-engine.js";
import { worldInfoVectorSettings, worldInfoVectorQueryText, activateWorldInfoVectors, type WorldInfoVectorActivation } from "./world-info-vectors.js";
import { commitWorldInfoEffects, getCommittedWorldInfoState, getWorldInfoTimerSnapshot, replaceWorldInfoTimerSnapshot } from "./world-info-effects.js";
import { buildAuthorNotePrompt } from "./author-note-core.js";
import { getPersonaUserName } from "./power-user-core.js";
import { MacroEvaluationSession } from "./prompt-macros.js";
import { MacroVariableConflictError } from "./macro-variable-conflict.js";
import { bindCharacterMacroEnvironment, buildCharacterDepthPrompt, prepareCharacterMacroFields } from "./character-macros.js";
import type { SecretCodec } from "./route-types.js";
import { createMacroBoundaryRpc, createEffectBoundaryRpc, runMacroBoundary } from "./macro-boundary.js";
import { getWorldInfoOutlets, getWorldInfoActivatedEntries, worldInfoOutletsFromPrompts } from "./world-info-activation.js";

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
  providerProfileId: string;
  encryptedApiKey?: string;
  embeddingSelection: EmbeddingSelection | null;
  embeddingSelectionUnavailable: boolean;
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
  const effectRpc = createEffectBoundaryRpc(app);

  // 每个对话同时最多一个进行中的流式生成；用于“停止”时中止请求。
  const inFlightGenerations = new Map<string, AbortController>();
  const memoryJobs = new Set<Promise<void>>();
  const memoryShutdown = new AbortController();
  let isClosing = false;
  // Resolve configuration and ciphertext synchronously; subsequent awaits use
  // this invocation's snapshot even when the selected connection changes.
  const taskSnapshot = (task: ProviderTask) => {
    const selected = runtime.resolveTaskProvider(task);
    if (!selected) return undefined;
    const encrypted = runtime.getEncryptedApiKey(selected.profileId);
    return { ...selected, ...(encrypted ? { encryptedApiKey: encrypted } : {}) };
  };
  const snapshotKey = (snapshot: { encryptedApiKey?: string } | undefined): string | undefined => {
    if (!snapshot?.encryptedApiKey) return undefined;
    if (!secretCodec) throw new ModelRequestError("系统安全存储不可用，无法读取 API Key。", 503);
    try { return secretCodec.unseal(snapshot.encryptedApiKey); }
    catch { throw new ModelRequestError("已保存密钥无法读取，请重新填写 API Key。", 503); }
  };
  const embeddingSnapshot = (): EmbeddingSelection | null => {
    const snapshot = taskSnapshot("embedding");
    if (!snapshot) return null;
    const key = snapshotKey(snapshot);
    return { profileId: snapshot.profileId, settings: snapshot.settings, ...(key ? { apiKey: key } : {}) };
  };
  const semanticMemory = new SemanticMemoryRetriever(runtime.vectors, () => embeddingSnapshot() ?? undefined, id => runtime.getMemory(id));
  const retrieveMemory = (input: SemanticMemoryInput) => semanticMemory.retrieve(input);
  const prepareWorldInfoVectorActivation = async (character: CharacterDetail, conversationId:string, history:ChatMessage[],context:NativeRegexContext,
    phase:<T>(work:()=>T|Promise<T>)=>Promise<T>,signal:AbortSignal,dryRun:boolean,trigger:string):Promise<WorldInfoVectorActivation> => {
    const result:WorldInfoVectorActivation={entries:[],diagnostics:[]},settings=worldInfoVectorSettings(context.extensionSettings);
    // Fixed vectors.rearrangeChat skips quiet and Generate skips interceptors in
    // previews. Public getWorldInfoPrompt is also an independent scanner call.
    if(dryRun||trigger==="quiet"||!settings.enabled_world_info)return result;
    const sources=()=>{
      const current=characters.get(character.id)??character,metadata=runtime.getConversation(conversationId)?.chatMetadata??context.metadata;
      const selected=characterWithChatOverrides(current,metadata);
      return normalizeWorldInfoEntries(collectWorldInfoEntries(runtime.worldInfo,selected,metadata,runtime.worldInfo.settings(),context.extensionSettings),selected.id);
    };
    const entries=sources(),before=JSON.stringify(entries);
    if(!entries.some(entry=>!entry.disable&&entry.content&&(entry.vectorized||settings.enabled_for_all)))return result;
    const query=await phase(()=>worldInfoVectorQueryText(history,settings,context.macroSession,context.macroContext));
    const activation=await activateWorldInfoVectors(runtime.vectorCollections,settings,entries,query,context.embeddingSelection,signal,context.embeddingSelectionUnavailable);
    signal.throwIfAborted();
    if(before!==JSON.stringify(sources()))return {entries:[],diagnostics:["世界书在向量查询期间发生变化，本轮未使用过期向量激活；请重新发送。"]};
    if(activation.entries.length)await phase(()=>context.macroSession.invokeEffect("world-info-force",{scope:context.macroSession.createEffectScope(),entries:activation.entries,context:context.macroContext}));
    return activation;
  };
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
    const extensionSettings = runtime.getExtensionSettings(), provider = taskSnapshot("chat")!, settings = provider.settings;
    const macroSession = new MacroEvaluationSession(metadata, extensionSettings);
    const { context: macroContext } = bindCharacterMacroEnvironment(characterWithChatOverrides(character, metadata),
      metadata, extensionSettings, settings, macroSession);
    let embeddingSelection: EmbeddingSelection | null = null, embeddingSelectionUnavailable = false;
    try { embeddingSelection = embeddingSnapshot(); } catch { embeddingSelectionUnavailable = true; }
    return { macroSession, metadata, extensionSettings, settings, macroContext, providerProfileId: provider.profileId, embeddingSelection, embeddingSelectionUnavailable,
      ...(provider.encryptedApiKey ? { encryptedApiKey: provider.encryptedApiKey } : {}) };
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
      dryRun?: boolean; trigger?: string; worldInfoSourceMessages?: ChatMessage[]; worldInfoBranchId?: string; vectorActivation?:WorldInfoVectorActivation } = {},
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
        ...(options.vectorActivation?.entries.length?{forcedEntries:options.vectorActivation.entries}:{}),
        extensionScanPrompts: prompts.filter(prompt => prompt.scan) });
    const finalized = await finalizeWorldInfoRegex(report, regexExecutor, promptCharacter, metadata, extensionSettings, session, {
      model: settings.model, userName: getPersonaUserName(extensionSettings, metadata), contextLimitTokens: settings.contextLimitTokens,
      maxResponseTokens: settings.maxTokens, signal: options.signal ?? memoryShutdown.signal,
    });
    if(options.vectorActivation?.diagnostics.length)for(const entry of finalized.results)entry.diagnostics.push(...options.vectorActivation.diagnostics);
    const activated = getWorldInfoActivatedEntries(finalized);
    if (options.dryRun === false && activated.length) {
      const response = session.invokeEffect("world-info-activated", { scope: session.createEffectScope(), entries: activated,
        timedWorldInfo: getWorldInfoTimerSnapshot(finalized), context: options.regexContext?.macroContext ?? {
          characterName: promptCharacter.name, userName: getPersonaUserName(extensionSettings, metadata),
          model: settings.model, contextLimitTokens: settings.contextLimitTokens, maxResponseTokens: settings.maxTokens,
        } }) as { timedWorldInfo?: Record<string, unknown> } | undefined;
      if (response?.timedWorldInfo) replaceWorldInfoTimerSnapshot(finalized, response.timedWorldInfo);
    }
    const previousOutlets = session.getCharacterEnvironment().worldInfoOutlets ?? {};
    const outlets = getWorldInfoOutlets(finalized);
    session.bindWorldInfoOutlets(outlets);
    if (Object.keys(previousOutlets).length || Object.keys(outlets).length) session.invokeEffect("world-info-outlets", { outlets });
    return finalized;
  };

  // 长期记忆后台刷新（FR-MEM-002/004/006）：
  // 从最近一轮已完成对话增量提取记忆，并更新阶段摘要。
  // 全部在事件流写完之后执行；任何一步失败都不影响已完成的聊天。
  const refreshLongTermMemory = async (options: {
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
    // Independent jobs use separately selected task models. A slow or rejected
    // extraction must not hold up summary, or silently fall back to a service.
    const extraction = async () => {
    if (options.userMessage && options.userMessage.status === "complete") {
      const snapshot = taskSnapshot("extraction")!, apiKey = snapshotKey(snapshot);
      const existing = runtime.listMemories(options.conversationId);
      const extracted = await extractMemories({
        complete,
        settings: snapshot.settings,
        ...(apiKey ? { apiKey } : {}),
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
    };
    // (2) 阶段摘要：当消息数超过摘要覆盖范围时增量更新。
    const summaryJob = async () => {
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
        const snapshot = taskSnapshot("summary")!, apiKey = snapshotKey(snapshot);
        const summary = await summarizeMessages({
          complete,
          settings: snapshot.settings,
          ...(apiKey ? { apiKey } : {}),
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
            snapshot.settings.model,
          );
        }
      }
    }
    };
    await Promise.allSettled([extraction(), summaryJob()]);
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
    options: { browserPreflight?: boolean; browserMacros?: boolean; inputContent?: string; dryRun?: boolean; prepareAssistant?: () => ChatMessage; continueFrom?: ChatMessage; ephemeral?: boolean; regexContext?: NativeRegexContext; generationType?: string } = {},
  ): Promise<void> => {
    const regexContext = options.regexContext ?? createRegexContext(character, conversationId);
    const { settings, macroSession } = regexContext;
    macroSession.bindWorldInfoOutlets(worldInfoOutletsFromPrompts(extensionPrompts));
    let apiKey: string | undefined;
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
    const effectResolver = effectRpc(controller.signal, (requestId, call) => send({ type: "effect_request", requestId, conversationId, branchId: macroBranchId,
      evaluation: { ...call } }), invocationId => send({ type: "effect_end", invocationId }));
    const phase = <T>(work: () => T | Promise<T>): Promise<T> => options.browserMacros
      ? runMacroBoundary(macroSession, controller.signal, browserResolver, work, effectResolver) : Promise.resolve().then(work);
    if (userMessage) {
      send({ type: "user_message", message: userMessage });
    }
    if (assistant) send({ type: "assistant_start", message: assistant });
    const disconnected = () => { if (!raw.writableFinished) controller.abort(); };
    raw.on("close", disconnected);
    let content = options.continueFrom?.content ?? "";
    let candidates:ModelCandidateSnapshot[]=[];
    let outputPartials:{content:string;candidates:ModelCandidateSnapshot[]}|undefined;
    let acceptedInitialRequest = false;
    try {
      apiKey = snapshotKey(regexContext);
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
      const worldInfoSourceMessages = options.prepareAssistant && !options.continueFrom ? fullSourceHistory.slice(0, -1) : fullSourceHistory;
      // 根据消息角色和倒数深度处理提示词副本，不覆盖已保存原文。
      const history: ChatMessage[] = [];
      for (const [index, message] of rawHistory.entries()) {
        history.push({ ...message, content: await phase(() => applyRegexStage(character, "prompt", message.content, message.role, rawHistory.length - index - 1, false, controller.signal, regexContext)) });
      }
      // 世界书匹配只基于已保存/待发送的原文，在 prompt 阶段改写之前执行（FR-LORE-002）。
      const vectorActivation = await prepareWorldInfoVectorActivation(character,conversationId,history,regexContext,phase,controller.signal,
        options.dryRun??false,options.generationType??(options.prepareAssistant?"regenerate":"normal"));
      const lorebook = await phase(() => buildLorebookReport(character, rawHistory, conversationId, extensionPrompts, 0, false, settings, macroSession,
        { signal: controller.signal, regexContext, dryRun: options.dryRun ?? false,
          trigger: options.generationType ?? (options.prepareAssistant ? "regenerate" : "normal"),
          worldInfoSourceMessages, vectorActivation, ...(macroBranchId ? { worldInfoBranchId: macroBranchId } : {}) }));
      send({ type: "lorebook", report: lorebook });
      // 长期记忆检索（FR-MEM-005）：基于当前分支可达记忆与本轮上下文；
      // 报告通过 SSE 下发，block 由预算决定最终是否进入提示词。
      if (!options.dryRun) runtime.syncMemoryReachability(conversationId);
      // A regenerate request uses the prefix preceding the old response even
      // before accepting a new branch. Its derived facts must not enter preflight.
      const excludedSourceId = options.prepareAssistant && !options.continueFrom ? runtime.getConversation(conversationId)?.messages.at(-1)?.id : undefined;
      const memories = runtime.listMemories(conversationId).filter(memory => !excludedSourceId
        || memory.conversationId !== conversationId || !memory.sourceMessageIds.includes(excludedSourceId));
      const memory = await retrieveMemory({
        conversationId,
        memories,
        model: settings.model,
        scanText: rawHistory.map((message) => message.content).join("\n"),
        semanticQuery: [...rawHistory].reverse().find(message => message.role === "user")?.content ?? rawHistory.at(-1)?.content ?? "",
        signal: controller.signal, dryRun: options.dryRun ?? false,
        embeddingSelection: regexContext.embeddingSelection,
        embeddingSelectionUnavailable: regexContext.embeddingSelectionUnavailable,
      });
      const savedSummary = runtime.getSummary(conversationId);
      const summary = savedSummary?.valid && (!excludedSourceId || !savedSummary.sourceMessageIds?.includes(excludedSourceId)) ? savedSummary : undefined;
      const result = await streamReply({
        ...(options.browserMacros ? { preparePrompt: phase } : {}),
        macroSession,
        generationType: options.generationType ?? (options.prepareAssistant ? "regenerate" : "normal"),
        ...(options.continueFrom ? { preserveOutput: true } : {}),
        dryRun: options.dryRun ?? false,
        ...(options.browserPreflight ? { onRequest: (request: NativeCompletionRequest, signal: AbortSignal) => preflight(signal, requestId => send({ type: "completion_request", requestId, request, dryRun: options.dryRun ?? false, provider: settings })) } : {}),
        onReady: request => {
          controller.signal.throwIfAborted();
          const changes=macroSession.changes();
          let readyAssistant = assistant;
          runtime.withTransaction(() => {
            runtime.commitMacroVariables(conversationId,changes);
            if (!acceptedInitialRequest) {
              if (!options.ephemeral) readyAssistant ??= options.prepareAssistant?.() ?? runtime.createAssistantMessage(conversationId);
              const acceptedBranch = readyAssistant?.branchId ?? macroBranchId;
              if (acceptedBranch) commitWorldInfoEffects(runtime, conversationId, acceptedBranch, lorebook);
              runtime.markMemoriesUsed(memory.results.filter(item => item.injected).map(item => item.memoryId));
            }
          });
          acceptedInitialRequest = true;
          macroSession.checkpointChanges();
          if (readyAssistant) macroBranchId = readyAssistant.branchId;
          const worldInfoState=getCommittedWorldInfoState(runtime,conversationId,lorebook);
          if(changes.length||worldInfoState)send({type:"macro_variables",conversationId,changes,
            ...(worldInfoScanBranchId ? {branchId:worldInfoScanBranchId} : {}),...(worldInfoState?{worldInfoState}:{})});
          generation.model = request.model;
          candidates=[];
          // A tool continuation starts a new response map. Partial final-round
          // text must not be concatenated with its earlier tool-call preface.
          if(Number(request.n)>1)content=options.continueFrom?.content??"";
          // Usage and response state belong to this request's final round. Earlier
          // tool rounds retain their own usage/accounting in generation.toolRounds.
          delete generation.usage;
          delete generation.responseState;
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
        onUsage: usage => { generation.usage = usage; },
        onResponseState: state => {
          if(state.protocol!=="openai"||state.reasoning||state.signature||state.toolCalls.length||state.media.length||state.providerContent.length)
            generation.responseState = state;
        },
        onCandidates: snapshot => { candidates=structuredClone(snapshot); },
        onToolRound: rounds => { generation.toolRounds=rounds; },
        ...(options.browserPreflight ? {onToolCalls:async (state:ModelResponseState,signal:AbortSignal,assistantText:string)=>{
          const invocationId=crypto.randomUUID();
          const tools=effectRpc(signal,(requestId,call)=>send({type:"effect_request",requestId,conversationId,branchId:macroBranchId,evaluation:{...call}}),
            id=>send({type:"effect_end",invocationId:id}));
          try{
            const result=await tools({invocationId,ordinal:generation.toolRounds?.length??0,kind:"tool-calls",payload:{state,assistantText},
              environment:structuredClone(macroSession.getCharacterEnvironment()),local:structuredClone(macroSession.local),global:structuredClone(macroSession.global)});
            signal.throwIfAborted();macroSession.replaceVariables(result.local,result.global);macroSession.checkpointChanges();
            return result.payload;
          }finally{tools.dispose?.(invocationId);}
        }}:{}),
        onFinish: end => { generation.finishReason = end.finishReason; generation.completionOutcome = end.completionOutcome;
          if(end.candidates)candidates=structuredClone(end.candidates);
          if (end.responseState) generation.responseState = end.responseState;
          if (end.toolRounds) generation.toolRounds=end.toolRounds;
          if (end.usage) generation.usage = end.usage; },
        onBudget: (budget) => {
          generation.tokenAccounting = budget.tokenAccounting;
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
            ...(budget.tokenAccounting ? { tokenAccounting: budget.tokenAccounting } : {}),
          },
          });
        },
      });
      if (options.ephemeral && acceptedInitialRequest && !controller.signal.aborted) {
        content = await phase(() => applyRegexStage(character, "input", result, "user", undefined, false, controller.signal, regexContext));
        const changes = macroSession.changes();
        runtime.commitMacroVariables(conversationId, changes); macroSession.checkpointChanges();
        if (changes.length) send({ type: "macro_variables", conversationId, changes, ...(macroBranchId ? { branchId: macroBranchId } : {}) });
        send({ type: "impersonate_result", text: content }); return;
      }
      if (!assistant) { send({ type: "generation_end", reason: controller.signal.aborted ? "stopped" : "preview" }); return; }
      content = (options.continueFrom?.content ?? "") + result;
      if(candidates.length)outputPartials={content,candidates:structuredClone(candidates)};
      // output 阶段在模型回复保存前执行（FR-REGEX-002）。
      if (!controller.signal.aborted) {
        const selected=await phase(() => applyRegexStage(character, "output", content, "assistant", undefined, false, controller.signal, regexContext));
        const processed:ModelCandidateSnapshot[]=[];
        for(const candidate of [...candidates].sort((a,b)=>a.index-b.index)){
          const candidateContent=candidate.index===0?selected:await phase(()=>applyRegexStage(character,"output",candidate.content,"assistant",undefined,false,controller.signal,regexContext));
          processed.push({...candidate,content:candidateContent});
        }
        // All output calls share the existing macro draft and commit together.
        // A later alternative's error leaves the provider partials unchanged.
        content=selected;candidates=processed;
      }
      const stopped = controller.signal.aborted;
      const outputChanges = stopped ? [] : macroSession.changes();
      const finalized = runtime.withTransaction(() => {
        runtime.commitMacroVariables(conversationId, outputChanges);
        return options.continueFrom ? runtime.finalizeContinuedMessage(assistant!, stopped ? "stopped" : "complete", content, generation)
          : runtime.finalizeAssistantMessage(assistant!, stopped ? "stopped" : "complete", content, generation, candidates);
      });
      outputPartials=undefined;
      macroSession.checkpointChanges();
      if (outputChanges.length) send({ type: "macro_variables", conversationId, changes: outputChanges,
        ...(macroBranchId ? { branchId: macroBranchId } : {}) });
      send({ type: "done", message: finalized });
      // 只有完整完成的回复才触发记忆提取与摘要（FR-MEM-002/006），
      // 且在主流程之外执行：失败不阻止聊天，也不影响本轮事件流。
      if (finalized.status === "complete" && generation.completionOutcome === "complete") {
        const allMessages = runtime.listMessages(conversationId);
        const task: Promise<void> = refreshLongTermMemory({
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
      if(outputPartials){content=outputPartials.content;candidates=outputPartials.candidates;}
      if(!content&&candidates.length)content=candidates.find(candidate=>candidate.index===0)?.content??"";
      const message = error instanceof ModelRequestError || error instanceof MacroVariableConflictError
        ? error.message
        : "模型生成失败。";
      const stopped = controller.signal.aborted;
      if (!assistant) {
        if (!stopped) send({ type: "error", message });
        send({ type: "generation_end", reason: "stopped" });
        return;
      }
      const finalized = options.continueFrom ? runtime.finalizeContinuedMessage(assistant, stopped ? "stopped" : "failed", content || message, generation)
        : runtime.finalizeAssistantMessage(assistant, stopped ? "stopped" : "failed", content || message, generation, candidates);
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
    semanticMemory.stop();
    for (const controller of inFlightGenerations.values()) controller.abort();
  });
  app.addHook("onClose", async () => {
    await Promise.allSettled(memoryJobs);
    await semanticMemory.close();
  });

  return {
    preflight,
    macroRpc,
    effectRpc,
    allowNativeCharacterRegex,
    createRegexContext,
    retrieveMemory,
    snapshotKey,
    applyRegexStage,
    buildLorebookReport,
    streamGenerationToReply,
    inFlightGenerations,
    memoryShutdown,
  };
}

export type GenerationPipeline = ReturnType<typeof createGenerationPipeline>;
