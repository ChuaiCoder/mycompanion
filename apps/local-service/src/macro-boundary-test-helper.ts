import type { CharacterDetail } from "@mycompanion/shared";
export function productCardForTests(name: string): CharacterDetail {
  const time = new Date().toISOString();
  return { id: crypto.randomUUID(), name, description: "", personality: "", scenario: "", firstMessage: "", exampleDialogue: "",
    systemPrompt: "", postHistoryInstructions: "", creatorNotes: "", alternateGreetings: [], characterVersion: "", rawExtensions: {},
    lorebookEnabled: [], regexEnabled: [], tags: [], creator: "", sourceFormat: "ccv2-json", sourceVersion: "2.0", unknownFieldPaths: [],
    alternateGreetingsCount: 0, lorebookEntries: [], regexScripts: [], lorebookEntryCount: 0, regexScriptCount: 0,
    deletedAt: null, createdAt: time, updatedAt: time };
}
