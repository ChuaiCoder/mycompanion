/** Raw sources for one character-card read. Version deliberately bypasses macros. */
export interface CharacterMacroFieldSources {
  system?: string;
  mesExamples?: string;
  description?: string;
  personality?: string;
  persona?: string;
  scenario?: string;
  jailbreak?: string;
  version?: string;
  charDepthPrompt?: string;
  creatorNotes?: string;
  firstMessage?: string;
  alternateGreetings?: string[];
}

export interface CharacterMacroFields {
  system: string;
  mesExamples: string;
  description: string;
  personality: string;
  persona: string;
  scenario: string;
  jailbreak: string;
  version: string;
  charDepthPrompt: string;
  creatorNotes: string;
  firstMessage: string;
  alternateGreetings: string[];
}

/** Cache only within this field object; every independent call gets new getters. */
export function createCharacterMacroFieldsLazy(
  sources: CharacterMacroFieldSources,
  replace: (text: string, field: keyof CharacterMacroFields) => string,
): CharacterMacroFields {
  const converted = (value: string | undefined, field: keyof CharacterMacroFields) =>
    replace(typeof value === "string" ? value.trim() : "", field) || "";
  // Match the public lazy object's order, separately from the eager read below.
  const readers = {
    persona: () => converted(sources.persona, "persona"),
    system: () => converted(sources.system, "system"),
    jailbreak: () => converted(sources.jailbreak, "jailbreak"),
    version: () => sources.version || "",
    charDepthPrompt: () => converted(sources.charDepthPrompt, "charDepthPrompt"),
    creatorNotes: () => converted(sources.creatorNotes, "creatorNotes"),
    description: () => converted(sources.description, "description"),
    personality: () => converted(sources.personality, "personality"),
    scenario: () => converted(sources.scenario, "scenario"),
    mesExamples: () => converted(sources.mesExamples, "mesExamples"),
    firstMessage: () => converted(sources.firstMessage, "firstMessage"),
    alternateGreetings: () => (sources.alternateGreetings ?? []).map(value => converted(value, "alternateGreetings")),
  };
  const fields = {} as CharacterMacroFields;
  for (const [key, read] of Object.entries(readers)) {
    let resolved = false, value: string | string[];
    Object.defineProperty(fields, key, { enumerable: true, get() {
      if (!resolved) { value = read(); resolved = true; }
      return value;
    } });
  }
  return fields;
}

/** SillyTavern 1.19.0 eager field order, including fields absent from the prompt. */
export function readCharacterMacroFields(fields: CharacterMacroFields): CharacterMacroFields {
  return {
    system: fields.system,
    mesExamples: fields.mesExamples,
    description: fields.description,
    personality: fields.personality,
    persona: fields.persona,
    scenario: fields.scenario,
    jailbreak: fields.jailbreak,
    version: fields.version,
    charDepthPrompt: fields.charDepthPrompt,
    creatorNotes: fields.creatorNotes,
    firstMessage: fields.firstMessage,
    alternateGreetings: fields.alternateGreetings,
  };
}
