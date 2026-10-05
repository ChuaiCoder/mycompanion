import { expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { apps, completionResponse, isCompletionRequest, sseResponse } from "./testing/helpers.js";
import { createTestCharacter } from "./testing/native-character.js";
import { countCompatibilityMessagesSync } from "./tokens/tokenizer-service.js";
import { CONTEXT_RESERVE_TOKENS } from "./prompt/prompt-budget.js";

async function fixture(settings: Record<string, unknown>, experimental = true) {
  const app = buildApp(); apps.push(app);
  const character = await createTestCharacter(app, {
    ch_name: "Preset actor", description: "CARD_DESCRIPTION", scenario: "CARD_SCENARIO", first_mes: "Hello",
  });
  const story = (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } })).json();
  await app.inject({ method: "PUT", url: "/api/settings/provider", payload: {
    kind: "ollama", baseUrl: "http://provider.test/v1", model: "gpt-4o", maxTokens: 128, contextLimitTokens: 4096,
  } });
  await app.inject({ method: "PUT", url: "/api/extensions/settings", payload: {
    extensionSettings: { __mycompanion_power_user: { experimental_macro_engine: experimental }, __mycompanion_openai: { settings } },
  } });
  // 原生路径：prompt-preview 走与真实发送完全相同的 PromptManager 组装。
  const assemble = (extra: Record<string, unknown> = {}) => app.inject({ method: "POST", url: `/api/conversations/${story.id}/prompt-preview`, payload: {
    draft: "LATEST_INPUT", ...extra,
  } });
  // 真实生成（捕获发向模型的消息，并提交宏变量）。
  const generate = async () => {
    const providerRequests: unknown[][] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: URL, init?: RequestInit) => {
      if (isCompletionRequest(init)) return completionResponse("[]");
      providerRequests.push((JSON.parse(String(init?.body)) as { messages: unknown[] }).messages);
      return sseResponse(["reply"]);
    }));
    const response = await app.inject({ method: "POST", url: `/api/conversations/${story.id}/messages`, payload: { content: "LATEST_INPUT" } });
    expect(response.statusCode, response.body).toBe(200);
    return providerRequests.at(-1)!;
  };
  const chat = async () => (await app.inject({ method: "GET", url: `/api/conversations/${story.id}` })).json();
  return { app, story, assemble, generate, chat };
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
  // 角色卡不带系统提示词时，托管预设的 main 才会成为主提示词。
  const exported = await f.app.inject({ method: "GET", url: `/api/characters/${(await f.chat()).characterId}/export?format=json` });
  const card = exported.json() as { data: Record<string, unknown> };
  card.data.system_prompt = "";
  const updated = await f.app.inject({ method: "PUT", url: `/api/characters/${(await f.chat()).characterId}`, payload: { card } });
  expect(updated.statusCode, updated.body).toBe(200);
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
  // 原生覆盖来源是角色卡 system_prompt；{{original}} 一次性展开为预设 main 内容。
  const exported = await f.app.inject({ method: "GET", url: `/api/characters/${(await f.chat()).characterId}/export?format=json` });
  const card = exported.json() as { data: Record<string, unknown> };
  card.data.system_prompt = "CARD_OVERRIDE [{{original}}]/[{{original}}]";
  const updated = await f.app.inject({ method: "PUT", url: `/api/characters/${(await f.chat()).characterId}`, payload: { card } });
  expect(updated.statusCode, updated.body).toBe(200);
  const text = JSON.stringify((await f.generate()).map(message => message as { content: string }));
  expect(text).toContain(forbid ? "PRESET_MAIN 1" : "CARD_OVERRIDE [PRESET_MAIN 1]/[]");
  if (forbid) expect(text).not.toContain("CARD_OVERRIDE");
  expect((await f.chat()).chatMetadata.variables).toEqual({ mainRuns: 1 });
});

it.each([false, true])("evaluates selected world-info in its real PromptManager prepare pass (experimental=%s)", async experimental => {
  const f = await fixture({ prompts: [main(), marker("worldInfoBefore"), marker("chatHistory")],
    prompt_order: order([["main", true], ["worldInfoBefore", true], ["chatHistory", true]]), wi_format: "WORLD_FORMAT[{0}]" }, experimental);
  const book = await f.app.inject({ method: "POST", url: "/api/worldinfo/edit", payload: {
    name: "pm-integration-book", data: { entries: {
      1: { uid: 1, key: [], keysecondary: [], content: "PROVIDED={{incvar::providedRuns}}", constant: true, disable: false, position: 0 },
    } },
  } });
  expect(book.statusCode, book.body).toBe(200);
  const current = (await f.app.inject({ method: "GET", url: "/api/worldinfo/settings" })).json();
  const selected = await f.app.inject({ method: "PUT", url: "/api/worldinfo/settings", payload: {
    ...current, world_info: { globalSelect: ["pm-integration-book"], charLore: [] },
  } });
  expect(selected.statusCode, selected.body).toBe(200);
  const text = JSON.stringify(await f.generate());
  expect(text).toContain("WORLD_FORMAT[PROVIDED=1]");
  expect((await f.chat()).chatMetadata.variables).toEqual(expect.objectContaining({ providedRuns: 1 }));
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
