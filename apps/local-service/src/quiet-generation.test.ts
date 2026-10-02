import { afterEach, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { toExtensionChatState } from "@mycompanion/shared";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); vi.unstubAllGlobals(); });

it("generates quietly with the selected story and request-scoped response length without writing a turn", async () => {
  const app = buildApp(); apps.push(app);
  const avatar = (await app.inject({ method: "POST", url: "/api/characters/create", payload: {
    ch_name: "Quiet Character", first_mes: "Opening", description: "Character context marker {{maxPrompt}}",
  } })).body;
  const character = (await app.inject({ method: "POST", url: "/api/characters/get", payload: { avatar_url: avatar } })).json();
  const story = (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } })).json();
  await app.inject({ method: "PUT", url: "/api/settings/provider", payload: {
    kind: "ollama", baseUrl: "http://localhost:9999/v1", model: "quiet-fixture",
    contextLimitTokens: 4096, maxTokens: 512,
  } });
  const book = await app.inject({ method: "POST", url: "/api/worldinfo/edit", payload: {
    name: "quiet-budget-book", data: { entries: {
      1: { uid: 1, key: [], keysecondary: [],
        content: "QUIET_WORLD={{maxPrompt}}/{{maxContext}}/{{maxResponse}}",
        constant: true, position: 1, disable: false },
    } },
  } });
  expect(book.statusCode, book.body).toBe(200);
  const worldSettings = (await app.inject({ method: "GET", url: "/api/worldinfo/settings" })).json();
  const selected = await app.inject({ method: "PUT", url: "/api/worldinfo/settings", payload: {
    ...worldSettings, world_info: { globalSelect: ["quiet-budget-book"], charLore: [] },
  } });
  expect(selected.statusCode, selected.body).toBe(200);
  const persona = await app.inject({ method: "PUT", url: "/api/extensions/settings", payload: { extensionSettings: {
    __mycompanion_power_user: { persona_description: "Quiet persona marker", persona_description_position: 0 },
  } } });
  expect(persona.statusCode, persona.body).toBe(200);
  let sent: { messages: Array<{ role: string; content: string }>; max_tokens: number; stream: boolean } | undefined;
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return new Response('data: {"choices":[{"delta":{"content":"Quiet reply"}}]}\n\ndata: [DONE]\n\n',
      { headers: { "Content-Type": "text/event-stream" } });
  }));
  const before = (await app.inject({ method: "GET", url: `/api/conversations/${story.id}` })).json();
  const response = await app.inject({ method: "POST", url: `/api/conversations/${story.id}/quiet-generation`, payload: {
    quietPrompt: "Secret quiet instruction", responseLength: 73, quietToLoud: false,
  } });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toEqual({ text: "Quiet reply" });
  expect(sent?.stream).toBe(true);
  expect(sent?.max_tokens).toBe(73);
  expect(JSON.stringify(sent?.messages)).toContain("Character context marker 4023");
  expect(JSON.stringify(sent?.messages)).toContain("QUIET_WORLD=4023/4096/73");
  expect(sent?.messages.some(message => message.content === "Quiet persona marker")).toBe(true);
  expect(sent?.messages.at(-1)).toEqual({ role: "system", content: "Secret quiet instruction" });
  const after = (await app.inject({ method: "GET", url: `/api/conversations/${story.id}` })).json();
  expect(after).toEqual(before);
  expect((await app.inject({ method: "GET", url: "/api/settings/provider" })).json().maxTokens).toBe(512);
});

it("rejects unsupported quiet media and forced groups before model transport", async () => {
  const app = buildApp(); apps.push(app);
  const avatar = (await app.inject({ method: "POST", url: "/api/characters/create", payload: {
    ch_name: "Quiet Character", first_mes: "Opening",
  } })).body;
  const character = (await app.inject({ method: "POST", url: "/api/characters/get", payload: { avatar_url: avatar } })).json();
  const story = (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } })).json();
  const providerFetch = vi.fn(); vi.stubGlobal("fetch", providerFetch);
  for (const extra of [{ quietImage: "data:image/png;base64,AA==" }, { forceChId: 0 }]) {
    const response = await app.inject({ method: "POST", url: `/api/conversations/${story.id}/quiet-generation`,
      payload: { quietPrompt: "Prompt", ...extra } });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("UNSUPPORTED_QUIET_OPTION");
  }
  expect(providerFetch).not.toHaveBeenCalled();
});

it("skips world info only for the requested quiet run", async () => {
  const app = buildApp(); apps.push(app);
  const avatar = (await app.inject({ method: "POST", url: "/api/characters/create", payload: {
    ch_name: "Quiet Character", first_mes: "Opening",
  } })).body;
  const character = (await app.inject({ method: "POST", url: "/api/characters/get", payload: { avatar_url: avatar } })).json();
  const story = (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } })).json();
  const edited = await app.inject({ method: "POST", url: "/api/worldinfo/edit", payload: { name: "quiet-book", data: { entries: {
    1: { uid: 1, key: [], keysecondary: [], content: "QUIET_WORLD_MARKER", constant: true, position: 1, disable: false },
  } } } });
  expect(edited.statusCode, edited.body).toBe(200);
  const current = (await app.inject({ method: "GET", url: "/api/worldinfo/settings" })).json();
  const selected = await app.inject({ method: "PUT", url: "/api/worldinfo/settings", payload: {
    ...current, world_info: { globalSelect: ["quiet-book"], charLore: [] },
  } });
  expect(selected.statusCode, selected.body).toBe(200);
  const requests: Array<{ messages: Array<{ content: string }> }> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return new Response('data: {"choices":[{"delta":{"content":"reply"}}]}\n\ndata: [DONE]\n\n',
      { headers: { "Content-Type": "text/event-stream" } });
  }));
  for (const skipWIAN of [false, true]) {
    const response = await app.inject({ method: "POST", url: `/api/conversations/${story.id}/quiet-generation`,
      payload: { quietPrompt: "Check world", skipWIAN } });
    expect(response.statusCode, response.body).toBe(200);
  }
  expect(JSON.stringify(requests[0]?.messages)).toContain("QUIET_WORLD_MARKER");
  expect(JSON.stringify(requests[1]?.messages)).not.toContain("QUIET_WORLD_MARKER");
});

it.each([false, true])("quiet skipWIAN omits author-note and its persona without changing saved state (explicit=%s)", async explicit => {
  const app = buildApp(); apps.push(app);
  const avatar = (await app.inject({ method: "POST", url: "/api/characters/create", payload: { ch_name: "Note fixture", first_mes: "Opening" } })).body;
  const character = (await app.inject({ method: "POST", url: "/api/characters/get", payload: { avatar_url: avatar } })).json();
  const story = (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } })).json();
  const base = toExtensionChatState(story);
  const saved = await app.inject({ method: "PUT", url: `/api/conversations/${story.id}/extension-state`, payload: {
    branchId: story.activeBranchId, base, next: { messages: base.messages.map(message => ({ ...message, is_user: true })),
      metadata: { ...base.metadata, note_prompt: "NOTE_MARKER", note_interval: 1, note_depth: 0 } },
  } });
  expect(saved.statusCode, saved.body).toBe(200);
  await app.inject({ method: "PUT", url: "/api/extensions/settings", payload: { extensionSettings: {
    __mycompanion_power_user: { persona_description: "NOTE_PERSONA", persona_description_position: 2 },
  } } });
  const before = (await app.inject({ method: "GET", url: `/api/conversations/${story.id}` })).json();
  const provider = vi.fn(); vi.stubGlobal("fetch", provider);
  for (const skipWIAN of [false, true, false]) {
    const response = await app.inject({ method: "POST", url: `/api/conversations/${story.id}/quiet-generation`, payload: {
      quietPrompt: "Preview", quietToLoud: true, quietName: "Accepted", dryRun: true, skipWIAN,
      extensionPrompts: explicit ? [{ key: "2_floating_prompt", value: "NOTE_MARKER", position: 1, depth: 0, role: 0, scan: false }] : [],
    } });
    expect(response.statusCode, response.body).toBe(200);
    const text = JSON.stringify(response.json().messages);
    expect(text.includes("NOTE_MARKER")).toBe(!skipWIAN);
    expect(text.includes("NOTE_PERSONA")).toBe(!skipWIAN);
    expect(response.json().messages.at(-1)).toEqual({ role: "system", content: expect.stringMatching(/Preview$/) });
  }
  expect(provider).not.toHaveBeenCalled();
  expect((await app.inject({ method: "GET", url: `/api/conversations/${story.id}` })).json()).toEqual(before);
});

it.each([
  [' { "answer": 42 } ', false, '{"answer":42}'],
  ["invalid", false, "{}"],
  ["  invalid  ", true, "  invalid  "],
  ["", false, "{}"],
  ["null", false, "{}"],
  [" false ", true, " false "],
] as const)("quiet JSON output %j (returnInvalid=%s) follows the Tavern result contract", async (text, returnInvalid, expected) => {
  const app = buildApp(); apps.push(app);
  const avatar = (await app.inject({ method: "POST", url: "/api/characters/create", payload: { ch_name: "JSON", first_mes: "Opening" } })).body;
  const character = (await app.inject({ method: "POST", url: "/api/characters/get", payload: { avatar_url: avatar } })).json();
  const story = (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } })).json();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } })));
  const response = await app.inject({ method: "POST", url: `/api/conversations/${story.id}/quiet-generation`, payload: {
    quietPrompt: "JSON", jsonSchema: { name: "result", value: { type: "object" }, returnInvalid },
  } });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().text).toBe(expected);
});
