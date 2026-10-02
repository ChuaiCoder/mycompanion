import { expect, it, vi } from "vitest";
import type { CharacterMacroFieldSources } from "@mycompanion/shared";
import { MacroEvaluationSession, resolveMacros } from "./prompt-macros.js";
import { buildApp } from "./app.js";
import { apps } from "./test-helpers.js";

const order = ["system", "mesExamples", "description", "personality", "persona", "scenario", "jailbreak", "charDepthPrompt", "creatorNotes", "firstMessage", "alternateGreetings"];
const sources: CharacterMacroFieldSources = Object.fromEntries(order.map(name => [name,
  name === "alternateGreetings" ? [`${name}={{incvar::runs}}{{addvar::trace::${name}>}}`]
    : `${name}={{incvar::runs}}{{addvar::trace::${name}>}}`])) as CharacterMacroFieldSources;
sources.version = "{{incvar::versionEffect}}";

it.each([false, true])("constructs independent native card environments with the browser eager/lazy contract (experimental=%s)", experimental => {
  const session = new MacroEvaluationSession();
  const context = { characterName: "Actor", userName: "Reader", experimentalMacroEngine: experimental, characterFieldSources: sources };
  expect(session.evaluate("", context)).toBe("");
  expect(session.local).toEqual({});
  expect(session.evaluate("plain", context)).toBe("plain");
  expect(session.local.runs ?? 0).toBe(experimental ? 0 : 11);
  expect(session.local.trace ?? "").toBe(experimental ? "" : order.map(name => name + ">").join(""));
  expect(session.evaluate("{{description}}/{{description}}", context)).toBe(experimental
    ? "description=1/description=1" : "description=14/description=14");
  expect(session.local.runs).toBe(experimental ? 1 : 22);
  expect(session.evaluate("{{description}}", context)).toBe(experimental ? "description=2" : "description=25");
  expect(session.local.runs).toBe(experimental ? 2 : 33);
  expect(session.local.versionEffect).toBeUndefined();
});

it.each([false, true])("disables recursive card reads during native base replacement and keeps field normalization order (experimental=%s)", experimental => {
  const session = new MacroEvaluationSession();
  const context = { characterName: "Actor", userName: "Reader", experimentalMacroEngine: experimental,
    collapseNewlines: true, characterFieldSources: { description: "  \r\n{{user}}/{{char}}\r\n\n\nX\r\n  ",
      creatorNotes: "{{incvar::notes}}" } };
  expect(session.evaluate("{{description}}", context)).toBe("Reader/Actor\nX");
  expect(session.local.notes).toBe(experimental ? undefined : 1);
  expect(session.evaluate("x{{description}}y", { ...context, replaceCharacterCard: false })).toBe(experimental ? "xy" : "x{{description}}y");
  expect(session.local.notes).toBe(experimental ? undefined : 1);
  const recursive = { ...context, characterFieldSources: { description: "before{{description}}after" } };
  expect(session.evaluate("{{description}}", recursive)).toBe(experimental ? "beforeafter" : "before{{description}}after");
  // Removing CR before collapsing LF would lose the second newline in this case.
  expect(session.evaluate("{{description}}", { ...context, characterFieldSources: { description: "A\n\r\nB" } })).toBe("A\n\nB");
});

it.each([false, true])("resolves native card fields, examples and version through their engine's real aliases (experimental=%s)", experimental => {
  const context = { characterName: "Actor", userName: "Reader", experimentalMacroEngine: experimental,
    characterFieldSources: { system: "System {{char}}", jailbreak: "PHI", description: "Description", personality: "Personality",
      scenario: "Scenario", persona: "Persona", mesExamples: "{{char}}: hi\n<START>\n{{user}}: yes",
      charDepthPrompt: "Depth", creatorNotes: "Notes", version: "v2", firstMessage: "First", alternateGreetings: ["Alternative"] } };
  expect(resolveMacros("{{charPrompt}}|{{charInstruction}}|{{description}}|{{personality}}|{{scenario}}|{{persona}}|" +
    "{{mesExamplesRaw}}|{{mesExamples}}|{{charDepthPrompt}}|{{creatorNotes}}|{{charVersion}}/{{char_version}}", context))
    .toBe("System Actor|PHI|Description|Personality|Scenario|Persona|Actor: hi\n<START>\nReader: yes|<START>\nActor: hi\n<START>\nReader: yes\n|Depth|Notes|v2/v2");
  if (experimental) {
    expect(resolveMacros("{{charDescription}}/{{charPersonality}}/{{charScenario}}/{{charCreatorNotes}}/{{version}}/{{greeting::1}}", context))
      .toBe("Description/Personality/Scenario/Notes/v2/Alternative");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveMacros("{{greeting::invalid}}", context)).toBe("{{greeting::invalid}}");
    expect(warning).toHaveBeenCalled(); warning.mockRestore();
  } else {
    expect(resolveMacros("{{charJailbreak}}/{{greeting::1}}", context)).toBe("PHI/{{greeting::1}}");
  }
});

it("keeps the new native field environment lazy inside a scoped conditional and reads variable effects from that field", () => {
  const session = new MacroEvaluationSession();
  const context = { characterName: "Actor", experimentalMacroEngine: true, characterFieldSources: {
    description: "{{incvar::descriptionEffect}}", personality: "{{incvar::unusedEffect}}", version: "{{incvar::versionEffect}}" } };
  expect(session.evaluate("{{if false}}{{personality}}{{else}}{{description}}/{{description}}{{/if}}/{{getvar::descriptionEffect}}", context))
    .toBe("1/1/1");
  expect(session.local).toEqual({ descriptionEffect: 1 });
});

it.each([false, true])("binds actual selected card fields for public assembly without a native first-card stage (experimental=%s)", async experimental => {
  const app = buildApp(); apps.push(app);
  const avatar = (await app.inject({ method: "POST", url: "/api/characters/create", payload: {
    ch_name: "Actual actor", description: "ACTUAL_CARD {{user}}", first_mes: "Hello",
  } })).body;
  const character = (await app.inject({ method: "POST", url: "/api/characters/get", payload: { avatar_url: avatar } })).json();
  const story = (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } })).json();
  await app.inject({ method: "PUT", url: "/api/extensions/settings", payload: {
    extensionSettings: { __mycompanion_power_user: { experimental_macro_engine: experimental } },
  } });
  const response = await app.inject({ method: "POST", url: `/api/conversations/${story.id}/extension-prompt-assembly`, payload: {
    charDescription: "{{description}}", charPersonality: "", scenario: "", systemPromptOverride: "", jailbreakPromptOverride: "",
    personaDescription: "", messages: [{ role: "user", content: "input" }],
  } });
  expect(response.statusCode, response.body).toBe(200);
  const text = response.json().messages.map((message: { content: string }) => message.content).join("\n");
  expect(text).toContain("ACTUAL_CARD User");
  expect(text).not.toContain("{{description}}");
});
