import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationDetailSchema, type ConversationDetail } from "@mycompanion/shared";
import { buildApp } from "./app.js";
import { backupChecksum } from "./backup.js";
import reference from "./fixtures/prompt-persona-examples-upstream-reference.json" with { type: "json" };

type App = ReturnType<typeof buildApp>;
const apps: App[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); vi.unstubAllGlobals(); });
const app = () => { const instance = buildApp(); apps.push(instance); return instance; };
const book = (content: string, extras: Record<string, unknown> = {}) => ({ entries: { 42: {
  uid: 42, comment: "Fixture entry", key: ["observatory"], keysecondary: [], selective: true, content,
  constant: false, order: 100, position: 1, disable: false, ...extras,
} } });
async function save(instance: App, name: string, data: unknown) {
  const response = await instance.inject({ method: "POST", url: "/api/worldinfo/edit", payload: { name, data } });
  expect(response.statusCode, response.body).toBe(200);
}
async function settings(instance: App, changes: Record<string, unknown>) {
  const original = (await instance.inject({ method: "GET", url: "/api/worldinfo/settings" })).json();
  const response = await instance.inject({ method: "PUT", url: "/api/worldinfo/settings", payload: { ...original, ...changes } });
  expect(response.statusCode, response.body).toBe(200);
}
async function setup(instance: App, extensions: Record<string, unknown> = {}): Promise<ConversationDetail> {
  const imported = await instance.inject({ method: "POST", url: "/api/characters/import/commit", payload: {
    filename: "world-info.json", card: { spec: "chara_card_v2", spec_version: "2.0", data: {
      name: "Astronomer", description: "CORE_MARKER", first_mes: "Opening", personality: "", scenario: "", mes_example: "<START>\nAstronomer: EXAMPLE_MARKER",
      creator_notes: "", system_prompt: "", post_history_instructions: "", alternate_greetings: [], tags: [], creator: "MyCompanion", character_version: "1", extensions,
    } },
  } });
  expect(imported.statusCode, imported.body).toBe(201);
  return conversationDetailSchema.parse((await instance.inject({ method: "POST", url: "/api/conversations", payload: { characterId: imported.json().id } })).json());
}
async function bindChat(instance: App, conversation: ConversationDetail, name: string) {
  const current = (await instance.inject({ method: "GET", url: "/api/worldinfo/settings" })).json();
  const charLore = [...(current.world_info.charLore ?? [])];
  const binding = charLore.find(item => item.name === conversation.characterId);
  if (binding) binding.extraBooks = [...new Set([...binding.extraBooks, name])];
  else charLore.push({ name: conversation.characterId, extraBooks: [name] });
  await settings(instance, { world_info: { ...current.world_info, charLore } });
}
async function extensionSettings(instance: App, patch: Record<string, unknown>) {
  const current = (await instance.inject({ method: "GET", url: "/api/extensions/settings" })).json().extensionSettings;
  const response = await instance.inject({ method: "PUT", url: "/api/extensions/settings", payload: { extensionSettings: { ...current, ...patch } } });
  expect(response.statusCode, response.body).toBe(200);
}
async function preview(instance: App, id: string, draft = "observatory") {
  const response = await instance.inject({ method: "POST", url: `/api/conversations/${id}/prompt-preview`, payload: { draft } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as { messages: { role: string; content: string }[]; diagnostics: string[]; totalTokens: number };
}

describe("named world info in the independent application", () => {
  it("scans live browser settings without persisting them and validates prompt requests", async () => {
    const instance = app(); await save(instance, "live", book("LIVE_PROMPT"));
    const base = (await instance.inject({ method: "GET", url: "/api/worldinfo/settings" })).json();
    const input = { chat: ["observatory"], maxContext: 4096, settings: { ...base, world_info: { globalSelect: ["live"], charLore: [] } } };
    const response = await instance.inject({ method: "POST", url: "/api/worldinfo/prompt", payload: input });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().report.block).toBe("LIVE_PROMPT");
    expect(response.json().activated[0]).toMatchObject({ uid: 42, world: "live", content: "LIVE_PROMPT" });
    expect((await instance.inject({ method: "GET", url: "/api/worldinfo/settings" })).json()).toEqual(base);
    expect((await instance.inject({ method: "POST", url: "/api/worldinfo/prompt", payload: { ...input, chat: [{}] } })).statusCode).toBe(400);
    expect((await instance.inject({ method: "POST", url: "/api/worldinfo/prompt", payload: { ...input, characterId: "missing" } })).statusCode).toBe(404);
  });
  it("expands browser world-info budget macros with the requested response reserve", async () => {
    const instance = app();
    await save(instance, "budget", book("WORLD={{maxPrompt}}/{{maxContext}}/{{maxResponse}}"));
    const base = (await instance.inject({ method: "GET", url: "/api/worldinfo/settings" })).json();
    const response = await instance.inject({ method: "POST", url: "/api/worldinfo/prompt", payload: {
      chat: ["observatory"], maxContext: 2048, maxResponseTokens: 128,
      settings: { ...base, world_info: { globalSelect: ["budget"], charLore: [] } },
    } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().report.block).toBe("WORLD=1920/2048/128");
    expect(response.json().activated[0].content).toBe("WORLD=1920/2048/128");
  });
  it("uses live browser globals and model-specific counting, falling back to saved globals", async () => {
    const instance = app();
    await save(instance, "variable-budget", book("{{getglobalvar::description}}",
      { key: ["{{getglobalvar::place}}"] }));
    const stored = await instance.inject({ method: "PUT", url: "/api/extensions/settings", payload: {
      extensionSettings: { variables: { global: { place: "saved", description: "SAVED" } } },
    } });
    expect(stored.statusCode, stored.body).toBe(200);
    const base = (await instance.inject({ method: "GET", url: "/api/worldinfo/settings" })).json();
    const settings = { ...base, world_info: { globalSelect: ["variable-budget"], charLore: [] } };
    const prompt = (chat: string[], model: string, globalVariables?: Record<string, unknown>) =>
      instance.inject({ method: "POST", url: "/api/worldinfo/prompt", payload: {
        chat, maxContext: 4096, model, settings,
        ...(globalVariables === undefined ? {} : { globalVariables }),
      } });
    const live = { place: "observatory", description: "ab中文cd" };
    const oldModel = await prompt(["observatory"], "gpt-4", live);
    const newModel = await prompt(["observatory"], "gpt-4o", live);
    expect(oldModel.statusCode, oldModel.body).toBe(200);
    expect(newModel.statusCode, newModel.body).toBe(200);
    expect(oldModel.json().report.block).toBe("ab中文cd");
    expect(oldModel.json().report.results[0].tokens).toBe(4);
    expect(newModel.json().report.results[0].tokens).toBe(3);
    const saved = await prompt(["saved"], "gpt-4o");
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().report.block).toBe("SAVED");
  });
  it("scans supplied global scan data as literal prepared text in a single pass", async () => {
    const instance = app();
    await save(instance, "one-pass", book("INJECTED", { key: ["inner"], matchCharacterDescription: true }));
    const base = (await instance.inject({ method: "GET", url: "/api/worldinfo/settings" })).json();
    const response = await instance.inject({ method: "POST", url: "/api/worldinfo/prompt", payload: {
      chat: ["unrelated"], maxContext: 4096,
      // Macro-looking scan text is caller-prepared: if the engine re-expanded
      // it, `{{getvar::inner}}` would vanish (no such variable) and the key
      // `inner` would stop matching; a literal pass keeps the substring.
      globalScanData: { characterDescription: "{{getvar::inner}}" },
      settings: { ...base, world_info: { globalSelect: ["one-pass"], charLore: [] } },
    } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().report.block).toBe("INJECTED");
  });
  it("preserves arbitrary documents and selection settings after SQLite reopen", async () => {
    const path = join(tmpdir(), `mycompanion-world-info-${randomUUID()}.sqlite`);
    let instance = buildApp({ databasePath: path });
    try {
      const data = { ...book("你好", { future: { list: [false, null, { nested: 3 }] } }), originalData: { extension: "roundtrip" } };
      // These are literal display names, not filesystem paths or object properties.
      for (const name of ["../lore/星空", "__proto__", "constructor"]) await save(instance, name, data);
      await settings(instance, { world_info: { globalSelect: ["../lore/星空"], charLore: [], future: true }, world_info_budget_cap: 333 });
      await instance.close(); instance = buildApp({ databasePath: path });
      const names = (await instance.inject({ method: "GET", url: "/api/worldinfo/list" })).json().world_names;
      expect(new Set(names)).toEqual(new Set(["../lore/星空", "__proto__", "constructor"]));
      const loaded = (await instance.inject({ method: "POST", url: "/api/worldinfo/get", payload: { name: "../lore/星空" } })).json();
      expect(loaded).toEqual(data);
      const stored = (await instance.inject({ method: "GET", url: "/api/worldinfo/settings" })).json();
      expect(stored.world_info.globalSelect).toEqual(["../lore/星空"]); expect(stored.world_info_budget_cap).toBe(333);
      loaded.entries[42].content = "unsaved";
      expect((await instance.inject({ method: "POST", url: "/api/worldinfo/get", payload: { name: "../lore/星空" } })).json()).toEqual(data);
    } finally { await instance.close(); for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true }); }
  });

  it("backs up books and bindings with conflict policies and legacy checksum compatibility", async () => {
    const source = app(), target = app();
    const conversation = await setup(source);
    await save(source, "sky", book("FROM_BACKUP"));
    await bindChat(source, conversation, "sky");
    await settings(source, { world_info: { globalSelect: ["sky"], charLore: [] } });
    const backup = (await source.inject({ method: "GET", url: "/api/backup" })).json();
    const restore = (strategy: string) => target.inject({ method: "POST", url: "/api/backup/restore", payload: { backup, strategy } });
    const restored = await restore("overwrite"); expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json().applied.worldbooks).toBe(1);
    expect(JSON.stringify((await preview(target, conversation.id)).messages)).toContain("FROM_BACKUP");
    await save(target, "sky", book("LOCAL"));
    await restore("skip"); expect(JSON.stringify((await preview(target, conversation.id)).messages)).toContain("LOCAL");
    const check = (await target.inject({ method: "POST", url: "/api/backup/restore/preview", payload: { backup, strategy: "overwrite" } })).json();
    expect(check.sections.worldbooks.overwrite).toBe(1);
    await restore("overwrite"); expect(JSON.stringify((await preview(target, conversation.id)).messages)).toContain("FROM_BACKUP");
    delete backup.worldbooks; delete backup.worldInfoSettings; backup.manifest.checksum = backupChecksum(backup);
    await save(target, "sky", book("KEPT_FOR_OLD_BACKUP"));
    expect((await restore("overwrite")).statusCode).toBe(200);
    expect(JSON.stringify((await preview(target, conversation.id)).messages)).toContain("KEPT_FOR_OLD_BACKUP");
  });

  it("rejects malformed writes and bad backup settings without partial changes", async () => {
    const instance = app(); await save(instance, "sky", book("original"));
    for (const data of [null, { entries: [] }, { entries: { 1: "bad" } }]) {
      expect((await instance.inject({ method: "POST", url: "/api/worldinfo/edit", payload: { name: "sky", data } })).statusCode).toBe(400);
    }
    const backup = (await instance.inject({ method: "GET", url: "/api/backup" })).json();
    backup.worldbooks[0].data.entries[42].content = "must not write";
    backup.worldInfoSettings.world_info_depth = -3; backup.manifest.checksum = backupChecksum(backup);
    expect((await instance.inject({ method: "POST", url: "/api/backup/restore", payload: { backup, strategy: "overwrite" } })).statusCode).toBe(422);
    expect((await instance.inject({ method: "POST", url: "/api/worldinfo/get", payload: { name: "sky" } })).json().entries[42].content).toBe("original");
  });

  it("combines global, primary, auxiliary and chat bindings without duplicate entries", async () => {
    const instance = app(), conversation = await setup(instance, { world: "primary" });
    for (const name of ["global", "primary", "auxiliary", "chat"]) await save(instance, name, book(name.toUpperCase() + "_CONTENT"));
    await bindChat(instance, conversation, "chat");
    await settings(instance, { world_info: { globalSelect: ["global", "chat"], charLore: [{ name: conversation.characterId, extraBooks: ["auxiliary", "primary"] }] } });
    const text = JSON.stringify((await preview(instance, conversation.id)).messages);
    for (const name of ["global", "primary", "auxiliary", "chat"]) expect(text.split(name.toUpperCase() + "_CONTENT")).toHaveLength(2);
    expect(JSON.stringify((await preview(instance, conversation.id, "unrelated")).messages)).not.toContain("_CONTENT");
    const removed = await instance.inject({ method: "POST", url: "/api/worldinfo/delete", payload: { name: "global" } });
    expect(removed.statusCode).toBe(200);
    expect((await instance.inject({ method: "GET", url: "/api/worldinfo/settings" })).json().world_info.globalSelect).toEqual(["chat"]);
    expect(JSON.stringify((await preview(instance, conversation.id)).messages)).not.toContain("GLOBAL_CONTENT");
    expect((await instance.inject({ method: "POST", url: "/api/worldinfo/delete", payload: { name: "global" } })).statusCode).toBe(404);
  });

  it("uses saved changes in actual model requests and respects insertion positions and roles", async () => {
    const instance = app(), conversation = await setup(instance);
    const data = { entries: Object.fromEntries([
      [1, { ...book("BEFORE_CORE", { position: 0 }).entries[42], uid: 1 }],
      [2, { ...book("AFTER_CORE", { position: 1 }).entries[42], uid: 2 }],
      [3, { ...book("<START>\nAstronomer: BEFORE_EXAMPLE", { position: 5 }).entries[42], uid: 3 }],
      [4, { ...book("<START>\nAstronomer: AFTER_EXAMPLE", { position: 6 }).entries[42], uid: 4 }],
      [5, { ...book("DEPTH_ZERO", { position: 4, depth: 0, role: 2 }).entries[42], uid: 5 }],
      [6, { ...book("DEPTH_ONE", { position: 4, depth: 1, role: 1 }).entries[42], uid: 6 }],
    ]) };
    await save(instance, "sky", data); await bindChat(instance, conversation, "sky");
    const originalPreview = (await preview(instance, conversation.id)).messages;
    const system = originalPreview.map(message => message.content).join("\n");
    const order = ["BEFORE_CORE", "CORE_MARKER", "AFTER_CORE", "BEFORE_EXAMPLE", "EXAMPLE_MARKER", "AFTER_EXAMPLE"];
    expect(order.map(text => system.indexOf(text))).toEqual(order.map(text => system.indexOf(text)).sort((a, b) => a - b));
    for (const marker of order) expect(system).toContain(marker);
    expect(originalPreview.at(-1)).toEqual({ role: "assistant", content: "DEPTH_ZERO" });
    expect(originalPreview.at(-3)).toEqual({ role: "user", content: "DEPTH_ONE" });
    await save(instance, "sky", book("UPDATED_MODEL_CONTENT", { selective: true, keysecondary: ["star"] }));
    const requests: { messages: { role: string; content: string }[] }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (!body.stream) return Response.json({ choices: [{ message: { content: "[]" } }] });
      requests.push(body);
      return new Response('data: {"choices":[{"delta":{"content":"Reply"}}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
    }));
    await instance.inject({ method: "PUT", url: "/api/settings/provider", payload: { kind: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "fixture" } });
    const send = (content: string) => instance.inject({ method: "POST", url: `/api/conversations/${conversation.id}/messages`, payload: { content } });
    expect((await send("observatory")).statusCode).toBe(200);
    expect(JSON.stringify(requests[0])).not.toContain("UPDATED_MODEL_CONTENT");
    expect((await send("observatory star")).statusCode).toBe(200);
    expect(JSON.stringify(requests[1])).toContain("UPDATED_MODEL_CONTENT");
    expect(JSON.stringify(requests[1])).not.toContain("DEPTH_ZERO");
  });

  it("places ANTop and ANBottom around Author's Note only while its interval is active", async () => {
    const instance = app(), conversation = await setup(instance);
    await save(instance, "author-note-worlds", { entries: {
      1: { ...book("AN_TOP", { position: 2 }).entries[42], uid: 1 },
      2: { ...book("AN_BOTTOM", { position: 3 }).entries[42], uid: 2 },
    } });
    await bindChat(instance, conversation, "author-note-worlds");
    const setNote = async (prompt: string, interval: number) => {
      await extensionSettings(instance, { note: { default: prompt, defaultInterval: interval, defaultPosition: 1, defaultDepth: 0, defaultRole: 0 } });
    };
    await setNote("AUTHOR_NOTE", 1);
    const active = await preview(instance, conversation.id);
    expect(active.messages.at(-1)).toEqual({ role: "system", content: "AN_TOP\nAUTHOR_NOTE\nAN_BOTTOM" });
    expect(active.diagnostics.join(" ")).not.toContain("作者注释宿主接口尚未接入");
    const setPersona = async (position: number) => {
      await extensionSettings(instance, { __mycompanion_power_user: { persona_description: "PERSONA_TEXT", persona_description_position: position } });
    };
    await setPersona(2);
    expect((await preview(instance, conversation.id)).messages.at(-1)?.content).toBe("AN_TOP\nPERSONA_TEXT\nAUTHOR_NOTE\nAN_BOTTOM");
    const explicit = async (content: string) => (await instance.inject({ method: "POST", url: `/api/conversations/${conversation.id}/prompt-preview`, payload: {
      draft: "observatory", extensionPrompts: [{ key: "2_floating_prompt", value: content, position: 1, depth: 0, role: 0, scan: false }],
    } })).json();
    expect((await explicit("EXPLICIT_NOTE")).messages.at(-1).content).toBe("AN_TOP\nPERSONA_TEXT\nEXPLICIT_NOTE\nAN_BOTTOM");
    const oracle=reference.runs.find(run=>run.mode==="persona-author-note"&&run.note==="PERSONA_TEXT\nEXPLICIT_NOTE")!;
    expect((await explicit("PERSONA_TEXT\nEXPLICIT_NOTE")).messages.at(-1).content).toBe("AN_TOP\n"+oracle.result+"\nAN_BOTTOM");
    await setPersona(3);
    expect((await preview(instance, conversation.id)).messages.at(-1)?.content).toBe("AN_TOP\nAUTHOR_NOTE\nPERSONA_TEXT\nAN_BOTTOM");
    await setPersona(9);
    await setNote("AUTHOR_NOTE", 0);
    const inactive = await preview(instance, conversation.id);
    expect(JSON.stringify(inactive.messages)).not.toMatch(/AN_TOP|AN_BOTTOM|AUTHOR_NOTE/);
    expect(inactive.totalTokens).toBeLessThan(active.totalTokens);
    await setNote("", 1);
    const empty = await preview(instance, conversation.id);
    expect(empty.messages.at(-1)).toEqual({ role: "system", content: "AN_TOP\nAN_BOTTOM" });
    await setNote("AUTHOR_NOTE", 1);
    const requests: Array<{ messages: Array<{ content: string }> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (!body.stream) return Response.json({ choices: [{ message: { content: "[]" } }] });
      requests.push(body);
      return new Response('data: {"choices":[{"delta":{"content":"Reply"}}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
    }));
    const sent = await instance.inject({ method: "POST", url: `/api/conversations/${conversation.id}/messages`, payload: { content: "observatory" } });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(requests[0]?.messages.at(-1)?.content).toBe("AN_TOP\nAUTHOR_NOTE\nAN_BOTTOM");
  });
});
