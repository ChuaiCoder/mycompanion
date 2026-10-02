import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { buildApp } from "./app.js";
import type { ExtensionPrompt } from "@mycompanion/shared";
import { toExtensionChatState } from "@mycompanion/shared";
import reference from "./fixtures/prompt-remaining-upstream-reference.json" with { type: "json" };

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); vi.unstubAllGlobals(); });
const injection = (key: string, value: string, position: ExtensionPrompt["position"], depth = 0, role: ExtensionPrompt["role"] = 0, scan = false): ExtensionPrompt => ({ key, value, position, depth, role, scan });
async function fixture() {
  const app = buildApp(); apps.push(app);
  const avatar = (await app.inject({ method: "POST", url: "/api/characters/create", payload: { ch_name: "Injector", first_mes: "Greeting", description: "CHARACTER_CORE" } })).body;
  const character = (await app.inject({ method: "POST", url: "/api/characters/get", payload: { avatar_url: avatar } })).json();
  const story = (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } })).json();
  const preview = (extensionPrompts: ExtensionPrompt[]) => app.inject({ method: "POST", url: `/api/conversations/${story.id}/prompt-preview`, payload: { draft: "Current input", extensionPrompts } });
  return { app, character, story, preview };
}
it("places temporary prompts by role/depth and budgets them once without saving them in chat", async () => {
  const { app, story, preview } = await fixture();
  const prompts = [injection("before", "BEFORE", 2, 0, 1), injection("relative", "RELATIVE", 0, 0, 2),
    injection("tail-z", "TAIL_Z", 1), injection("tail-a", "TAIL_A", 1), injection("deep", "DEEP {{char}}", 1, 10000),
    injection("middle", "MIDDLE", 1, 1, 1), injection("tail-assistant", "TAIL_ASSISTANT", 1, 0, 2)];
  const response = await preview(prompts); expect(response.statusCode, response.body).toBe(200);
  const result = response.json();
  const provider = (await app.inject({ method: "GET", url: "/api/settings/provider" })).json();
  const exact = (await app.inject({ method: "POST", url: "/api/extensions/token-count", payload: {
    messages: result.messages, model: provider.model, full: true,
  } })).json();
  expect(result.totalTokens).toBe(exact.token_count + Math.min(provider.maxTokens, provider.contextLimitTokens) + 512);
  const oracle=reference.runs.find(run=>run.mode==="injection-buckets"&&run.experimental===false)!;
  expect(result.messages).toEqual(oracle.messages);
  const injectedRegion = result.regions.find((region: { key: string }) => region.key === "extension_prompts");
  expect(injectedRegion.tokens).toBeGreaterThan(0);
  expect((await preview([])).json().totalTokens).toBeLessThan(result.totalTokens);
  const stored = (await app.inject({ method: "GET", url: `/api/conversations/${story.id}` })).json();
  expect(stored.messages).toEqual(story.messages); expect(JSON.stringify(stored)).not.toContain("TAIL_");
});

it("counts exactly the independent character and PromptManager macro passes sent to the model", async () => {
  const app = buildApp(); apps.push(app);
  const avatar = (await app.inject({ method: "POST", url: "/api/characters/create", payload: {
    ch_name: "MacroCard", first_mes: "Opening", description: "{{getvar::outer}}/{{model}}{{newline}}END",
  } })).body;
  const character = (await app.inject({ method: "POST", url: "/api/characters/get", payload: { avatar_url: avatar } })).json();
  const story = (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } })).json();
  const base = toExtensionChatState(story);
  const saved = await app.inject({ method: "PUT", url: `/api/conversations/${story.id}/extension-state`, payload: {
    branchId: story.activeBranchId, base, next: { ...base, metadata: {
      ...base.metadata, variables: { outer: "{{getvar::inner}}", inner: "expanded twice" },
    } },
  } });
  expect(saved.statusCode, saved.body).toBe(200);
  const response = await app.inject({ method: "POST", url: `/api/conversations/${story.id}/prompt-preview`, payload: { draft: "Current input" } });
  expect(response.statusCode, response.body).toBe(200);
  const preview = response.json();
  const provider = (await app.inject({ method: "GET", url: "/api/settings/provider" })).json();
  const oracle=reference.runs.find(run=>run.mode==="residual-card"&&run.experimental===false)!;
  const expected=oracle.messages.map(message=>({...message,content:message.content.replaceAll("gpt-4o",provider.model)}));
  expect(preview.messages).toEqual(expected);
  expect(preview.messages.some((message:{content:string})=>message.content===`expanded twice/${provider.model}\nEND`)).toBe(true);
  const exact = (await app.inject({ method: "POST", url: "/api/extensions/token-count", payload: {
    messages: preview.messages, model: provider.model, full: true,
  } })).json();
  expect(preview.totalTokens).toBe(exact.token_count + Math.min(provider.maxTokens, provider.contextLimitTokens) + 512);
});

it("honors scan-only injection independently of message depth and never puts it in model messages", async () => {
  const { app, preview } = await fixture();
  await app.inject({ method: "POST", url: "/api/worldinfo/edit", payload: { name: "injection-book", data: { entries: { 1: {
    uid: 1, key: ["INJECTION_SCAN_ONLY"], keysecondary: [], content: "WORLD_ACTIVATED", position: 1, disable: false, scanDepth: 0,
  } } } } });
  const settings = (await app.inject({ method: "GET", url: "/api/worldinfo/settings" })).json();
  await app.inject({ method: "PUT", url: "/api/worldinfo/settings", payload: { ...settings, world_info: { globalSelect: ["injection-book"], charLore: [] } } });
  const prompt = injection("scan", "INJECTION_SCAN_ONLY", -1, 0, 0, true);
  const response = await preview([prompt]); expect(response.statusCode, response.body).toBe(200);
  const withScan = response.json();
  expect(JSON.stringify(withScan.messages)).toContain("WORLD_ACTIVATED");
  expect(JSON.stringify(withScan.messages)).not.toContain("INJECTION_SCAN_ONLY");
  const deepScanOnly = await preview([{ ...prompt, depth: 9000 }]);
  expect(deepScanOnly.statusCode, deepScanOnly.body).toBe(200);
  expect(JSON.stringify(deepScanOnly.json().messages)).toContain("WORLD_ACTIVATED");
  expect(JSON.stringify(deepScanOnly.json().messages)).not.toContain("INJECTION_SCAN_ONLY");
  const withoutScan=(await preview([])).json();
  expect(withScan.regions.filter((region: { key: string }) => region.key === "extension_prompts"))
    .toEqual(withoutScan.regions.filter((region: { key: string }) => region.key === "extension_prompts"));
  expect(JSON.stringify((await preview([{ ...prompt, scan: false }])).json().messages)).not.toContain("WORLD_ACTIVATED");
});

it("trims old messages against the final framed BPE request while keeping the latest input", async () => {
  const { app, story } = await fixture();
  const provider = await app.inject({ method: "PUT", url: "/api/settings/provider", payload: {
    kind: "ollama", baseUrl: "http://localhost:9999/v1", model: "gpt-4o", maxTokens: 100, contextLimitTokens: 750,
  } });
  expect(provider.statusCode, provider.body).toBe(200);
  const base = toExtensionChatState(story);
  const next = { metadata: base.metadata, messages: [...base.messages, ...Array.from({ length: 10 }, (_, index) => ({
    id: randomUUID(), is_user: index % 2 === 0, mes: `OLD_${index} ` + "older context ".repeat(18),
  }))] };
  const saved = await app.inject({ method: "PUT", url: `/api/conversations/${story.id}/extension-state`, payload: {
    branchId: story.activeBranchId, base, next,
  } });
  expect(saved.statusCode, saved.body).toBe(200);
  const preview = await app.inject({ method: "POST", url: `/api/conversations/${story.id}/prompt-preview`, payload: { draft: "Latest user input" } });
  expect(preview.statusCode, preview.body).toBe(200);
  const result = preview.json();
  expect(result.messages.some((message: { content: string }) => message.content === "Latest user input")).toBe(true);
  expect(JSON.stringify(result.messages)).not.toContain("OLD_0");
  expect(result.totalTokens).toBeLessThanOrEqual(750);
  const counted = (await app.inject({ method: "POST", url: "/api/extensions/token-count", payload: {
    messages: result.messages, model: "gpt-4o", full: true,
  } })).json();
  expect(result.totalTokens).toBe(counted.token_count + 612);
});

it("reports an unfit fixed prompt and does not send an over-limit model request", async () => {
  const { app, story, preview } = await fixture();
  const settings = await app.inject({ method: "PUT", url: "/api/settings/provider", payload: {
    kind: "ollama", baseUrl: "http://localhost:9999/v1", model: "gpt-4o", maxTokens: 200, contextLimitTokens: 800,
  } });
  expect(settings.statusCode, settings.body).toBe(200);
  const prompts = [injection("fixed", "very long fixed prompt ".repeat(100), 2)];
  const inspected = (await preview(prompts)).json();
  expect(inspected.totalTokens).toBeGreaterThan(800);
  expect(inspected.diagnostics.join("")).toContain("固定预设提示词与当前输入超出上下文上限");
  const providerFetch = vi.fn();
  vi.stubGlobal("fetch", providerFetch);
  const sent = await app.inject({ method: "POST", url: `/api/conversations/${story.id}/messages`, payload: {
    content: "Latest input", extensionPrompts: prompts,
  } });
  expect(sent.statusCode, sent.body).toBe(200);
  expect(sent.body).toContain("超出上下文上限");
  expect(providerFetch).not.toHaveBeenCalled();
});

it("sends the same scoped injections to real model requests, including regeneration, and rejects malformed input before mutation", async () => {
  const { app, story } = await fixture();
  const requests: { messages: { role: string; content: string }[]; stream?: boolean }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, options: RequestInit) => {
    const body = JSON.parse(String(options.body)); requests.push(body);
    return body.stream ? new Response('data: {"choices":[{"delta":{"content":"Reply"}}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } })
      : Response.json({ choices: [{ message: { content: "[]" } }] });
  }));
  await app.inject({ method: "PUT", url: "/api/settings/provider", payload: { kind: "ollama", baseUrl: "http://localhost:9999/v1", model: "fixture", maxTokens: 100 } });
  const extensionPrompts = [injection("model", "MODEL_ONLY", 1, 0, 2)];
  const generated = await app.inject({ method: "POST", url: `/api/conversations/${story.id}/messages`, payload: { content: "Input", extensionPrompts } });
  expect(generated.statusCode, generated.body).toBe(200);
  expect(requests.find(request => request.stream)?.messages.at(-1)).toEqual({ role: "assistant", content: "MODEL_ONLY" });
  const snapshot = (await app.inject({ method: "GET", url: `/api/conversations/${story.id}` })).json();
  const invalid = await app.inject({ method: "POST", url: `/api/conversations/${story.id}/messages/regenerate`, payload: { extensionPrompts: [{ ...extensionPrompts[0], depth: -1 }] } });
  expect(invalid.statusCode).toBe(400);
  expect((await app.inject({ method: "GET", url: `/api/conversations/${story.id}` })).json().activeBranchId).toBe(snapshot.activeBranchId);
  const regenerated = await app.inject({ method: "POST", url: `/api/conversations/${story.id}/messages/regenerate`, payload: { extensionPrompts: [injection("regen", "REGEN_ONLY", 2)] } });
  expect(regenerated.statusCode, regenerated.body).toBe(200);
  expect(requests.filter(request => request.stream).at(-1)?.messages[0]).toEqual({ role: "system", content: "REGEN_ONLY" });
  expect(JSON.stringify(requests.filter(request => request.stream).at(-1))).not.toContain("MODEL_ONLY");
  const saved = (await app.inject({ method: "GET", url: `/api/conversations/${story.id}` })).json();
  expect(JSON.stringify(saved)).not.toContain("MODEL_ONLY"); expect(JSON.stringify(saved)).not.toContain("REGEN_ONLY");
});

it("persists Author's Note metadata and uses it in preview and actual generation at the configured interval", async () => {
  const { app, story } = await fixture();
  const current = (await app.inject({ method: "GET", url: `/api/conversations/${story.id}` })).json();
  const base = toExtensionChatState(current);
  const saved = await app.inject({ method: "PUT", url: `/api/conversations/${story.id}/extension-state`, payload: {
    branchId: story.activeBranchId, base,
    next: { ...base, metadata: { ...base.metadata, note_prompt: "Follow the map", note_interval: 2, note_depth: 0, note_role: 0 } },
  } });
  expect(saved.statusCode, saved.body).toBe(200);
  const preview = async () => (await app.inject({ method: "POST", url: `/api/conversations/${story.id}/prompt-preview`, payload: { draft: "Continue" } })).json();
  expect(JSON.stringify(await preview())).not.toContain("Follow the map");
  const requests: Array<{ messages: Array<{ content: string }>; stream: boolean }> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, options: RequestInit) => {
    const body = JSON.parse(String(options.body)); requests.push(body);
    return body.stream ? new Response('data: {"choices":[{"delta":{"content":"Reply"}}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } })
      : Response.json({ choices: [{ message: { content: "[]" } }] });
  }));
  const first = await app.inject({ method: "POST", url: `/api/conversations/${story.id}/messages`, payload: { content: "First" } });
  expect(first.statusCode, first.body).toBe(200);
  expect(requests.find(request => request.stream)?.messages.some(message => message.content.includes("Follow the map"))).toBe(false);
  const nextPreview = await preview();
  expect(JSON.stringify(nextPreview)).toContain("Follow the map");
  const second = await app.inject({ method: "POST", url: `/api/conversations/${story.id}/messages`, payload: { content: "Second" } });
  expect(second.statusCode, second.body).toBe(200);
  expect(requests.filter(request => request.stream).at(-1)?.messages.some(message => message.content.includes("Follow the map"))).toBe(true);
  const reloaded = (await app.inject({ method: "GET", url: `/api/conversations/${story.id}` })).json();
  expect(reloaded.chatMetadata.note_prompt).toBe("Follow the map");
});

it("keeps Author's Note interval aligned with the full branch beyond the 80-message model window", async () => {
  const { app, story } = await fixture();
  const current = (await app.inject({ method: "GET", url: `/api/conversations/${story.id}` })).json();
  const base = toExtensionChatState(current);
  const next = { messages: [...base.messages], metadata: { note_prompt: "LONG_STORY_NOTE", note_interval: 82 } };
  for (let index = 0; index < 81; index++) {
    next.messages.push({ id: randomUUID(), mes: `turn-${index}`, is_user: true, name: "User" });
  }
  const saved = await app.inject({ method: "PUT", url: `/api/conversations/${story.id}/extension-state`, payload: {
    branchId: story.activeBranchId, base, next,
  } });
  expect(saved.statusCode, saved.body).toBe(200);
  const withoutDraft = (await app.inject({ method: "POST", url: `/api/conversations/${story.id}/prompt-preview`, payload: {} })).json();
  expect(JSON.stringify(withoutDraft)).not.toContain("LONG_STORY_NOTE");
  const withDraft = (await app.inject({ method: "POST", url: `/api/conversations/${story.id}/prompt-preview`, payload: { draft: "next turn" } })).json();
  expect(JSON.stringify(withDraft)).toContain("LONG_STORY_NOTE");
});

it("places persisted persona description in the native prompt and counts it in the shared budget", async () => {
  const { app, story } = await fixture();
  const setPersona = async (position: number) => {
    const response = await app.inject({ method: "PUT", url: "/api/extensions/settings", payload: { extensionSettings: {
      __mycompanion_power_user: { persona_description: "PERSONA {{char}}", persona_description_position: position,
        persona_description_depth: 0, persona_description_role: 1 },
    } } });
    expect(response.statusCode, response.body).toBe(200);
  };
  const inspect = async () => (await app.inject({ method: "POST", url: `/api/conversations/${story.id}/prompt-preview`, payload: { draft: "Current input" } })).json();
  await setPersona(0);
  const inPrompt = await inspect();
  expect(inPrompt.messages[1]).toEqual({ role: "system", content: "PERSONA Injector" });
  const exact = (await app.inject({ method: "POST", url: "/api/extensions/token-count", payload: {
    messages: inPrompt.messages, model: (await app.inject({ method: "GET", url: "/api/settings/provider" })).json().model, full: true,
  } })).json();
  expect(inPrompt.totalTokens).toBe(exact.token_count + 1024 + 512);
  await setPersona(4);
  const atDepth = await inspect();
  expect(atDepth.messages.at(-1)).toEqual({ role: "user", content: "PERSONA Injector" });
  await setPersona(9);
  expect(JSON.stringify((await inspect()).messages)).not.toContain("PERSONA Injector");
});

it("uses the selected persona name and description for native macro expansion and chat locks", async () => {
  const { app, story } = await fixture();
  const settings = { __mycompanion_power_user: {
    __selected_persona: "reader.png", personas: { "reader.png": "Reader", "writer.png": "Writer" },
    persona_descriptions: { "reader.png": { description: "I am {{user}}", position: 0 },
      "writer.png": { description: "I am {{user}}", position: 0 } },
  } };
  expect((await app.inject({ method: "PUT", url: "/api/extensions/settings", payload: { extensionSettings: settings } })).statusCode).toBe(200);
  const url = `/api/conversations/${story.id}/prompt-preview`;
  const first = (await app.inject({ method: "POST", url, payload: { draft: "Hello" } })).json();
  expect(JSON.stringify(first.messages)).toContain("I am Reader");
  const current = (await app.inject({ method: "GET", url: `/api/conversations/${story.id}` })).json();
  const base = toExtensionChatState(current);
  expect((await app.inject({ method: "PUT", url: `/api/conversations/${story.id}/extension-state`, payload: {
    branchId: story.activeBranchId, base, next: { ...base, metadata: { ...base.metadata, persona: "writer.png" } },
  } })).statusCode).toBe(200);
  const locked = (await app.inject({ method: "POST", url, payload: { draft: "Hello" } })).json();
  expect(JSON.stringify(locked.messages)).toContain("I am Writer");
  expect(JSON.stringify(locked.messages)).not.toContain("I am Reader");
});
