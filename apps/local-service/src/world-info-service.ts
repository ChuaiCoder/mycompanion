import type { CharacterDetail, CharacterLorebookEntry, ChatMessage, ExtensionPrompt, LorebookReport, WorldInfoSettings } from "@mycompanion/shared";
import type { WorldInfoRepository } from "./world-info-repository.js";
import { matchLorebookEntries } from "./worldbook-engine.js";
import { macroVariableStores, resolveMacroField, MacroEvaluationSession } from "./prompt-macros.js";
import { collectNativeRegexScripts, type TavernRegexExecutor } from "./tavern-regex-service.js";
import { countTextTokens } from "./tokenizer-service.js";
import { createWorldInfoEffectsDraft, transferWorldInfoEffects } from "./world-info-effects.js";

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const number = (value: unknown, fallback: number): number => typeof value === "number" && Number.isFinite(value) ? value : fallback;
export type WorldInfoCharacter = Pick<CharacterDetail, "id" | "avatar" | "name" | "lorebookEnabled" | "rawExtensions" | "description" | "personality" | "scenario" | "creatorNotes">;

export function buildWorldInfoReport(
  books: WorldInfoRepository, character: WorldInfoCharacter, messages: ChatMessage[],
  metadata: Record<string, unknown>, maxContext: number,
  context: { chat?: string[]; settings?: WorldInfoSettings; globalScanData?: Record<string, string>; userName?: string;
    macroSession?: MacroEvaluationSession;
    model?: string;
    maxResponseTokens?: number;
    extensionSettings?: Record<string, unknown>;
    extensionScanText?: string;
    extensionScanTextResolved?: boolean;
    extensionScanPrompts?: ExtensionPrompt[];
    dryRun?: boolean;
    trigger?: string;
    worldInfoSourceMessages?: ChatMessage[];
    worldInfoBranchId?: string;
    onEntries?: (entries: CharacterLorebookEntry[]) => void } = {},
): LorebookReport {
  const variables = macroVariableStores(metadata, context.extensionSettings ?? {});
  const macroSession = context.macroSession ?? new MacroEvaluationSession(metadata, context.extensionSettings);
  const scanMacroContext = { characterName: character.name, userName: context.userName ?? "User",
    macroSession,
    contextLimitTokens: maxContext,
    ...(context.model === undefined ? {} : { model: context.model }),
    ...(context.maxResponseTokens === undefined ? {} : { maxResponseTokens: context.maxResponseTokens }),
    ...variables };
  const extensionScanText = context.extensionScanPrompts
    ? context.extensionScanPrompts.map(prompt => prompt.macrosResolved ? prompt.value
      : macroSession.evaluate(prompt.value, scanMacroContext)).join("\n")
    : context.extensionScanText
      ? context.extensionScanTextResolved ? context.extensionScanText
        : resolveMacroField(context.extensionScanText, scanMacroContext, "extension:scanText")
      : "";
  const settings = context.settings ?? books.settings();
  const visited = new Set<string>();
  let index = character.lorebookEnabled.reduce((max, entry) => Math.max(max, entry.index + 1), 0);
  function load(names: string[]): CharacterLorebookEntry[] {
    return names.flatMap(world => {
      if (visited.has(world)) return [];
      visited.add(world);
      const document = books.get(world);
      if (!document) return [];
      return Object.entries(document.entries).map(([uid, raw]) => ({
        index: index++, name: String(raw.comment || `${world} #${uid}`), keys: strings(raw.key), secondaryKeys: strings(raw.keysecondary),
        content: typeof raw.content === "string" ? raw.content : "", enabled: raw.disable !== true,
        constant: raw.constant === true, selective: raw.selective !== false, caseSensitive: false,
        insertionOrder: number(raw.order, 100), sourceEnabled: raw.disable !== true,
        worldInfo: { ...raw, uid: raw.uid ?? uid, world, position: number(raw.position, 0) },
      }));
    });
  }
  const sort = (entries: CharacterLorebookEntry[]) => entries.sort((a, b) => b.insertionOrder - a.insertionOrder);
  const globals = settings.world_info.globalSelect;
  const chatName = typeof metadata.world_info === "string" ? metadata.world_info : "";
  const powerUser = context.extensionSettings?.__mycompanion_power_user;
  const power = powerUser && typeof powerUser === "object" && !Array.isArray(powerUser) ? powerUser as Record<string, unknown> : {};
  const personas = power.personas && typeof power.personas === "object" ? power.personas as Record<string, unknown> : {};
  const selectedPersona = typeof metadata.persona === "string" && personas[metadata.persona] ? metadata.persona
    : typeof power.__selected_persona === "string" ? power.__selected_persona
    : typeof power.default_persona === "string" ? power.default_persona : "";
  const descriptions = power.persona_descriptions && typeof power.persona_descriptions === "object"
    ? power.persona_descriptions as Record<string, Record<string, unknown>> : {};
  const personaName = typeof descriptions[selectedPersona]?.lorebook === "string" ? descriptions[selectedPersona]!.lorebook as string
    : typeof power.persona_description_lorebook === "string" ? power.persona_description_lorebook : "";
  // ST reserves globally selected books first, then chat, persona, character.
  // Priority and duplicate ownership are separate decisions.
  const globalEntries = load(globals);
  const chat = globals.includes(chatName) ? [] : load(chatName ? [chatName] : []);
  const persona = globals.includes(personaName) || personaName === chatName ? [] : load(personaName ? [personaName] : []);
  const primary = character.rawExtensions.world;
  const charNames = [
    ...(typeof primary === "string" ? [primary] : []),
    ...settings.world_info.charLore.filter(binding => [character.id, character.name, character.avatar?.replace(/\.png$/i, "")].includes(binding.name)).flatMap(binding => binding.extraBooks),
  ];
  // A bound named book replaces its embedded snapshot, avoiding duplicate lore.
  const embedded = typeof primary === "string" && books.get(primary) ? [] : character.lorebookEnabled;
  const local = [...embedded, ...load(charNames.filter(name => !globals.includes(name) && name !== chatName && name !== personaName))];
  let general: CharacterLorebookEntry[];
  if (settings.world_info_character_strategy === 2) general = [...sort(globalEntries), ...sort(local)];
  else {
    general = settings.world_info_character_strategy === 0 ? sort([...globalEntries, ...local]) : [...sort(local), ...sort(globalEntries)];
  }
  let budget = Math.round(settings.world_info_budget * maxContext / 100) || 1;
  if (settings.world_info_budget_cap > 0) budget = Math.min(budget, settings.world_info_budget_cap);
  const entries = [...sort(chat), ...sort(persona), ...general];
  context.onEntries?.(entries);
  const sourceMessages = context.worldInfoSourceMessages ?? messages;
  const effectsDraft = createWorldInfoEffectsDraft(metadata, context.worldInfoBranchId ?? character.id, sourceMessages,
    context.chat?.length ?? sourceMessages.length);
  return matchLorebookEntries(character.id, entries, character.name, "", budget, {
    macroSession,
    messages: context.chat ?? messages.filter(message => (message.status === "complete" || message.status === "stopped") && message.extensionData?.is_system !== true)
      .map(message => (settings.world_info_include_names ? `${message.role === "user" ? context.userName ?? "User" : character.name}: ` : "") + message.content).reverse(),
    scanDepth: settings.world_info_depth, recursive: settings.world_info_recursive,
    maxRecursionSteps: settings.world_info_max_recursion_steps,
    minActivations: settings.world_info_min_activations,
    minActivationsDepthMax: settings.world_info_min_activations_depth_max,
    useGroupScoring: settings.world_info_use_group_scoring,
    caseSensitive: settings.world_info_case_sensitive, matchWholeWords: settings.world_info_match_whole_words,
    preservePriority: true,
    ...(context.model ? { model: context.model } : {}),
    contextLimitTokens: maxContext,
    ...(context.maxResponseTokens === undefined ? {} : { maxResponseTokens: context.maxResponseTokens }),
    userName: context.userName ?? "User",
    ...variables,
    effectsDraft,
    dryRun: context.dryRun ?? true,
    ...(context.trigger === undefined ? {} : { trigger: context.trigger }),
    characterFilename: character.avatar?.replace(/\.png$/i, "") ?? character.id,
    ...(extensionScanText ? { extensionScanText } : {}),
    // Public callers own their prepared scan data. Native generation explicitly
    // supplies its first card snapshot; omitted fields stay empty as in ST.
    ...(context.globalScanData === undefined ? {} : { globalScanData: context.globalScanData }),
  });
}

/** Pinned world-info.js applies placement 5 after every scan/activation/budget
 * decision, in descending insertion order. Rewritten content does not feed
 * recursion or the WI budget; the final provider budget measures its new bytes.
 */
export async function finalizeWorldInfoRegex(report: LorebookReport, executor: TavernRegexExecutor,
  character: CharacterDetail | undefined, metadata: Record<string, unknown>, extensionSettings: Record<string, unknown>,
  session: MacroEvaluationSession, context: { userName?: string; model?: string; contextLimitTokens?: number;
    maxResponseTokens?: number; signal?: AbortSignal } = {}): Promise<LorebookReport> {
  const scripts = character ? collectNativeRegexScripts(extensionSettings, character)
    : Array.isArray(extensionSettings.disabledExtensions) && extensionSettings.disabledExtensions.includes("regex") ? []
      : Array.isArray(extensionSettings.regex) ? extensionSettings.regex : [];
  const macroContext = { characterName: character?.name ?? "", userName: context.userName ?? "User",
    ...macroVariableStores(metadata, extensionSettings),
    ...(context.model === undefined ? {} : { model: context.model }),
    ...(context.contextLimitTokens === undefined ? {} : { contextLimitTokens: context.contextLimitTokens }),
    ...(context.maxResponseTokens === undefined ? {} : { maxResponseTokens: context.maxResponseTokens }) };
  const result = structuredClone(report);
  transferWorldInfoEffects(report, result);
  for (const entry of result.results.filter(entry => entry.status === "injected")
    .sort((a, b) => (b.insertionOrder ?? 0) - (a.insertionOrder ?? 0))) {
    entry.content = await executor.run(entry.content, 5, scripts, macroContext.characterName, {
      isMarkdown: false, isPrompt: true, ...(entry.position === 4 ? { depth: entry.depth ?? 4 } : {}),
      substitute: (value, escape, characterOverride) => session.evaluate(value, { ...macroContext,
        ...(characterOverride === undefined ? {} : { characterName: characterOverride }),
        ...(escape === undefined ? {} : { postProcessFn: escape }) }),
    }, context.signal, macroContext.userName);
    // Keep activation status, including an entry whose regex output is empty.
    entry.tokens = countTextTokens(entry.content, context.model);
  }
  const kept = result.results.filter(entry => entry.status === "injected")
    .sort((a, b) => (a.insertionOrder ?? 0) - (b.insertionOrder ?? 0));
  result.block = kept.map(entry => entry.content).filter(Boolean).join("\n\n");
  result.constantBlock = kept.filter(entry => entry.constant).map(entry => entry.content).filter(Boolean).join("\n\n");
  return result;
}
