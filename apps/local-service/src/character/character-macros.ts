import {
  createCharacterMacroFieldsLazy, readCharacterMacroFields,
  type CharacterDetail, type ProviderSettings, type ExtensionPrompt,
} from "@mycompanion/shared";
import { getPersonaDescription, getPersonaUserName, POWER_USER_SETTINGS_KEY } from "../prompt/power-user-core.js";
import { MacroEvaluationSession, macroVariableStores } from "../prompt/prompt-macros.js";

/** Bind the selected raw card for later independent substituteParams calls.
 * Public assembly binds this environment without performing native first-card
 * preparation: each actual macro call still owns its own eager/lazy snapshot.
 */
export function bindCharacterMacroEnvironment(
  character: CharacterDetail,
  metadata: Record<string, unknown>,
  settings: Record<string, unknown>,
  provider: ProviderSettings,
  session: MacroEvaluationSession,
) {
  const rawPowerUser = settings[POWER_USER_SETTINGS_KEY];
  const powerUser = rawPowerUser && typeof rawPowerUser === "object" && !Array.isArray(rawPowerUser)
    ? rawPowerUser as Record<string, unknown> : {};
  const depth = character.rawExtensions.depth_prompt;
  const sources = {
    system: powerUser.prefer_character_prompt !== false ? character.systemPrompt : "",
    mesExamples: character.exampleDialogue,
    description: character.description,
    personality: character.personality,
    persona: getPersonaDescription(settings, metadata)?.content ?? "",
    scenario: character.scenario,
    jailbreak: powerUser.prefer_character_jailbreak !== false ? character.postHistoryInstructions : "",
    version: character.characterVersion,
    charDepthPrompt: depth && typeof depth === "object" && "prompt" in depth && typeof depth.prompt === "string" ? depth.prompt.trim() : "",
    creatorNotes: character.creatorNotes,
    firstMessage: character.firstMessage,
    alternateGreetings: character.alternateGreetings,
  };
  const context = {
    characterName: character.name,
    userName: getPersonaUserName(settings, metadata),
    model: provider.model,
    contextLimitTokens: provider.contextLimitTokens,
    maxResponseTokens: provider.maxTokens,
    ...macroVariableStores(metadata, settings),
  };
  session.bindCharacterEnvironment({ characterFieldSources: sources, collapseNewlines: powerUser.collapse_newlines === true });
  return { sources, context, collapseNewlines: powerUser.collapse_newlines === true };
}

/** Native Generate installs its prepared character note as DEPTH_PROMPT before WI. */
export function buildCharacterDepthPrompt(character: CharacterDetail, content: string,
  settings: Record<string, unknown>): ExtensionPrompt | null {
  if (!content) return null;
  const data = character.rawExtensions.depth_prompt;
  const depth = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const note = settings.note && typeof settings.note === "object" ? settings.note as Record<string, unknown> : {};
  const value = depth.role;
  const role = value === "user" || value === 1 ? 1 : value === "assistant" || value === 2 ? 2 : 0;
  return { key: "DEPTH_PROMPT", value: content, position: 1,
    depth: typeof depth.depth === "number" && Number.isFinite(depth.depth) ? Math.max(0, Math.trunc(depth.depth)) : 4,
    role, scan: Boolean(note.allowWIScan), macrosResolved: true };
}

/** Prepare the first complete card read, before native world-info scanning. */
export function prepareCharacterMacroFields(
  character: CharacterDetail,
  metadata: Record<string, unknown>,
  settings: Record<string, unknown>,
  provider: ProviderSettings,
  session: MacroEvaluationSession,
) {
  const { sources, context, collapseNewlines } = bindCharacterMacroEnvironment(character, metadata, settings, provider, session);
  // This cache identifies a first-card stage, not arbitrary independent macro
  // calls. Evaluate each occurrence, including identical alternate greetings.
  return session.readCharacterFields(JSON.stringify([sources, context]), () =>
    readCharacterMacroFields(createCharacterMacroFieldsLazy(sources, text => {
      if (!text) return "";
      let value = session.evaluate(text, { ...context, replaceCharacterCard: false });
      if (collapseNewlines) value = value.replace(/\n+/g, "\n");
      return value.replace(/\r/g, "");
    })));
}
