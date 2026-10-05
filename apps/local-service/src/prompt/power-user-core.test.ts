import { expect, it } from "vitest";
import { getPersonaDescription, getPersonaUserName, POWER_USER_SETTINGS_KEY } from "./power-user-core.js";
import reference from "../fixtures/prompt-persona-examples-upstream-reference.json" with { type: "json" };

it("migrates the legacy persona position using the executed original setPersonaDescription result",()=>{
  const oracle=reference.runs.find(run=>run.mode==="legacy-persona-position")!;
  const source={persona_description:"Legacy persona",persona_description_position:oracle.before};
  expect(getPersonaDescription({[POWER_USER_SETTINGS_KEY]:source})).toMatchObject({position:oracle.after});
  expect(source.persona_description_position).toBe(1);
});

it("reads persisted persona text and rejects invalid placement before prompt assembly", () => {
  expect(getPersonaDescription({})).toBeNull();
  expect(getPersonaDescription({ [POWER_USER_SETTINGS_KEY]: {
    persona_description: "  Navigator  ", persona_description_position: 4,
    persona_description_depth: 3, persona_description_role: 1,
  } })).toEqual({ content: "Navigator", position: 4, depth: 3, role: 1 });
  expect(() => getPersonaDescription({ [POWER_USER_SETTINGS_KEY]: {
    persona_description: "Navigator", persona_description_position: 4, persona_description_depth: -1,
  } })).toThrow("设置无效");
});

it("uses selected or chat-locked persona name and description for native prompts", () => {
  const settings = { [POWER_USER_SETTINGS_KEY]: {
    __selected_persona: "a.png", default_persona: "b.png",
    personas: { "a.png": "Alice", "b.png": "Bob" },
    persona_descriptions: {
      "a.png": { description: "Alice persona", position: 1, depth: 2, role: 0 },
      "b.png": { description: "Bob persona", position: 4, depth: 0, role: 1 },
    },
  } };
  expect(getPersonaUserName(settings)).toBe("Alice");
  expect(getPersonaDescription(settings)?.content).toBe("Alice persona");
  expect(getPersonaUserName(settings, { persona: "b.png" })).toBe("Bob");
  expect(getPersonaDescription(settings, { persona: "b.png" })).toEqual({ content: "Bob persona", position: 4, depth: 0, role: 1 });
  expect(getPersonaDescription({ [POWER_USER_SETTINGS_KEY]: {
    __selected_persona: "unknown.png", persona_description: "Another persona's text",
  } })).toBeNull();
});
