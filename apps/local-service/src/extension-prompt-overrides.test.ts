import { expect, it } from "vitest";
import { buildApp } from "./app.js";
import { apps } from "./test-helpers.js";
import reference from "./fixtures/prompt-remaining-upstream-reference.json" with { type: "json" };

it.each([
  [false, false], [false, true],
])("preserves explicit public overrides and each engine's independent card environment (experimental=%s, suppliedWI=%s)",
  async (experimental, suppliedWI) => {
    const app = buildApp(); apps.push(app);
    const create = await app.inject({ method: "POST", url: "/api/characters/create", payload: {
      ch_name: "Public override", first_mes: "FIRST={{incvar::unusedFirst}}",
      description: "CARD={{incvar::unusedDescription}}", personality: "PERSONALITY={{incvar::unusedPersonality}}",
      scenario: "SCENARIO={{incvar::unusedScenario}}", mes_example: "EXAMPLES={{incvar::unusedExamples}}",
      system_prompt: "SAVED_SYSTEM={{incvar::unusedSystem}}", post_history_instructions: "SAVED_PHI={{incvar::unusedPhi}}",
      creator_notes: "NOTES={{incvar::unusedNotes}}", alternate_greetings: ["ALT={{incvar::unusedAlternate}}"],
      extensions: { depth_prompt: { prompt: "DEPTH={{incvar::unusedDepth}}", depth: 2, role: "system" } },
    } });
    expect(create.statusCode, create.body).toBe(200);
    const character = (await app.inject({ method: "POST", url: "/api/characters/get", payload: { avatar_url: create.body } })).json();
    const story = (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } })).json();
    const provider = { kind: "ollama", baseUrl: "http://provider.test/v1", model: "gpt-4o", contextLimitTokens: 4096, maxTokens: 128 };
    expect((await app.inject({ method: "PUT", url: "/api/settings/provider", payload: provider })).statusCode).toBe(200);
    const extensionSettings = { __mycompanion_power_user: { experimental_macro_engine: experimental,
      prefer_character_prompt: false, prefer_character_jailbreak: false,
      persona_description: "PERSONA={{incvar::unusedPersona}}", persona_description_position: 0 } };
    expect((await app.inject({ method: "PUT", url: "/api/extensions/settings", payload: { extensionSettings } })).statusCode).toBe(200);
    const before = (await app.inject({ method: "GET", url: `/api/conversations/${story.id}` })).json();
    const payload = {
      messages: [{ role: "user", content: "Input" }], messageExamples: [], extensionPrompts: [],
      charDescription: "Explicit description", charPersonality: "", scenario: "", personaDescription: "",
      systemPromptOverride: "SYSTEM={{incvar::systemOverride}}", jailbreakPromptOverride: "PHI={{incvar::phiOverride}}",
      commitVariables: true,
      ...(suppliedWI ? { worldInfoBefore: "", worldInfoAfter: "" } : {}),
    };
    for (const count of [1, 2]) {
      const assembled = await app.inject({ method: "POST", url: `/api/conversations/${story.id}/extension-prompt-assembly`, payload });
      expect(assembled.statusCode, assembled.body).toBe(200);
      const result = assembled.json();
      const text = JSON.stringify(result.messages);
      expect(text).toContain(`SYSTEM=${count}`); expect(text).toContain(`PHI=${count}`);
      expect(text).toContain("Explicit description"); expect(text).not.toContain("unused"); expect(text).not.toContain("SAVED_");
      const exact = (await app.inject({ method: "POST", url: "/api/extensions/token-count", payload: {
        messages: result.messages, model: provider.model, full: true,
      } })).json();
      expect(result.totalTokens).toBe(exact.token_count + provider.maxTokens + 512);
      const after = (await app.inject({ method: "GET", url: `/api/conversations/${story.id}` })).json();
      const oracle=reference.runs.find(run=>run.mode==="public-overrides"&&run.experimental===experimental&&run.round===count)!;
      expect(result.messages).toEqual(oracle.messages);
      expect(after.chatMetadata.variables).toEqual(oracle.variables);
      expect(after.messages).toEqual(before.messages);
    }
    expect((await app.inject({ method: "GET", url: "/api/extensions/settings" })).json().extensionSettings).toEqual(extensionSettings);
  });
