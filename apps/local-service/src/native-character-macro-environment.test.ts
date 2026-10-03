import { expect, it } from "vitest";
import type { CharacterMacroFieldSources } from "@mycompanion/shared";
import { MacroEvaluationSession, resolveMacros } from "./prompt-macros.js";
import { buildApp } from "./app.js";
import { createTestCharacter } from "./native-fixtures.js";
import { apps } from "./test-helpers.js";

const order = ["system", "mesExamples", "description", "personality", "persona", "scenario", "jailbreak", "charDepthPrompt", "creatorNotes", "firstMessage", "alternateGreetings"];
const sources: CharacterMacroFieldSources = Object.fromEntries(order.map(name => [name,
  name === "alternateGreetings" ? [`${name}={{incvar::runs}}{{addvar::trace::${name}>}}`]
    : `${name}={{incvar::runs}}{{addvar::trace::${name}>}}`])) as CharacterMacroFieldSources;
sources.version = "{{incvar::versionEffect}}";

it("constructs independent native card environments with the browser eager/lazy contract", () => {
  const session = new MacroEvaluationSession();
  const context = { characterName: "Actor", userName: "Reader", characterFieldSources: sources };
  expect(session.evaluate("", context)).toBe("");
  expect(session.local).toEqual({});
  expect(session.evaluate("plain", context)).toBe("plain");
  expect(session.local.runs ?? 0).toBe(11);
  expect(session.local.trace ?? "").toBe(order.map(name => name + ">").join(""));
  expect(session.evaluate("{{description}}/{{description}}", context)).toBe("description=14/description=14");
  expect(session.local.runs).toBe(22);
  expect(session.evaluate("{{description}}", context)).toBe("description=25");
  expect(session.local.runs).toBe(33);
  expect(session.local.versionEffect).toBeUndefined();
});

it("disables recursive card reads during native base replacement and keeps field normalization order", () => {
  const session = new MacroEvaluationSession();
  const context = { characterName: "Actor", userName: "Reader",
    collapseNewlines: true, characterFieldSources: { description: "  \r\n{{user}}/{{char}}\r\n\n\nX\r\n  ",
      creatorNotes: "{{incvar::notes}}" } };
  expect(session.evaluate("{{description}}", context)).toBe("Reader/Actor\nX");
  expect(session.local.notes).toBe(1);
  expect(session.evaluate("x{{description}}y", { ...context, replaceCharacterCard: false })).toBe("x{{description}}y");
  expect(session.local.notes).toBe(1);
  const recursive = { ...context, characterFieldSources: { description: "before{{description}}after" } };
  expect(session.evaluate("{{description}}", recursive)).toBe("before{{description}}after");
  // Removing CR before collapsing LF would lose the second newline in this case.
  expect(session.evaluate("{{description}}", { ...context, characterFieldSources: { description: "A\n\r\nB" } })).toBe("A\n\nB");
});

it("resolves native card fields, examples and version through their engine's real aliases", () => {
  const context = { characterName: "Actor", userName: "Reader",
    characterFieldSources: { system: "System {{char}}", jailbreak: "PHI", description: "Description", personality: "Personality",
      scenario: "Scenario", persona: "Persona", mesExamples: "{{char}}: hi\n<START>\n{{user}}: yes",
      charDepthPrompt: "Depth", creatorNotes: "Notes", version: "v2", firstMessage: "First", alternateGreetings: ["Alternative"] } };
  expect(resolveMacros("{{charPrompt}}|{{charInstruction}}|{{description}}|{{personality}}|{{scenario}}|{{persona}}|" +
    "{{mesExamplesRaw}}|{{mesExamples}}|{{charDepthPrompt}}|{{creatorNotes}}|{{charVersion}}/{{char_version}}", context))
    .toBe("System Actor|PHI|Description|Personality|Scenario|Persona|Actor: hi\n<START>\nReader: yes|<START>\nActor: hi\n<START>\nReader: yes\n|Depth|Notes|v2/v2");
  expect(resolveMacros("{{charJailbreak}}/{{greeting::1}}", context)).toBe("PHI/{{greeting::1}}");
});

it("binds actual selected card fields for native prompt preview", async () => {
  const app = buildApp(); apps.push(app);
  const character = await createTestCharacter(app, { ch_name: "Actual actor", description: "ACTUAL_CARD {{user}}", first_mes: "Hello" });
  const story = (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } })).json();
  const response = await app.inject({ method: "POST", url: `/api/conversations/${story.id}/prompt-preview`, payload: { draft: "input" } });
  expect(response.statusCode, response.body).toBe(200);
  const text = response.json().messages.map((message: { content: string }) => message.content).join("\n");
  expect(text).toContain("ACTUAL_CARD User");
  expect(text).not.toContain("{{description}}");
});
