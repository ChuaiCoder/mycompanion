/**
 * Data operations adapted from SillyTavern 1.19.0 PromptManager.js/openai.js,
 * commit 7e8663cd9c184a550b37238218bdd32c6efc68e9.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Adaptation: typed invocation-owned settings and substitution callback; DOM,
 * rendering, account state and the complete Tavern application are excluded.
 */

export const INJECTION_POSITION = { RELATIVE: 0, ABSOLUTE: 1 } as const;
export type PromptRole = "system" | "user" | "assistant";
export interface PromptDefinition {
  identifier: string;
  content?: string | undefined;
  role?: PromptRole | undefined;
  name?: string | undefined;
  system_prompt?: boolean | undefined;
  marker?: boolean | undefined;
  enabled?: boolean | undefined;
  position?: string | number | boolean | undefined;
  injection_depth?: number | undefined;
  injection_position?: number | undefined;
  injection_order?: number | undefined;
  forbid_overrides?: boolean | undefined;
  extension?: boolean | undefined;
  injection_trigger?: string[] | undefined;
}
export interface PromptOrderEntry { identifier: string; enabled: boolean }
export interface PromptManagerSettings {
  prompts: PromptDefinition[];
  prompt_order: Array<{ character_id: string | number; order: PromptOrderEntry[] }>;
  [key: string]: unknown;
}
export type SubstitutePrompt = (content: string | undefined, original?: string | null) => string;

/** Typed adaptation of openai.js parseExampleIntoIndividual. Preserve repeated
 * same-speaker lines as one message and switch only between user/bot modes.
 */
export function parseCompletionExample(messageExampleString: string, userName: string, characterName: string,
  groupNames: string[] = [], appendNamesForGroup = true, selectedGroup = false) {
  const groupBotNames = groupNames.map(name => `${name}:`);
  const result: Array<{ role: "system"; content: string; name: string }> = [];
  const lines = messageExampleString.split("\n");
  let current: string[] = [], inUser = false, inBot = false, botName = characterName;
  const add = (name: string, systemName: string) => {
    let content = current.join("\n").replace(name + ":", "").trim();
    if (appendNamesForGroup && selectedGroup) content = `${name}: ${content}`;
    result.push({ role: "system", content, name: systemName }); current = [];
  };
  for (const line of lines.slice(1)) {
    if (line.startsWith(userName + ":")) {
      inUser = true; if (inBot) add(botName, "example_assistant"); inBot = false;
    } else if (line.startsWith(characterName + ":") || groupBotNames.some(name => line.startsWith(name))) {
      if (!line.startsWith(characterName + ":") && groupBotNames.length) botName = line.split(":")[0]!;
      inBot = true; if (inUser) add(userName, "example_user"); inUser = false;
    }
    current.push(line);
  }
  if (inUser) add(userName, "example_user"); else if (inBot) add(botName, "example_assistant");
  return result;
}

/** Product import fallback: only known speaker names with a full-width colon
 * are normalized, and only when the unmodified Tavern parser found no speaker.
 * Keep parseCompletionExample itself exact for the public Tavern API.
 */
export function parseCompatibleCompletionExample(text: string, userName: string, characterName: string) {
  const strict = parseCompletionExample(text, userName, characterName);
  if (strict.length) return strict;
  const normalized = text.split("\n").map(line => {
    for (const name of [userName, characterName]) if (line.startsWith(name + "：")) return name + ":" + line.slice(name.length + 1);
    return line;
  }).join("\n");
  return normalized === text ? strict : parseCompletionExample(normalized, userName, characterName);
}

export class Prompt implements PromptDefinition {
  enabled?: boolean; marker?: boolean;
  identifier: string; role: PromptRole | undefined; content: string | undefined; name: string | undefined;
  system_prompt: boolean | undefined; position: string | number | boolean | undefined;
  injection_depth: number | undefined; injection_position: number | undefined;
  forbid_overrides: boolean | undefined; extension: boolean; injection_order: number; injection_trigger: string[];
  constructor({ identifier, role, content, name, system_prompt, position, injection_depth, injection_position,
    forbid_overrides, extension, injection_order, injection_trigger }: PromptDefinition) {
    this.identifier = identifier; this.role = role; this.content = content; this.name = name;
    this.system_prompt = system_prompt; this.position = position; this.injection_depth = injection_depth;
    this.injection_position = injection_position; this.forbid_overrides = forbid_overrides;
    this.extension = extension ?? false; this.injection_order = injection_order ?? 100;
    this.injection_trigger = injection_trigger ?? [];
  }
}
export class PromptCollection {
  collection: Prompt[] = []; overriddenPrompts: string[] = [];
  constructor(...prompts: Prompt[]) { this.add(...prompts); }
  checkPromptInstance(...prompts: Prompt[]): void {
    for (const prompt of prompts) if (!(prompt instanceof Prompt)) throw new Error("Only Prompt instances can be added to PromptCollection");
  }
  add(...prompts: Prompt[]): void { this.checkPromptInstance(...prompts); this.collection.push(...prompts); }
  set(prompt: Prompt, position: number): void { this.checkPromptInstance(prompt); this.collection[position] = prompt; }
  get(identifier: string): Prompt | undefined { return this.collection.find(prompt => prompt.identifier === identifier); }
  index(identifier: string): number { return this.collection.findIndex(prompt => prompt.identifier === identifier); }
  has(identifier: string): boolean { return this.index(identifier) !== -1; }
  override(prompt: Prompt, position: number): void { this.set(prompt, position); this.overriddenPrompts.push(prompt.identifier); }
}

export const promptManagerDefaultPromptOrder: PromptOrderEntry[] = [
  { identifier: "main", enabled: true }, { identifier: "worldInfoBefore", enabled: true },
  { identifier: "personaDescription", enabled: true }, { identifier: "charDescription", enabled: true },
  { identifier: "charPersonality", enabled: true }, { identifier: "scenario", enabled: true },
  { identifier: "enhanceDefinitions", enabled: false }, { identifier: "nsfw", enabled: true },
  { identifier: "worldInfoAfter", enabled: true }, { identifier: "dialogueExamples", enabled: true },
  { identifier: "chatHistory", enabled: true }, { identifier: "jailbreak", enabled: true },
];
export const chatCompletionDefaultPrompts: { prompts: PromptDefinition[] } = { prompts: [
  { identifier: "main", name: "Main Prompt", role: "system", system_prompt: true,
    content: "Write {{char}}'s next reply in a fictional chat between {{charIfNotGroup}} and {{user}}." },
  { identifier: "nsfw", name: "Auxiliary Prompt", role: "system", system_prompt: true, content: "" },
  { identifier: "dialogueExamples", name: "Chat Examples", system_prompt: true, marker: true },
  { identifier: "jailbreak", name: "Post-History Instructions", role: "system", system_prompt: true, content: "" },
  { identifier: "chatHistory", name: "Chat History", system_prompt: true, marker: true },
  { identifier: "worldInfoAfter", name: "World Info (after)", system_prompt: true, marker: true },
  { identifier: "worldInfoBefore", name: "World Info (before)", system_prompt: true, marker: true },
  { identifier: "enhanceDefinitions", name: "Enhance Definitions", role: "system", system_prompt: true, marker: false,
    content: "If you have more knowledge of {{char}}, add to the character's lore and personality to enhance them but keep the Character Sheet's definitions absolute." },
  { identifier: "charDescription", name: "Char Description", system_prompt: true, marker: true },
  { identifier: "charPersonality", name: "Char Personality", system_prompt: true, marker: true },
  { identifier: "scenario", name: "Scenario", system_prompt: true, marker: true },
  { identifier: "personaDescription", name: "Persona Description", system_prompt: true, marker: true },
] };
export const chatCompletionPromptDefaults = {
  wi_format: "{0}", new_chat_prompt: "[Start a new Chat]", new_example_chat_prompt: "[Example Chat]",
  scenario_format: "{{scenario}}", personality_format: "{{personality}}", group_nudge_prompt: "[Write the next reply only as {{char}}.]",
  impersonation_prompt: "[Write your next reply from the point of view of {{user}}, using the chat history so far as a guideline for the writing style of {{user}}. Don't write as {{char}} or system. Don't describe actions of {{char}}.]",
  send_if_empty: "", names_behavior: 0,
  continue_nudge_prompt: "[Continue your last message without repeating its original content.]",
  continue_prefill: false, continue_postfix: " ",
};

export class PromptManager {
  activeCharacter: { id: string | number; group?: { members?: string[] } } | null = { id: 100001 };
  configuration = { promptOrder: { strategy: "global", dummyId: 100001 } };
  constructor(public serviceSettings: PromptManagerSettings, readonly substitute: SubstitutePrompt) {}
  getPromptOrderForCharacter(character: { id: string | number } | null): PromptOrderEntry[] {
    return !character ? [] : this.serviceSettings.prompt_order.find(list => String(list.character_id) === String(character.id))?.order ?? [];
  }
  getPromptOrderEntry(character: { id: string | number } | null, identifier: string): PromptOrderEntry | null {
    return this.getPromptOrderForCharacter(character).find(entry => entry.identifier === identifier) ?? null;
  }
  getPromptById(identifier: string): PromptDefinition | null {
    return this.serviceSettings.prompts.find(item => item && item.identifier === identifier) ?? null;
  }
  getPromptIndexById(identifier: string): number { return this.serviceSettings.prompts.findIndex(item => item.identifier === identifier); }
  isPromptDisabledForActiveCharacter(identifier: string): boolean {
    const promptOrderEntry = this.getPromptOrderEntry(this.activeCharacter, identifier);
    return promptOrderEntry ? !promptOrderEntry.enabled : false;
  }
  getActiveGroupCharacters(): string[] {
    return (this.activeCharacter?.group?.members ?? []).map(member => member && member.substring(0, member.lastIndexOf(".")));
  }
  isValidName(name: string): boolean { return /^[a-zA-Z0-9_]{1,64}$/.test(name); }
  sanitizeName(name: string): string { return name.replace(/[^a-zA-Z0-9_]/g, "_").substring(0, 64); }
  preparePrompt(prompt: PromptDefinition, original: string | null = null): Prompt {
    const preparedPrompt = new Prompt(prompt);
    // Single-character native prompts bind names through the invocation callback.
    // Browser group support can supply its own groupOverride in that callback.
    preparedPrompt.content = typeof original === "string" ? this.substitute(prompt.content, original) : this.substitute(prompt.content);
    return preparedPrompt;
  }
  shouldTrigger(prompt: PromptDefinition | null, generationType: string): boolean {
    if (!Array.isArray(prompt?.injection_trigger)) return true;
    if (!prompt.injection_trigger.length) return true;
    return prompt.injection_trigger.includes(generationType);
  }
  getPromptCollection(generationType = "normal"): PromptCollection {
    generationType = String(generationType || "normal").toLowerCase().trim();
    const promptCollection = new PromptCollection();
    const promptOrder = this.getPromptOrderForCharacter(this.activeCharacter);
    promptOrder.forEach(entry => {
      const prompt = this.getPromptById(entry.identifier);
      const allowedTrigger = entry.enabled && this.shouldTrigger(prompt, generationType);
      if (!prompt) return;
      if (allowedTrigger) promptCollection.add(this.preparePrompt(prompt));
      else if (entry.identifier === "main") {
        const replacementPrompt = structuredClone(prompt);
        replacementPrompt.content = "";
        promptCollection.add(this.preparePrompt(replacementPrompt));
      }
    });
    return promptCollection;
  }
}

export const promptManagerRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Preserve arbitrary persisted preset fields; only normalize executable data. */
export function readPromptManagerSettings(extensionSettings: Record<string, unknown>): PromptManagerSettings {
  const settings = promptManagerRecord(promptManagerRecord(extensionSettings.__mycompanion_openai).settings);
  const prompts: PromptDefinition[] = (Array.isArray(settings.prompts) ? settings.prompts : []).flatMap(value => {
    const prompt = promptManagerRecord(value);
    if (typeof prompt.identifier !== "string") return [];
    return [{ ...prompt, identifier: prompt.identifier } as PromptDefinition];
  });
  for (const prompt of chatCompletionDefaultPrompts.prompts) if (!prompts.some(item => item.identifier === prompt.identifier)) prompts.push(structuredClone(prompt));
  const prompt_order = Array.isArray(settings.prompt_order) ? settings.prompt_order.flatMap(value => {
    const list = promptManagerRecord(value);
    if (!["string", "number"].includes(typeof list.character_id) || !Array.isArray(list.order)) return [];
    return [{ character_id: list.character_id as string | number, order: list.order.flatMap(value => {
      const entry = promptManagerRecord(value);
      return typeof entry.identifier === "string" ? [{ identifier: entry.identifier, enabled: entry.enabled === true }] : [];
    }) }];
  }) : [];
  if (!prompt_order.some(list => String(list.character_id) === "100001" && list.order.length))
    prompt_order.push({ character_id: 100001, order: structuredClone(promptManagerDefaultPromptOrder) });
  return { ...chatCompletionPromptDefaults, ...settings, prompts, prompt_order };
}

export interface CompletionPromptSources {
  charDescription: string; charPersonality: string; scenario: string;
  worldInfoBefore: string; worldInfoAfter: string; personaDescription: string;
  systemPromptOverride: string; jailbreakPromptOverride: string;
  quietPrompt?: string; bias?: string;
  extensions: Array<{ key: string; value: string; position: number; role: number }>;
}
/** Same ordered substitutions and merges as preparePromptsForChatCompletion. */
export function prepareCompletionPrompts(manager: PromptManager, sources: CompletionPromptSources, type = "normal"): PromptCollection {
  const settings = manager.serviceSettings;
  const text = (key: string) => typeof settings[key] === "string" ? settings[key] : "";
  const scenario = sources.scenario && text("scenario_format") ? manager.substitute(text("scenario_format")) : sources.scenario;
  const personality = sources.charPersonality && text("personality_format") ? manager.substitute(text("personality_format")) : sources.charPersonality;
  const groupNudge = manager.substitute(text("group_nudge_prompt"));
  const impersonation = text("impersonation_prompt") ? manager.substitute(text("impersonation_prompt")) : "";
  const worldFormat = (value: string) => !value ? "" : !text("wi_format").trim() ? value : text("wi_format").replace(/\{0\}/g, () => value);
  const systemPrompts: PromptDefinition[] = [
    { role: "system", content: worldFormat(sources.worldInfoBefore), identifier: "worldInfoBefore" },
    { role: "system", content: worldFormat(sources.worldInfoAfter), identifier: "worldInfoAfter" },
    { role: "system", content: sources.charDescription, identifier: "charDescription" },
    { role: "system", content: personality, identifier: "charPersonality" },
    { role: "system", content: scenario, identifier: "scenario" },
    { role: "system", content: impersonation, identifier: "impersonate" },
    { role: "system", content: sources.quietPrompt, identifier: "quietPrompt" },
    { role: "system", content: groupNudge, identifier: "groupNudge" },
    { role: "assistant", content: sources.bias, identifier: "bias" },
  ];
  const known: Record<string, string> = { "1_memory": "summary", "2_floating_prompt": "authorsNote", "3_vectors": "vectorsMemory", "4_vectors_data_bank": "vectorsDataBank", chromadb: "smartContext" };
  const roles: PromptRole[] = ["system", "user", "assistant"];
  for (const [key, identifier] of Object.entries(known)) {
    const prompt = sources.extensions.find(prompt => prompt.key === key);
    if (!prompt?.value) continue;
    systemPrompts.push({ identifier, role: key === "3_vectors" || key === "chromadb" ? "system" : roles[prompt.role] ?? "system",
      content: prompt.value, position: prompt.position === 0 ? "end" : prompt.position === 2 ? "start" : false });
  }
  if (sources.personaDescription) systemPrompts.push({ role: "system", content: sources.personaDescription, identifier: "personaDescription" });
  const ignored = [...Object.keys(known), "PERSONA_DESCRIPTION", "QUIET_PROMPT", "DEPTH_PROMPT"];
  for (const prompt of sources.extensions) {
    if (ignored.includes(prompt.key) || !prompt.value || ![0, 2].includes(prompt.position)) continue;
    systemPrompts.push({ identifier: prompt.key.replace(/\W/g, "_"), position: prompt.position === 0 ? "end" : "start",
      role: roles[prompt.role] ?? "system", content: prompt.value, extension: true });
  }
  const prompts = manager.getPromptCollection(type);
  systemPrompts.forEach(prompt => {
    const collectionPrompt = prompts.get(prompt.identifier);
    if (collectionPrompt) {
      prompt.injection_position = collectionPrompt.injection_position ?? prompt.injection_position;
      prompt.injection_depth = collectionPrompt.injection_depth ?? prompt.injection_depth;
      prompt.injection_order = collectionPrompt.injection_order ?? prompt.injection_order;
      prompt.role = collectionPrompt.role ?? prompt.role;
    }
    const newPrompt = manager.preparePrompt(prompt);
    const markerIndex = prompts.index(prompt.identifier);
    if (markerIndex !== -1) prompts.collection[markerIndex] = newPrompt;
    else prompts.add(newPrompt);
  });
  for (const [identifier, override] of [["main", sources.systemPromptOverride], ["jailbreak", sources.jailbreakPromptOverride]] as const) {
    const prompt = prompts.get(identifier);
    if (override && prompt && prompt.forbid_overrides !== true && !manager.isPromptDisabledForActiveCharacter(identifier)) {
      const original = prompt.content ?? "";
      prompt.content = override;
      prompts.override(manager.preparePrompt(prompt, original), prompts.index(identifier));
    }
  }
  return prompts;
}
