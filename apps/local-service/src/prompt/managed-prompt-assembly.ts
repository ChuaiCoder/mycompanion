import type { CharacterDetail, ChatMessage, ExtensionPrompt } from "@mycompanion/shared";
import type { ModelMessage, PromptAssemblyOptions } from "./model-client.js";
import { prepareCharacterMacroFields, buildCharacterDepthPrompt } from "./character-macros.js";
import { buildAuthorNotePrompt } from "./author-note-core.js";
import { getPersonaDescription, getPersonaUserName, personaDescriptionPositions } from "./power-user-core.js";
import { CONTEXT_RESERVE_TOKENS, type PromptBudgetReport, type PromptBudgetRegion } from "./prompt-budget.js";
import { PromptManager, prepareCompletionPrompts, parseCompatibleCompletionExample, INJECTION_POSITION, type PromptManagerSettings, type Prompt } from "./prompt-manager-core.js";
import { MacroEvaluationSession, macroVariableStores } from "./prompt-macros.js";
import { countCompatibilityMessagesSync, countTextTokens } from "./tokenizer-service.js";
import { isModelImageInliningSupported, materializePromptImage } from "./model-prompt-image.js";
import { canReplayNativeCandidateTools } from "@mycompanion/shared";

/** Imported Chat Completion presets share one preparation/budget/transport path.
 * Every substitution happens before candidate messages are measured. Rebuilding
 * a budget only rearranges already prepared data and never executes macros.
 */
export function assembleManagedModelPrompt(options: PromptAssemblyOptions, character: CharacterDetail,
  settings: PromptManagerSettings, session: MacroEvaluationSession) {
  const metadata = options.chatMetadata ?? {}, extensionSettings = options.extensionSettings ?? {};
  const macroContext = { macroSession: session, characterName: character.name,
    userName: getPersonaUserName(extensionSettings, metadata), model: options.settings.model,
    contextLimitTokens: options.settings.contextLimitTokens, maxResponseTokens: options.settings.maxTokens,
    now: session.now, ...macroVariableStores(metadata, extensionSettings) };
  const substitute = (content: string | undefined, original?: string | null) => session.evaluate(content ?? "", {
    ...macroContext, ...(typeof original === "string" ? { original } : {}),
  });
  const fields = options.prepareNativeCharacterFields === false ? {
    description: character.description, personality: character.personality, scenario: character.scenario,
    system: character.systemPrompt, jailbreak: character.postHistoryInstructions, mesExamples: character.exampleDialogue,
    charDepthPrompt: "",
  } : prepareCharacterMacroFields(character, metadata, extensionSettings, options.settings, session);
  const manager = new PromptManager(settings, substitute);
  const noteState = options.skipAuthorNote ? { active: false, prompt: null } : buildAuthorNotePrompt(metadata, extensionSettings,
    options.userTurnCount ?? options.history.filter(message => message.role === "user").length);
  const extensions: ExtensionPrompt[] = (options.extensionPrompts ?? []).filter(prompt => prompt.position !== -1 &&
    (!options.skipAuthorNote || prompt.key !== "2_floating_prompt")).map(prompt => ({ ...prompt }));
  const depthPrompt = options.prepareNativeCharacterFields !== false ? buildCharacterDepthPrompt(character, fields.charDepthPrompt, extensionSettings) : null;
  if (depthPrompt && !extensions.some(prompt => prompt.key === depthPrompt.key)) extensions.push(depthPrompt);
  if (noteState.prompt && !extensions.some(prompt => prompt.key === "2_floating_prompt")) extensions.push(noteState.prompt);
  const savedPersona = getPersonaDescription(extensionSettings, metadata);
  const persona = options.personaDescriptionOverride === undefined ? savedPersona : options.personaDescriptionOverride.trim()
    ? { content: options.personaDescriptionOverride, position: savedPersona?.position ?? 0, depth: savedPersona?.depth ?? 2, role: savedPersona?.role ?? 0 } : null;
  const personaAtPrompt = persona?.position === personaDescriptionPositions.IN_PROMPT ? persona.content : "";
  if (persona?.position === personaDescriptionPositions.AT_DEPTH
      && !extensions.some(prompt => prompt.key === "PERSONA_DESCRIPTION")) {
    extensions.push({ key: "PERSONA_DESCRIPTION", value: persona.content, position: 1,
      depth: persona.depth, role: persona.role as 0 | 1 | 2, scan: true });
  }
  let injected = options.lorebook.results.filter(entry => entry.status === "injected" && entry.content.trim());
  if (noteState.active) {
    const note = extensions.find(prompt => prompt.key === "2_floating_prompt");
    if (note) note.value = [
      ...injected.filter(entry => entry.position === 2).map(entry => entry.content),
      ...(persona?.position === 2 ? [persona.content] : []), note.value,
      ...(persona?.position === 3 ? [persona.content] : []),
      ...injected.filter(entry => entry.position === 3).map(entry => entry.content),
    ].filter(Boolean).join("\n");
  }
  const world = (position: number) => injected.filter(entry => (entry.position ?? 1) === position)
    .sort((a, b) => (a.insertionOrder ?? 0) - (b.insertionOrder ?? 0)).map(entry => entry.content).join("\n");
  const parseExamples = (text: string) => {
    if (!text || text === "<START>") return [];
    const marked = text.startsWith("<START>") ? text : "<START>\n" + text.trim();
    return marked.split(/<START>/gi).slice(1).map(block => parseCompatibleCompletionExample("<START>\n" + block.trim() + "\n", macroContext.userName, character.name));
  };
  // Native WI example insertion precedes PromptManager preparation. Each WI
  // entry has its own baseChatReplace pass, even when its text is identical.
  const exampleBlocks = options.messageExamples && !options.messageExamples.every(block => block.length === 0)
    ? options.messageExamples : options.messageExamples?.length === 0 ? []
    : parseExamples(options.prepareNativeCharacterFields === false && options.messageExamples?.length
      ? session.evaluate(fields.mesExamples, { ...macroContext, replaceCharacterCard: false }) : fields.mesExamples);
  for (const entry of injected.filter(entry => entry.position === 5 || entry.position === 6)) {
    const blocks = parseExamples(session.evaluate(entry.content, { ...macroContext, replaceCharacterCard: false }));
    entry.position === 5 ? exampleBlocks.unshift(...blocks) : exampleBlocks.push(...blocks);
  }
  const prompts = prepareCompletionPrompts(manager, { charDescription: fields.description, charPersonality: fields.personality,
    scenario: fields.scenario, worldInfoBefore: world(0), worldInfoAfter: world(1), personaDescription: personaAtPrompt,
    systemPromptOverride: fields.system, jailbreakPromptOverride: fields.jailbreak,
    ...(options.quietPrompt === undefined ? {} : { quietPrompt: options.quietPrompt }),
    ...(options.bias === undefined ? {} : { bias: options.bias }), extensions }, options.generationType ?? "normal");
  const modelMessage = (prompt: Prompt): ModelMessage => ({ role: prompt.role ?? "system", content: prompt.content ?? "" });
  const groups = new Map<string, ModelMessage[]>();
  const add = (identifier: string) => {
    const prompt = prompts.get(identifier);
    if (!prompt || (identifier !== "main" && manager.isPromptDisabledForActiveCharacter(identifier)) || prompt.injection_position === 1) return;
    groups.set(identifier, prompt.content ? [modelMessage(prompt)] : []);
  };
  for (const identifier of ["worldInfoBefore", "main", "worldInfoAfter", "charDescription", "charPersonality", "scenario", "personaDescription", "nsfw", "jailbreak"])
    add(identifier);
  for (const prompt of prompts.collection.filter(prompt => prompt.system_prompt === false && prompt.injection_position !== 1)) add(prompt.identifier);
  if (prompts.has("enhanceDefinitions")) add("enhanceDefinitions");
  if (options.bias?.trim()) add("bias");
  const absolute = prompts.collection.filter(prompt => prompt.injection_position === INJECTION_POSITION.ABSOLUTE);
  const injectRelative = (prompt: Prompt) => {
    const main = groups.get("main");
    if (main) prompt.position === "end" ? main.push(modelMessage(prompt)) : main.unshift(modelMessage(prompt));
    else {
      const mainIndex = absolute.findIndex(prompt => prompt.identifier === "main");
      if (mainIndex < 0) return;
      const anchor = absolute[mainIndex]!;
      absolute.splice(prompt.position === "end" ? mainIndex + 1 : mainIndex, 0,
        { ...prompt, role: anchor.role, injection_position: anchor.injection_position, injection_depth: anchor.injection_depth, injection_order: anchor.injection_order });
    }
  };
  for (const identifier of ["summary", "authorsNote", "vectorsMemory", "vectorsDataBank", "smartContext"]) {
    const prompt = prompts.get(identifier);
    if (prompt?.position) injectRelative(prompt);
  }
  for (const prompt of prompts.collection.filter(prompt => prompt.extension && prompt.position)) injectRelative(prompt);

  let memory = options.memory.results.filter(result => prompts.has("chatHistory") && result.injected && result.content.trim()).map(result => ({
    ...result, content: substitute(result.content),
  }));
  const additional: Array<{ key: PromptBudgetRegion["key"]; label: string; messages: ModelMessage[] }> = [];
  const rebuildMemory = () => {
    for (const [key, label, prefix, pinned] of [["memory_pinned", "固定记忆", "Pinned memories:", true],
      ["memory", "检索记忆", "Retrieved memories:", false]] as const) {
      const items = memory.filter(item => Boolean(item.pinned) === pinned);
      const index = additional.findIndex(item => item.key === key);
      const region = { key, label, messages: [{ role: "system" as const, content: `${prefix}\n${items.map(item => item.content).join("\n\n")}` }] };
      if (index >= 0) items.length ? additional.splice(index, 1, region) : additional.splice(index, 1);
      else if (items.length) additional.push(region);
    }
  };
  rebuildMemory();
  if (prompts.has("chatHistory") && options.stageSummary) additional.push({ key: "stage_summary", label: "阶段摘要", messages: [{ role: "system", content: substitute(options.stageSummary) }] });
  const declarative = options.plugins.filter(plugin => plugin.enabled && plugin.permissions.includes("prompt:system") && plugin.contributes.systemPrompt?.trim())
    .flatMap(plugin => prompts.has("chatHistory") ? [{ role: "system" as const, content: substitute(plugin.contributes.systemPrompt!) }] : []);
  if (declarative.length) additional.push({ key: "plugins", label: "插件注入", messages: declarative });

  // IN_CHAT is substituted once for each depth/role bucket after sorted values
  // are trimmed and joined; identical text in another bucket is a separate call.
  const bucketPrompts = [...extensions.filter(prompt => prompt.position === 1),
    ...injected.filter(entry => entry.position === 4).map(entry => ({ key: `world:${entry.index}`, value: entry.content,
      position: 1, depth: entry.depth ?? 4, role: entry.role ?? 0, scan: false }))];
  const buckets = new Map<string, ModelMessage>();
  for (const depth of [...new Set(bucketPrompts.map(prompt => prompt.depth))].sort((a, b) => a - b)) for (const role of [0, 1, 2]) {
    const values = bucketPrompts.filter(prompt => prompt.depth === depth && prompt.role === role).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
      .map(prompt => prompt.value.trim()).join("\n");
    const value = values ? substitute(values) : "";
    if (value) buckets.set(`${depth}:${role}`, { role: (["system", "user", "assistant"] as const)[role]!, content: value });
  }
  type PopulationMessage = ModelMessage & { sourceId?: string; injectionKey?: string };
  const controls: PopulationMessage[] = [],continuationNudge: PopulationMessage[]=[];
  if (options.generationType === "impersonate" && prompts.get("impersonate")?.content) controls.push(modelMessage(prompts.get("impersonate")!));
  if (prompts.get("quietPrompt")?.content) {
    const source = options.settings.kind === "anthropic" ? "claude" : options.settings.kind === "gemini" ? "makersuite" : "custom";
    const imageInlining = isModelImageInliningSupported(source, options.settings.model, settings.media_inlining);
    // Reserve the picture with the final quiet control before history admission.
    // An empty quiet prompt or disabled media input never creates a picture turn.
    controls.push({...modelMessage(prompts.get("quietPrompt")!), ...(options.quietImage && imageInlining ? {
      image: options.quietImage, imageDetail: options.imageQuality ?? (typeof settings.inline_image_quality === "string" && settings.inline_image_quality ? settings.inline_image_quality : "auto"),
    } : {})});
  }

  let history = options.history.filter(message => ["complete", "stopped"].includes(message.status) &&
    (message.content.trim() || typeof message.extensionData?.__mycompanion_prompt_image === "string") && message.extensionData?.is_system !== true);
  const continuationSource=options.generationType==="continue"?history.at(-1):undefined;
  const preparedHistory = new Map<string, string>(), preparedInjections = new Map<string, string>();
  const historyMessages = (source: ChatMessage[]): PopulationMessage[] => source.map(message => {
    const name = typeof message.extensionData?.modelName === "string" ? message.extensionData.modelName
      : typeof message.extensionData?.name === "string" ? message.extensionData.name
      : message.role === "user" ? macroContext.userName : character.name;
    const extra = message.extensionData?.extra;
    const narrator = extra !== null && typeof extra === "object" && !Array.isArray(extra) && (extra as Record<string, unknown>).type === "narrator";
    return { role: message.extensionData?.modelRole === "system" || narrator ? "system" as const : message.role,
      content: preparedHistory.get(message.id) ?? message.content, sourceId: message.id,
      ...(typeof message.extensionData?.__mycompanion_prompt_image === "string" ? {
        image:message.extensionData.__mycompanion_prompt_image,
        imageDetail:typeof message.extensionData.__mycompanion_prompt_image_detail === "string"?message.extensionData.__mycompanion_prompt_image_detail:"auto",
      } : {}),
      ...(settings.names_behavior === 1 ? { name: manager.isValidName(name) ? name : manager.sanitizeName(name) } : {}) };
  });
  if(continuationSource&&settings.continue_prefill===true){
    history=history.filter(message=>message.id!==continuationSource.id);
    const tail=historyMessages([continuationSource])[0]!;
    const assistantPrefill=tail.role==="assistant"&&(settings.chat_completion_source==="claude"||options.settings.kind==="anthropic")
      ?substitute(typeof settings.assistant_prefill==="string"?settings.assistant_prefill:""):"";
    tail.content=[assistantPrefill,tail.content].filter(Boolean).join("\n\n");
    controls.push(tail);
  }
  const inject = (source: ModelMessage[]) => {
    const reversed = [...source].reverse(); let inserted = 0;
    const depths = [...new Set([...absolute.map(prompt => prompt.injection_depth ?? 4), ...bucketPrompts.map(prompt => prompt.depth)])].sort((a, b) => a - b);
    for (const depth of depths) {
      const roleMessages: PopulationMessage[] = [];
      const depthPrompts = absolute.filter(prompt => (prompt.injection_depth ?? 4) === depth && prompt.content);
      const orders = [...new Set([100, ...depthPrompts.map(prompt => prompt.injection_order)])].sort((a, b) => b - a);
      for (const order of orders) for (const [index, role] of (["system", "user", "assistant"] as const).entries()) {
        const preset = depthPrompts.filter(prompt => prompt.injection_order === order && (prompt.role ?? "system") === role).map(prompt => prompt.content).join("\n");
        const extension = order === 100 ? buckets.get(`${depth}:${index}`)?.content ?? "" : "";
        const content = [preset, extension].filter(Boolean).map(value => value.trim()).join("\n");
        const injectionKey = `${depth}:${order}:${role}`;
        if (content) roleMessages.push({ role, content: preparedInjections.get(injectionKey) ?? content, injectionKey });
      }
      reversed.splice(depth + inserted, 0, ...roleMessages); inserted += roleMessages.length;
    }
    return reversed.reverse();
  };
  const diagnostics: string[] = [], reserveTokens = options.settings.maxTokens + CONTEXT_RESERVE_TOKENS;
  const fixedMessages = (): ModelMessage[] => [...prompts.collection.flatMap(prompt =>
    prompt.identifier === "chatHistory" || prompt.identifier === "dialogueExamples" ? [] : groups.get(prompt.identifier) ?? []),
    ...(prompts.has("chatHistory") ? additional.flatMap(item => item.messages) : []), ...continuationNudge,...controls];
  let population: PopulationMessage[] = [];
  let exampleMessages: ModelMessage[] = [];
  let emptyUser: ModelMessage | undefined;
  let newChat = "";
  const populationCost = (candidate: ModelMessage[]) => countCompatibilityMessagesSync([
    ...fixedMessages(), ...(newChat ? [{ role: "system" as const, content: newChat }] : []), ...candidate, ...(emptyUser ? [emptyUser] : []),
  ].map(message => materializePromptImage({ ...message })), options.settings.model, true) + reserveTokens;
  const prepareExamples = (): ModelMessage[] => {
    if (!exampleBlocks.length || !prompts.has("dialogueExamples")) return [];
    const heading = substitute(typeof settings.new_example_chat_prompt === "string" ? settings.new_example_chat_prompt : "");
    const result: ModelMessage[] = [];
    for (const block of exampleBlocks) {
      const candidate = [ ...(heading ? [{ role: "system" as const, content: heading }] : []),
        ...block.map(message => ({ ...message, role: "system" as const })) ];
      if (populationCost([...population, ...result, ...candidate]) > options.settings.contextLimitTokens) {
        diagnostics.push("示例对话超出剩余上下文预算，已停止纳入后续示例块。"); break;
      }
      result.push(...candidate);
    }
    return result;
  };
  const powerUser = extensionSettings.__mycompanion_power_user as Record<string, unknown> | undefined;
  if (powerUser?.pin_examples === true) exampleMessages = prepareExamples();
  newChat = prompts.has("chatHistory") ? substitute(typeof settings.new_chat_prompt === "string" ? settings.new_chat_prompt : "") : "";
  if (prompts.has("chatHistory")) {
    // populateChatHistory independently prepares every visited message, newest
    // first, including depth injections. Preserve this later pass even when an
    // earlier field or extension pass left residual macro syntax.
    const populated = inject(historyMessages(history)) as PopulationMessage[];
    const cyclePrompt=options.cyclePrompt??continuationSource?.content;
    if(options.generationType==="continue"&&cyclePrompt&&settings.continue_prefill!==true){
      const index=populated.findLastIndex(message=>message.sourceId!==undefined);
      if(index>=0){
        const tail=populated.splice(index,1)[0]!;
        tail.content=manager.preparePrompt({identifier:tail.sourceId??"continue",role:tail.role,content:tail.content}).content??"";
        continuationNudge.push(tail);
      }
      const source=session.evaluate(typeof settings.continue_nudge_prompt==="string"?settings.continue_nudge_prompt:"",
        {...macroContext,dynamicMacros:{lastChatMessage:String(cyclePrompt).trim()}});
      const nudge=manager.preparePrompt({identifier:"continueNudge",role:"system",content:source});
      continuationNudge.push(modelMessage(nudge));
    }
    const sendIfEmpty = typeof settings.send_if_empty === "string" ? settings.send_if_empty : "";
    const replacement: ModelMessage = { role: "user", content: sendIfEmpty };
    if (populated.at(-1)?.role === "assistant" && sendIfEmpty && populationCost([...exampleMessages, replacement]) <= options.settings.contextLimitTokens) emptyUser = replacement;
    const currentUserId = history.findLast(message => message.role === "user")?.id;
    for (const message of populated.toReversed()) {
      let source = message.content;
      const command = /^\/([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i.exec(source.trim());
      if (command && message.sourceId) {
        const declaration = options.plugins.filter(plugin => plugin.enabled && plugin.permissions.includes("command:register"))
          .flatMap(plugin => plugin.contributes.commands).find(item => item.name === command[1]?.toLowerCase());
        if (declaration) source = substitute(declaration.prompt.replaceAll("{{args}}", command[2] ?? ""));
      }
      const content = manager.preparePrompt({ identifier: message.sourceId ?? message.injectionKey ?? "history", role: message.role, content: source }).content ?? "";
      const prepared = { ...message, content };
      if (populationCost([...exampleMessages, prepared, ...population]) > options.settings.contextLimitTokens) {
        // Protect the current input: the final budget will trim ordinary memory
        // first and explicitly reject if fixed prompts/pinned memory still do
        // not fit. Older history stops at its first rejected candidate, as ST.
        if (message.sourceId === currentUserId) population.unshift(prepared);
        diagnostics.push("历史消息超出剩余上下文预算，已停止纳入较早消息。"); break;
      }
      if (content || prepared.image) population.unshift(prepared);
      if (message.sourceId) preparedHistory.set(message.sourceId, content);
      else if (message.injectionKey) preparedInjections.set(message.injectionKey, content);
    }
    history = history.filter(message => population.some(prepared => prepared.sourceId === message.id))
      .map(message => ({ ...message, content: population.find(prepared => prepared.sourceId === message.id)?.content ?? message.content }));
  }
  if (powerUser?.pin_examples !== true) exampleMessages = prepareExamples();
  const serialize = ({ sourceId, injectionKey: _injectionKey, ...message }: PopulationMessage): ModelMessage => {
    const original=sourceId?options.history.find(item=>item.id===sourceId):undefined;
    const metadata=original?.status==="complete"?original.generationMetadata:undefined;
    const state=metadata?.responseState;
    return {...message,...(state?{responseState:{...state,model:state.model??metadata!.model}}:{}),
      ...(metadata?.toolRounds?.length&&original&&canReplayNativeCandidateTools(original)?{toolRounds:metadata.toolRounds}:{})};
  };
  const compose = () => {
    const result: ModelMessage[] = [];
    for (const prompt of prompts.collection) {
      if (prompt.identifier === "chatHistory") result.push(...additional.flatMap(item => item.messages),
        ...(newChat ? [{ role: "system" as const, content: newChat }] : []),
        ...population.filter(message => !message.sourceId || history.some(item => item.id === message.sourceId)).map(serialize),
        ...(emptyUser ? [emptyUser] : []));
      else if (prompt.identifier === "dialogueExamples") result.push(...exampleMessages);
      else if (groups.has(prompt.identifier)) result.push(...groups.get(prompt.identifier)!);
    }
    result.push(...continuationNudge.map(serialize),...controls.map(serialize));
    return result;
  };
  let messages = compose(), totalTokens = countCompatibilityMessagesSync(messages.map(message => materializePromptImage({ ...message })), options.settings.model, true) + reserveTokens;
  const recount = () => { messages = compose(); totalTokens = countCompatibilityMessagesSync(messages.map(message => materializePromptImage({ ...message })), options.settings.model, true) + reserveTokens; };
  for (const item of [...memory].filter(item => !item.pinned).sort((a, b) => a.score - b.score || b.memoryId.localeCompare(a.memoryId))) {
    if (totalTokens <= options.settings.contextLimitTokens) break;
    memory = memory.filter(value => value.memoryId !== item.memoryId); rebuildMemory();
    diagnostics.push(`请求消息超出上下文预算，已裁剪检索记忆 ${item.memoryId.slice(0, 8)}…。`); recount();
  }
  // Product budget policy: retain constant WI while ordinary entries can yield
  // to current input. Rebuild only unchanged, already-prepared WI bytes; a
  // macro/provider-transformed group cannot be safely split after evaluation.
  // Never execute new macro calls while changing the final admission budget.
  for (const entry of [...injected].filter(entry => entry.constant !== true && [0, 1].includes(entry.position ?? 1))
    .sort((a, b) => (a.insertionOrder ?? 0) - (b.insertionOrder ?? 0))) {
    if (totalTokens <= options.settings.contextLimitTokens) break;
    const position = entry.position ?? 1, identifier = position === 0 ? "worldInfoBefore" : "worldInfoAfter";
    const values = groups.get(identifier);
    if (!values?.length) continue;
    const format = (content: string) => !content ? "" : typeof settings.wi_format === "string" && settings.wi_format.trim()
      ? settings.wi_format.replace(/\{0\}/g, () => content) : content;
    if (values.length !== 1 || values[0]!.content !== format(world(position))) continue;
    injected = injected.filter(item => item.index !== entry.index);
    const content = format(world(position));
    groups.set(identifier, content ? [{ ...values[0]!, content }] : []);
    diagnostics.push(`请求消息超出上下文预算，已裁剪世界书条目「${entry.name}」。`); recount();
  }
  const currentUser = history.findLast(message => message.role === "user");
  for (const message of [...history]) {
    if (totalTokens <= options.settings.contextLimitTokens) break;
    if (message.id === currentUser?.id) continue;
    history = history.filter(item => item.id !== message.id); diagnostics.push(`请求消息超出上下文预算，已裁剪较早消息 ${message.id.slice(0, 8)}…。`); recount();
  }
  if (totalTokens > options.settings.contextLimitTokens) diagnostics.push(memory.some(item => item.pinned)
    ? "固定预设提示词、固定记忆与当前输入超出上下文上限；请提高上下文上限或缩短提示词。"
    : "固定预设提示词与当前输入超出上下文上限；请提高上下文上限或缩短提示词。");
  const regions: PromptBudgetRegion[] = [];
  const keyFor = (identifier: string): PromptBudgetRegion["key"] => identifier.startsWith("worldInfo")
    ? injected.filter(entry => (entry.position ?? 1) === (identifier === "worldInfoBefore" ? 0 : 1)).every(entry => entry.constant === true) ? "worldbook_constant" : "worldbook"
    : identifier === "jailbreak" ? "post_history"
    : ["main", "charDescription", "charPersonality", "scenario"].includes(identifier) ? "character_core" : "extension_prompts";
  const addRegion = (key: PromptBudgetRegion["key"], label: string, values: ModelMessage[]) => {
    const content = values.map(message => message.content).join("\n");
    if (!content) return;
    regions.push({ key, label, content, tokens: countTextTokens(content, options.settings.model) });
  };
  // Region diagnostics follow the actual emitted collection, including only
  // admitted absolute injections, example blocks and generation controls.
  for (const prompt of prompts.collection) {
    if (prompt.identifier === "chatHistory") {
      for (const item of additional) addRegion(item.key, item.label, item.messages);
      if (newChat) addRegion("extension_prompts", "新聊天标记", [{ role: "system", content: newChat }]);
      for (const message of population.filter(message => !message.sourceId)) addRegion("extension_prompts", "历史深度注入", [message]);
      if (emptyUser) addRegion("extension_prompts", "空用户消息替换", [emptyUser]);
    } else if (prompt.identifier === "dialogueExamples") addRegion("example_dialogue", "示例对话", exampleMessages);
    else addRegion(keyFor(prompt.identifier), prompt.identifier, groups.get(prompt.identifier) ?? []);
  }
  for (const message of [...continuationNudge,...controls]) addRegion("extension_prompts", "生成指令", [message]);
  const budget: PromptBudgetReport = { contextLimitTokens: options.settings.contextLimitTokens, reserveTokens,
    availableTokens: Math.max(0, options.settings.contextLimitTokens - reserveTokens), regions,
    recentMessages:continuationSource&&!history.some(message=>message.id===continuationSource.id)?[...history,continuationSource]:history,
    diagnostics, totalTokens, worldbookEntries: injected,
    retainedMemoryIds: memory.map(item => item.memoryId), memoryItems: memory.map(item => ({ id: item.memoryId,
      content: item.content, score: item.score, tokens: countTextTokens(item.content, options.settings.model),
      ...(item.pinned === undefined ? {} : { pinned: item.pinned }) })) };
  return { macroContext, budget, messages };
}
