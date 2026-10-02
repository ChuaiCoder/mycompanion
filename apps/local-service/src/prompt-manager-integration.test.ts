import { expect, it } from "vitest";
import { buildApp } from "./app.js";
import { apps } from "./test-helpers.js";
import { countCompatibilityMessagesSync } from "./tokenizer-service.js";
import { CONTEXT_RESERVE_TOKENS } from "./prompt-budget.js";

async function fixture(settings: Record<string, unknown>, experimental = true) {
  const app = buildApp(); apps.push(app);
  const avatar = (await app.inject({ method: "POST", url: "/api/characters/create", payload: {
    ch_name: "Preset actor", description: "CARD_DESCRIPTION", scenario: "CARD_SCENARIO", first_mes: "Hello",
  } })).body;
  const character = (await app.inject({ method: "POST", url: "/api/characters/get", payload: { avatar_url: avatar } })).json();
  const story = (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } })).json();
  await app.inject({ method: "PUT", url: "/api/settings/provider", payload: {
    kind: "ollama", baseUrl: "http://provider.test/v1", model: "gpt-4o", maxTokens: 128, contextLimitTokens: 4096,
  } });
  await app.inject({ method: "PUT", url: "/api/extensions/settings", payload: {
    extensionSettings: { __mycompanion_power_user: { experimental_macro_engine: experimental }, __mycompanion_openai: { settings } },
  } });
  const assemble = (extra: Record<string, unknown> = {}) => app.inject({ method: "POST", url: `/api/conversations/${story.id}/extension-prompt-assembly`, payload: {
    messages: [{ role: "user", content: "LATEST_INPUT" }], commitVariables: true, ...extra,
  } });
  const chat = async () => (await app.inject({ method: "GET", url: `/api/conversations/${story.id}` })).json();
  return { app, story, assemble, chat };
}

const relative = (identifier: string, content: string, role = "system") => ({
  identifier, content, role, system_prompt: false, injection_position: 0,
});
const main = (forbid_overrides = false) => ({ identifier: "main", role: "system", content: "PRESET_MAIN {{incvar::mainRuns}}", system_prompt: true, forbid_overrides });
const marker = (identifier: string) => ({ identifier, system_prompt: true, marker: true });
const order = (entries: Array<[string, boolean]>) => [{ character_id: 100001, order: entries.map(([identifier, enabled]) => ({ identifier, enabled })) }];

it("applies imported preset order, roles and disabled markers to public model messages", async () => {
  const f = await fixture({ prompts: [main(), relative("before", "BEFORE_PRESET", "user"), relative("after", "AFTER_PRESET", "assistant"), marker("charDescription"), marker("chatHistory")],
    prompt_order: order([["before", true], ["main", true], ["charDescription", false], ["chatHistory", true], ["after", true]]) });
  const response = await f.assemble(); expect(response.statusCode, response.body).toBe(200);
  const result = response.json(), text = result.messages.map((message: { content: string }) => message.content).join("\n");
  expect(text).toContain("BEFORE_PRESET"); expect(text).toContain("PRESET_MAIN 1"); expect(text).toContain("AFTER_PRESET");
  expect(text).not.toContain("CARD_DESCRIPTION");
  expect(text.indexOf("BEFORE_PRESET")).toBeLessThan(text.indexOf("PRESET_MAIN"));
  expect(text.indexOf("PRESET_MAIN")).toBeLessThan(text.indexOf("LATEST_INPUT"));
  expect(text.indexOf("LATEST_INPUT")).toBeLessThan(text.indexOf("AFTER_PRESET"));
  expect(result.messages.find((message: { content: string }) => message.content === "BEFORE_PRESET").role).toBe("user");
  expect(result.messages.find((message: { content: string }) => message.content === "AFTER_PRESET").role).toBe("assistant");
  expect(result.totalTokens).toBe(countCompatibilityMessagesSync(result.messages, "gpt-4o", true) + 128 + CONTEXT_RESERVE_TOKENS);
});

it.each([false, true])("honors preset forbid_overrides and the one-shot original macro (forbid=%s)", async forbid => {
  const f = await fixture({ prompts: [main(forbid), marker("chatHistory")], prompt_order: order([["main", true], ["chatHistory", true]]) });
  const response = await f.assemble({ systemPromptOverride: "CARD_OVERRIDE [{{original}}]/[{{original}}]" });
  expect(response.statusCode, response.body).toBe(200);
  const text = response.json().messages.map((message: { content: string }) => message.content).join("\n");
  expect(text).toContain(forbid ? "PRESET_MAIN 1" : "CARD_OVERRIDE [PRESET_MAIN 1]/[]");
  if (forbid) expect(text).not.toContain("CARD_OVERRIDE");
  expect((await f.chat()).chatMetadata.variables).toEqual({ mainRuns: 1 });
});

it.each([false, true])("evaluates supplied world-info in its real PromptManager prepare pass (experimental=%s)", async experimental => {
  const f = await fixture({ prompts: [main(), marker("worldInfoBefore"), marker("chatHistory")],
    prompt_order: order([["main", true], ["worldInfoBefore", true], ["chatHistory", true]]), wi_format: "WORLD_FORMAT[{0}]" }, experimental);
  const response = await f.assemble({ worldInfoBefore: "PROVIDED={{incvar::providedRuns}}" });
  expect(response.statusCode, response.body).toBe(200);
  expect(JSON.stringify(response.json().messages)).toContain("WORLD_FORMAT[PROVIDED=1]");
  expect((await f.chat()).chatMetadata.variables).toEqual({ mainRuns: 1, providedRuns: 1 });
});

it("keeps disabled-main presence for relative extensions while generation triggers suppress other prompts", async () => {
  const f = await fixture({ prompts: [main(), { ...relative("quiet-only", "MUST_NOT_RUN {{incvar::disabledRuns}}"), injection_trigger: ["quiet"] }, marker("chatHistory")],
    prompt_order: order([["main", false], ["quiet-only", true], ["chatHistory", true]]) });
  const response = await f.assemble({ extensionPrompts: [{ key: "relative", value: "RELATIVE_EXTENSION", position: 0, depth: 0, scan: false, role: 0 }] });
  expect(response.statusCode, response.body).toBe(200);
  const text = JSON.stringify(response.json().messages);
  expect(text).toContain("RELATIVE_EXTENSION"); expect(text).not.toContain("PRESET_MAIN"); expect(text).not.toContain("MUST_NOT_RUN");
  expect((await f.chat()).chatMetadata.variables ?? {}).toEqual({});
});

it("inserts absolute prompts by depth, order and role while counting the final request", async () => {
  const f = await fixture({ prompts: [main(), marker("chatHistory"),
    { ...relative("depth-high", "DEPTH_HIGH", "assistant"), injection_position: 1, injection_depth: 0, injection_order: 200 },
    { ...relative("depth-low", "DEPTH_LOW", "user"), injection_position: 1, injection_depth: 0, injection_order: 50 }],
    prompt_order: order([["main", true], ["chatHistory", true], ["depth-low", true], ["depth-high", true]]) });
  const response = await f.assemble(); expect(response.statusCode, response.body).toBe(200);
  const result = response.json(), text = result.messages.map((message: { content: string }) => message.content).join("\n");
  expect(text.indexOf("LATEST_INPUT")).toBeLessThan(text.indexOf("DEPTH_LOW"));
  expect(text.indexOf("DEPTH_LOW")).toBeLessThan(text.indexOf("DEPTH_HIGH"));
  expect(result.totalTokens).toBe(countCompatibilityMessagesSync(result.messages, "gpt-4o", true) + 128 + CONTEXT_RESERVE_TOKENS);
});
