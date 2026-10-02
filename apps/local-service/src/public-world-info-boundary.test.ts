import { expect, it } from "vitest";
import { buildApp } from "./app.js";
import { apps } from "./test-helpers.js";
import { countCompatibilityMessagesSync } from "./tokenizer-service.js";
import { CONTEXT_RESERVE_TOKENS } from "./prompt-budget.js";

const cases: Array<{ name: string; supplied: Record<string, string | null>; expected: string[] }> = [
  { name: "omitted", supplied: {}, expected: [] },
  { name: "explicit empty", supplied: { worldInfoBefore: "", worldInfoAfter: "" }, expected: [] },
  { name: "before empty", supplied: { worldInfoBefore: "" }, expected: [] },
  { name: "after empty", supplied: { worldInfoAfter: "" }, expected: [] },
  { name: "null", supplied: { worldInfoBefore: null, worldInfoAfter: null }, expected: [] },
  { name: "before only", supplied: { worldInfoBefore: "SUPPLIED_BEFORE" }, expected: ["SUPPLIED_BEFORE"] },
  { name: "after only", supplied: { worldInfoAfter: "SUPPLIED_AFTER" }, expected: ["SUPPLIED_AFTER"] },
  { name: "both", supplied: { worldInfoBefore: "SUPPLIED_BEFORE", worldInfoAfter: "SUPPLIED_AFTER" }, expected: ["SUPPLIED_BEFORE", "SUPPLIED_AFTER"] },
];

for (const experimental of [false, true]) {
  it.each(cases)(`uses only caller-supplied WI during public assembly: $name (experimental=${experimental})`, async ({ supplied, expected }) => {
    const app = buildApp(); apps.push(app);
    const avatar = (await app.inject({ method: "POST", url: "/api/characters/create", payload: {
      ch_name: "Public WI boundary", description: "CARD_ANCHOR", first_mes: "Hello",
    } })).body;
    const character = (await app.inject({ method: "POST", url: "/api/characters/get", payload: { avatar_url: avatar } })).json();
    const story = (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } })).json();
    await app.inject({ method: "PUT", url: "/api/settings/provider", payload: {
      kind: "ollama", baseUrl: "http://provider.test/v1", model: "gpt-4o", maxTokens: 128, contextLimitTokens: 4096,
    } });
    await app.inject({ method: "PUT", url: "/api/extensions/settings", payload: {
      extensionSettings: { __mycompanion_power_user: { experimental_macro_engine: experimental } },
    } });
    const book = await app.inject({ method: "POST", url: "/api/worldinfo/edit", payload: {
      name: "public-wi-boundary", data: { entries: {
        1: { uid: 1, constant: true, key: [], content: "UNREQUESTED_WORLD={{incvar::worldReads}}/{{incglobalvar::worldGlobals}}", position: 1 },
      } },
    } });
    expect(book.statusCode, book.body).toBe(200);
    const worldSettings = (await app.inject({ method: "GET", url: "/api/worldinfo/settings" })).json();
    const selected = await app.inject({ method: "PUT", url: "/api/worldinfo/settings", payload: {
      ...worldSettings, world_info: { globalSelect: ["public-wi-boundary"], charLore: [] },
    } });
    expect(selected.statusCode, selected.body).toBe(200);
    const chat = async () => (await app.inject({ method: "GET", url: `/api/conversations/${story.id}` })).json();
    const settings = async () => (await app.inject({ method: "GET", url: "/api/extensions/settings" })).json().extensionSettings;
    const before = await chat(), initialSettings = await settings();
    // A positive control proves this selected constant entry is executable.
    // Scanning is a separate public call; this read-only draft is not assembly input.
    const scan = await app.inject({ method: "POST", url: "/api/worldinfo/prompt", payload: {
      chat: [], maxContext: 4096, characterId: character.id, conversationId: story.id, commitVariables: false,
    } });
    expect(scan.statusCode, scan.body).toBe(200);
    expect(scan.json().report.block).toBe("UNREQUESTED_WORLD=1/1");
    expect(await chat()).toEqual(before);
    expect(await settings()).toEqual(initialSettings);

    const assembly = await app.inject({ method: "POST", url: `/api/conversations/${story.id}/extension-prompt-assembly`, payload: {
      messages: [{ role: "user", content: "input" }], commitVariables: true,
      extensionPrompts: [{ key: "scan-only", value: "UNREQUESTED_SCAN={{incvar::scanOnly}}", position: -1, scan: true, depth: 0, role: 0 }],
      ...supplied,
    } });
    expect(assembly.statusCode, assembly.body).toBe(200);
    const report = assembly.json(), text = report.messages.map((message: { content: string }) => message.content).join("\n");
    expect.soft(text).not.toContain("UNREQUESTED_WORLD");
    expect.soft(text).not.toContain("UNREQUESTED_SCAN");
    for (const marker of expected) expect.soft(text).toContain(marker);
    for (const marker of ["SUPPLIED_BEFORE", "SUPPLIED_AFTER"].filter(marker => !expected.includes(marker)))
      expect.soft(text).not.toContain(marker);
    if (expected.includes("SUPPLIED_BEFORE")) expect.soft(text.indexOf("SUPPLIED_BEFORE")).toBeLessThan(text.indexOf("CARD_ANCHOR"));
    if (expected.includes("SUPPLIED_AFTER")) expect.soft(text.indexOf("CARD_ANCHOR")).toBeLessThan(text.indexOf("SUPPLIED_AFTER"));
    const worldTokens = report.regions.filter((region: { key: string }) => ["worldbook", "worldbook_constant"].includes(region.key))
      .reduce((sum: number, region: { tokens: number }) => sum + region.tokens, 0);
    expect.soft(worldTokens > 0).toBe(expected.length > 0);
    expect.soft(report.totalTokens).toBe(countCompatibilityMessagesSync(report.messages, "gpt-4o", true) + 128 + CONTEXT_RESERVE_TOKENS);
    expect.soft(report.macroChanges).toEqual([]);
    expect.soft(await chat()).toEqual(before);
    expect.soft(await settings()).toEqual(initialSettings);
  });
}
