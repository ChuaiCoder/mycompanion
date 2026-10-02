// Data contracts only. No Tavern implementation or helper source is bundled.
export const newWorldInfoEntryTemplate: Record<string, unknown> = {
  key: [], keysecondary: [], comment: "", content: "", constant: false,
  vectorized: false, selective: true, selectiveLogic: 0, addMemo: false,
  order: 100, position: 0, disable: false, ignoreBudget: false,
  excludeRecursion: false, preventRecursion: false, delayUntilRecursion: 0,
  matchPersonaDescription: false, matchCharacterDescription: false,
  matchCharacterPersonality: false, matchCharacterDepthPrompt: false,
  matchScenario: false, matchCreatorNotes: false,
  probability: 100, useProbability: true, depth: 4, outletName: "",
  group: "", groupOverride: false, groupWeight: 100, scanDepth: null,
  caseSensitive: null, matchWholeWords: null, useGroupScoring: null,
  automationId: "", role: 0, sticky: null, cooldown: null, delay: null, triggers: [],
};

/** Self-contained so the service and browser can use exactly the same parser. */
export function parseRegexFromString(value: string): RegExp | null {
  if (typeof value !== "string" || !value.startsWith("/")) return null;
  const end = value.lastIndexOf("/");
  if (end <= 1) return null;
  const pattern = value.slice(1, end);
  for (let index = 0; index < pattern.length; index++) {
    if (pattern[index] === "\\") { index++; continue; }
    if (pattern[index] === "/") return null;
  }
  try { return new RegExp(pattern, value.slice(end + 1)); } catch { return null; }
}

export function convertCharacterBook(book: { entries: Record<string, unknown>[]; [key: string]: unknown }) {
  const entries: Record<string, Record<string, unknown>> = {};
  const extensionNames: Record<string, string> = {
    excludeRecursion: "exclude_recursion", preventRecursion: "prevent_recursion", delayUntilRecursion: "delay_until_recursion",
    outletName: "outlet_name", groupOverride: "group_override", groupWeight: "group_weight",
    scanDepth: "scan_depth", caseSensitive: "case_sensitive", matchWholeWords: "match_whole_words", useGroupScoring: "use_group_scoring",
    automationId: "automation_id", matchPersonaDescription: "match_persona_description", matchCharacterDescription: "match_character_description",
    matchCharacterPersonality: "match_character_personality", matchCharacterDepthPrompt: "match_character_depth_prompt",
    matchScenario: "match_scenario", matchCreatorNotes: "match_creator_notes", ignoreBudget: "ignore_budget",
  };
  book.entries.forEach((entry, index) => {
    if (entry.id === undefined) entry.id = index;
    const extensions = entry.extensions && typeof entry.extensions === "object" ? entry.extensions as Record<string, unknown> : {};
    const converted: Record<string, unknown> = JSON.parse(JSON.stringify(newWorldInfoEntryTemplate));
    for (const key of Object.keys(newWorldInfoEntryTemplate)) {
      const source = extensions[extensionNames[key] ?? key];
      if (source !== undefined && source !== null) converted[key] = source;
    }
    Object.assign(converted, {
      uid: entry.id, key: entry.keys, keysecondary: entry.secondary_keys || [],
      comment: entry.comment || "", content: entry.content, constant: entry.constant || false,
      selective: entry.selective || false, order: entry.insertion_order,
      position: extensions.position ?? (entry.position === "before_char" ? 0 : 1),
      disable: !entry.enabled, addMemo: Boolean(entry.comment), displayIndex: extensions.display_index ?? index,
      extensions,
    });
    Object.defineProperty(entries, String(entry.id), { value: converted, enumerable: true, writable: true, configurable: true });
  });
  return { entries, originalData: book };
}
