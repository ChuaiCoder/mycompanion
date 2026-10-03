import { expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { createTestCharacter } from "./native-fixtures.js";
import { apps, sseResponse } from "./test-helpers.js";
import { readFileSync } from "node:fs";

type PromptMessage = { role: string; content: string };

async function fixture(experimental: boolean, card: Record<string, unknown> = {}) {
  const app = buildApp(); apps.push(app);
  const character = await createTestCharacter(app, { ch_name: "Character macro phases", first_mes: "Opening", ...card });
  const story = (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } })).json();
  const provider = await app.inject({ method: "PUT", url: "/api/settings/provider", payload: {
    kind: "ollama", baseUrl: "http://provider.test/v1", model: "gpt-4o", contextLimitTokens: 4096, maxTokens: 128,
  } });
  expect(provider.statusCode, provider.body).toBe(200);
  const saved = await app.inject({ method: "PUT", url: "/api/extensions/settings", payload: { extensionSettings: {
    __mycompanion_power_user: { experimental_macro_engine: experimental, prefer_character_prompt: true, prefer_character_jailbreak: true },
  } } });
  expect(saved.statusCode, saved.body).toBe(200);
  const chat = async () => (await app.inject({ method: "GET", url: `/api/conversations/${story.id}` })).json();
  const extensionSettings = async () => (await app.inject({ method: "GET", url: "/api/extensions/settings" })).json().extensionSettings;
  const selectBook = async (entries: Record<string, unknown>) => {
    const edit = await app.inject({ method: "POST", url: "/api/worldinfo/edit", payload: { name: "character-macro-phases", data: { entries } } });
    expect(edit.statusCode, edit.body).toBe(200);
    const current = (await app.inject({ method: "GET", url: "/api/worldinfo/settings" })).json();
    const selected = await app.inject({ method: "PUT", url: "/api/worldinfo/settings", payload: {
      ...current, world_info: { globalSelect: ["character-macro-phases"], charLore: [] },
    } });
    expect(selected.statusCode, selected.body).toBe(200);
  };
  return { app, character, story, chat, extensionSettings, selectBook };
}

const field = (label: string, counter: string) => `${label}={{incvar::phase}}/{{incvar::${counter}}}{{addvar::trace::${label}>}}`;
const counters = ["systemRuns", "exampleRuns", "descriptionRuns", "personalityRuns", "personaRuns", "scenarioRuns",
  "jailbreakRuns", "depthRuns", "notesRuns", "firstRuns", "alternateRuns"];
const firstReadTrace = "S>E>D>P>PERSONA>SCENARIO>PHI>DEPTH>NOTES>FIRST>ALT>";
const references = (JSON.parse(readFileSync(new URL("./fixtures/prompt-population-upstream-reference.json", import.meta.url), "utf8")) as {
  cases: Array<{ mode: string; experimental: boolean; round: number; messages: PromptMessage[]; variables: Record<string, unknown> }>;
}).cases;
const reference = (mode: string, round: number, experimental: boolean) => references.find(item => item.mode === mode && item.round === round && item.experimental === experimental)!;
const worldSnapshot = "WORLD={{getvar::phase}};" + counters.map(key => `${key}={{getvar::${key}}}`).join(";") + ";TRACE={{getvar::trace}}";

function assertSnapshot(messages: PromptMessage[], round: number, experimental: boolean) {
  // Frozen outputs from actual unmodified upstream population functions, not
  // snapshots copied from this service. Includes later PM/history passes.
  expect(messages).toEqual(reference("native", round, experimental).messages);
}

it.each([false])("prepares the complete first character snapshot before WI and commits the generation draft (experimental=%s)", async experimental => {
  const f = await fixture(experimental, {
    system_prompt: field("S", "systemRuns"), mes_example: field("E", "exampleRuns"),
    description: field("D", "descriptionRuns"), personality: field("P", "personalityRuns"),
    scenario: field("SCENARIO", "scenarioRuns"), post_history_instructions: field("PHI", "jailbreakRuns"),
    extensions: { depth_prompt: { prompt: field("DEPTH", "depthRuns"), depth: 2, role: "system" } },
    creator_notes: field("NOTES", "notesRuns"), first_mes: field("FIRST", "firstRuns"),
    alternate_greetings: [field("ALT", "alternateRuns")], character_version: "{{incvar::versionRuns}}",
  });
  const settings = await f.extensionSettings();
  settings.__mycompanion_power_user.persona_description = field("PERSONA", "personaRuns");
  settings.__mycompanion_power_user.persona_description_position = 0;
  const updated = await f.app.inject({ method: "PUT", url: "/api/extensions/settings", payload: { extensionSettings: settings } });
  expect(updated.statusCode, updated.body).toBe(200);
  await f.selectBook({
    1: { uid: 1, constant: true, key: [], content: worldSnapshot, position: 1 },
    2: { uid: 2, key: ["/D=\\d+\\/\\d+/"], content: "MATCHED_DESCRIPTION={{getvar::descriptionRuns}}", position: 1,
      matchCharacterDescription: true },
  });
  const before = await f.chat(), initialSettings = await f.extensionSettings();
  const preview = await f.app.inject({ method: "POST", url: `/api/conversations/${f.story.id}/prompt-preview`, payload: {} });
  expect(preview.statusCode, preview.body).toBe(200);
  assertSnapshot(preview.json().messages, 1, experimental);
  expect.soft(await f.chat()).toEqual(before);
  expect.soft(await f.extensionSettings()).toEqual(initialSettings);

  const sent: Array<{ messages: PromptMessage[] }> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body))); return sseResponse(["reply"]);
  }));
  const normal = await f.app.inject({ method: "POST", url: `/api/conversations/${f.story.id}/messages`, payload: { content: "", allowEmpty: true } });
  expect(normal.statusCode, normal.body).toBe(200);
  expect(sent).toHaveLength(1);
  assertSnapshot(sent[0]!.messages, 1, experimental);
  expect.soft(sent[0]!.messages).toEqual(preview.json().messages);
  const afterNormal = await f.chat();
  expect.soft(afterNormal.chatMetadata.variables).toEqual(reference("native", 1, experimental).variables);
  expect.soft(afterNormal.messages).toHaveLength(before.messages.length + 1);
  expect.soft(await f.extensionSettings()).toEqual(initialSettings);
});

it.each([false, true])("scans public globalScanData as literal prepared text without repeated macro effects (experimental=%s)", async experimental => {
  const f = await fixture(experimental, { description: "IMPLICIT_CARD_SCAN" });
  await f.selectBook({
    1: { uid: 1, key: ["1"], content: "MUST_NOT_MATCH", position: 1, matchCharacterDescription: true },
    2: { uid: 2, key: ["IMPLICIT_CARD_SCAN"], content: "MUST_NOT_READ_CARD", position: 1, matchCharacterDescription: true },
  });
  const before = await f.chat(), settings = await f.extensionSettings();
  const scan = await f.app.inject({ method: "POST", url: "/api/worldinfo/prompt", payload: {
    chat: [], maxContext: 4096, characterId: f.character.id, conversationId: f.story.id, commitVariables: true,
    globalScanData: { characterDescription: "{{incvar::scanEffects}}" },
  } });
  expect(scan.statusCode, scan.body).toBe(200);
  expect.soft(scan.json().report.results[0].status).toBe("no_match");
  expect.soft(scan.json().report.block).toBe("");
  expect.soft(scan.json().macroChanges).toEqual([]);
  expect.soft(await f.chat()).toEqual(before);
  expect.soft(await f.extensionSettings()).toEqual(settings);
  // ST's default scanData has empty fields; omitting data is not permission to
  // look up and scan raw card fields behind the public caller's back.
  const defaults = await f.app.inject({ method: "POST", url: "/api/worldinfo/prompt", payload: {
    chat: [], maxContext: 4096, characterId: f.character.id, conversationId: f.story.id, commitVariables: true,
  } });
  expect(defaults.statusCode, defaults.body).toBe(200);
  expect.soft(defaults.json().report.block).toBe("");
  expect.soft(defaults.json().report.results.every((entry: { status: string }) => entry.status === "no_match")).toBe(true);
  expect.soft(defaults.json().macroChanges).toEqual([]);
  expect.soft(await f.chat()).toEqual(before);
});

it.each([false])("honors preferences, normalizes card text and evaluates duplicate greetings separately (experimental=%s)", async experimental => {
  const duplicate = "DUPLICATE={{incvar::duplicateRuns}}";
  const f = await fixture(experimental, {
    description: "  DES\rCRIPTION\n\n\n\nTAIL {{incvar::descriptionRuns}}  ",
    system_prompt: "ORIGINAL_SYSTEM{{incvar::originalSystem}}",
    post_history_instructions: "DISABLED_PHI{{incvar::disabledPhi}}",
    mes_example: "ORIGINAL_EXAMPLE{{incvar::originalExample}}",
    scenario: "ORIGINAL_SCENARIO{{incvar::originalScenario}}",
    alternate_greetings: [duplicate, duplicate],
  });
  const settings = await f.extensionSettings();
  Object.assign(settings.__mycompanion_power_user, {
    prefer_character_prompt: false, prefer_character_jailbreak: false, collapse_newlines: true,
  });
  const updated = await f.app.inject({ method: "PUT", url: "/api/extensions/settings", payload: { extensionSettings: settings } });
  expect(updated.statusCode, updated.body).toBe(200);
  await f.selectBook({
    1: { uid: 1, constant: true, key: [], position: 1,
      content: "COUNTERS={{getvar::exampleRuns}}/{{getvar::descriptionRuns}}/{{getvar::scenarioRuns}}/{{getvar::duplicateRuns}}" },
    2: { uid: 2, key: ["/DESCRIPTION\\nTAIL 1/"], content: "MATCHED_NORMALIZED_DESCRIPTION", position: 1, matchCharacterDescription: true },
  });
  const before = await f.chat(), initialSettings = await f.extensionSettings();
  const preview = await f.app.inject({ method: "POST", url: `/api/conversations/${f.story.id}/prompt-preview`, payload: {} });
  expect(preview.statusCode, preview.body).toBe(200);
  const assertText = (messages: PromptMessage[]) => {
    const text = messages.map(message => message.content).join("\n");
    expect.soft(text).toContain("DESCRIPTION\nTAIL 1");
    expect.soft(text).toContain("COUNTERS=");
    expect.soft(text).toContain("MATCHED_NORMALIZED_DESCRIPTION");
    expect.soft(text).not.toContain("\r");
    for (const marker of ["ORIGINAL_SYSTEM", "DISABLED_PHI", "ORIGINAL_EXAMPLE"])
      expect.soft(text).not.toContain(marker);
  };
  assertText(preview.json().messages);
  expect.soft(await f.chat()).toEqual(before);
  expect.soft(await f.extensionSettings()).toEqual(initialSettings);
});
