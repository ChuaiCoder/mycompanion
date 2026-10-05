import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { parseCharacterCardDocument } from "@mycompanion/character-card";
import type { ConversationDetail, GenerationSseEvent } from "@mycompanion/shared";
import { buildApp } from "./app.js";
import { CharacterRepository } from "./character/character-repository.js";
import { RuntimeRepository } from "./persistence/runtime-repository.js";
import type { TavernRegexScript } from "./prompt/tavern-regex-core.js";

type App = ReturnType<typeof buildApp>;
const nativeFetch = globalThis.fetch;
const resources: Array<{ app: App; database: DatabaseSync; path: string }> = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.app.close(); resource.database.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(resource.path + suffix, { force: true });
  }
  vi.unstubAllGlobals();
});
const rule = (patch: TavernRegexScript = {}): TavernRegexScript => ({ placement: [1], findRegex: "/input/g", replaceString: "changed", ...patch });
const stream = (text = "reply") => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\n`,
  { headers: { "Content-Type": "text/event-stream" } });
const complete = () => Response.json({ choices: [{ message: { content: "[]" } }] });
function events(body: string): GenerationSseEvent[] {
  return body.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)) as GenerationSseEvent);
}
function snapshot(database: DatabaseSync) {
  return Object.fromEntries((database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>)
    .map(({ name }) => [name, database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}

async function setup(scripts: TavernRegexScript[], experimentalMacroEngine = true, persona = "Alice", firstMessage = "Opening") {
  const path = join(tmpdir(), `native-regex-session-${randomUUID()}.sqlite`), app = buildApp({ databasePath: path }), database = new DatabaseSync(path);
  resources.push({ app, database, path });
  const runtime = new RuntimeRepository(database), characters = new CharacterRepository(database);
  const character = characters.import(parseCharacterCardDocument({ spec: "chara_card_v2", spec_version: "2.0", data: {
    name: "Agent", description: "Card", first_mes: firstMessage, personality: "", scenario: "", mes_example: "", creator_notes: "",
    system_prompt: "", post_history_instructions: "", alternate_greetings: ["Alternative"], tags: [], creator: "MyCompanion",
    character_version: "1", extensions: {},
  } }), "native-regex.json").character;
  const settings = { regex: scripts, variables: { global: { global: "G" } }, __mycompanion_power_user: {
    experimental_macro_engine: experimentalMacroEngine, personas: { "fixture.png": persona }, __selected_persona: "fixture.png",
  } };
  runtime.saveExtensionSettings(settings);
  await app.inject({ method: "PUT", url: "/api/settings/provider", payload: {
    kind: "ollama", baseUrl: "http://native-regex.test/v1", model: "test-model", maxTokens: 128, contextLimitTokens: 4096,
  } });
  const create = () => app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } });
  const created = await create(); expect(created.statusCode, created.body).toBe(201);
  const story = created.json() as ConversationDetail;
  runtime.setAutoSummaryEnabled(story.id, false);
  const requests: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { stream: boolean };
    if (!body.stream) return complete(); requests.push(body); return stream();
  }));
  const send = (content: string, extra: Record<string, unknown> = {}) => app.inject({ method: "POST", url: `/api/conversations/${story.id}/messages`, payload: { content, ...extra } });
  return { app, database, runtime, characters, character, story, requests, create, send };
}

it.each([false, true])("shares persona/card/variables across input, prompt and output and commits each increment once (experimental=%s)", async experimental => {
  const fixture = await setup([
    rule({ replaceString: "{{setvar::phase::entered}}{{incvar::count}}/{{user}}/{{getglobalvar::global}}/{{description}}" }),
    rule({ findRegex: "/^1\\/Alice\\/G\\/Card$/g", promptOnly: true, replaceString: "{{incvar::count}}|{{getvar::phase}}" }),
    rule({ placement: [2], findRegex: "/reply/g", replaceString: "{{incvar::count}}|{{user}}|{{getvar::phase}}|{{description}}|{{model}}" }),
  ], experimental);
  const response = await fixture.send("input"); expect(response.statusCode, response.body).toBe(200);
  expect(fixture.requests).toHaveLength(1); expect(JSON.stringify(fixture.requests[0]!.messages)).toContain("2|entered");
  const current = fixture.runtime.getConversation(fixture.story.id)!;
  expect(current.messages.find(message => message.role === "user")?.content).toBe("1/Alice/G/Card");
  expect(current.messages.at(-1)?.content).toBe("3|Alice|entered|Card|test-model");
  expect(String((current.chatMetadata!.variables as Record<string, unknown>).count)).toBe("3");
  expect(events(response.body).filter(event => event.type === "macro_variables")).toHaveLength(2);
});

it.each([false, true])("uses per-macro escaping for the selected persona in native find patterns (experimental=%s)", async experimental => {
  const fixture = await setup([rule({ findRegex: "/{{user}}/g", substituteRegex: 2, replaceString: "Persona found" })], experimental, "A+B");
  const response = await fixture.send("A+B AAB"); expect(response.statusCode, response.body).toBe(200);
  expect(fixture.runtime.getConversation(fixture.story.id)!.messages.find(message => message.role === "user")?.content).toBe("Persona found AAB");
});

it("keeps prompt-preview and greeting-preview variable side effects in an unsaved draft", async () => {
  const fixture = await setup([rule({ replaceString: "{{incvar::preview}}/{{incglobalvar::previewGlobal}}/{{user}}" }),
    rule({ placement: [2], findRegex: "/Opening|Alternative/g", replaceString: "{{incvar::greet}}/{{incglobalvar::greetGlobal}}/{{user}}" })]);
  const before = snapshot(fixture.database);
  const preview = await fixture.app.inject({ method: "POST", url: `/api/conversations/${fixture.story.id}/prompt-preview`, payload: { draft: "input" } });
  expect(preview.statusCode, preview.body).toBe(200); expect(preview.body).toContain("1/1/Alice");
  const greeting = await fixture.app.inject({ method: "GET", url: `/api/conversations/${fixture.story.id}/greeting` });
  expect(greeting.statusCode, greeting.body).toBe(200); expect(greeting.json().message.swipes).toEqual(["2/2/Alice", "3/3/Alice"]);
  expect(snapshot(fixture.database)).toEqual(before); expect(fixture.requests).toHaveLength(0);
});

it("commits a selected new greeting's local/global regex effects and chosen persona with the story", async () => {
  const fixture = await setup([rule({ placement: [2], findRegex: "/Opening/g", replaceString: "{{incvar::greet}}/{{incglobalvar::greetGlobal}}/{{user}}" })]);
  expect(fixture.story.messages[0]?.content).toBe("1/1/Alice");
  expect(String((fixture.story.chatMetadata!.variables as Record<string, unknown>).greet)).toBe("1");
  expect(String((fixture.runtime.getExtensionSettings().variables as { global: Record<string, unknown> }).global.greetGlobal)).toBe("1");
});

it("rolls back a new greeting and its local/global effects when variable persistence fails", async () => {
  const fixture = await setup([rule({ placement: [2], findRegex: "/Opening/g", replaceString: "{{incvar::greet}}/{{incglobalvar::greetGlobal}}/{{user}}" })]);
  const before = snapshot(fixture.database);
  fixture.database.exec("CREATE TRIGGER reject_regex_settings BEFORE UPDATE ON extension_settings BEGIN SELECT RAISE(ABORT,'regex fixture settings failure'); END");
  const failed = await fixture.create(); expect(failed.statusCode, failed.body).toBe(500);
  expect(snapshot(fixture.database)).toEqual(before);
  fixture.database.exec("DROP TRIGGER reject_regex_settings");
  const retried = await fixture.create(); expect(retried.statusCode, retried.body).toBe(201);
  expect(retried.json().messages[0].content).toBe("1/2/Alice");
});

it("rolls back the edit branch and macro effects together after a late settings write failure", async () => {
  const fixture = await setup([rule({ runOnEdit: true, findRegex: "/edit-target/g", replaceString: "{{incvar::edited}}/{{incglobalvar::editedGlobal}}/Changed" })]);
  const source = fixture.runtime.addMessage(fixture.story.id, "user", "edit-target"), before = snapshot(fixture.database);
  fixture.database.exec("CREATE TRIGGER reject_regex_settings BEFORE UPDATE ON extension_settings BEGIN SELECT RAISE(ABORT,'edit settings failure'); END");
  const edit = () => fixture.app.inject({ method: "PATCH", url: `/api/conversations/${fixture.story.id}/messages/${source.id}`, payload: { content: "edit-target" } });
  expect((await edit()).statusCode).toBe(500); expect(snapshot(fixture.database)).toEqual(before);
  fixture.database.exec("DROP TRIGGER reject_regex_settings");
  const retried = await edit(); expect(retried.statusCode, retried.body).toBe(200);
  expect(retried.json().content).toBe("1/1/Changed");
  expect(retried.json().id).not.toBe(source.id);
});

it("does not persist output macro effects if the final message write fails", async () => {
  const fixture = await setup([rule({ placement: [2], findRegex: "/reply/g", replaceString: "{{incvar::output}}/{{incglobalvar::outputGlobal}}/Rewritten" })]);
  fixture.database.exec("CREATE TRIGGER reject_complete BEFORE UPDATE ON messages WHEN NEW.role='assistant' AND NEW.status='complete' BEGIN SELECT RAISE(ABORT,'output message failure'); END");
  const response = await fixture.send("continue"); expect(response.statusCode, response.body).toBe(200);
  expect(fixture.runtime.getConversation(fixture.story.id)?.messages.at(-1)?.status).toBe("failed");
  expect((fixture.runtime.getConversation(fixture.story.id)?.chatMetadata?.variables as Record<string, unknown> | undefined)?.output).toBeUndefined();
  expect((fixture.runtime.getExtensionSettings().variables as { global: Record<string, unknown> }).global.outputGlobal).toBeUndefined();
});

it("does not commit preflight regex effects when assistant placeholder creation fails", async () => {
  const fixture = await setup([rule({ replaceString: "{{incvar::input}}/{{incglobalvar::inputGlobal}}/Accepted input" })]);
  fixture.database.exec("CREATE TRIGGER reject_placeholder BEFORE INSERT ON messages WHEN NEW.role='assistant' AND NEW.status='streaming' BEGIN SELECT RAISE(ABORT,'placeholder failure'); END");
  const response = await fixture.send("input"); expect(response.statusCode, response.body).toBe(200);
  expect(fixture.requests).toHaveLength(0);
  expect((fixture.runtime.getConversation(fixture.story.id)?.chatMetadata?.variables as Record<string, unknown> | undefined)?.input).toBeUndefined();
  expect((fixture.runtime.getExtensionSettings().variables as { global: Record<string, unknown> }).global.inputGlobal).toBeUndefined();
});

it("cancels pathological input matching without persisting its staged find-macro effects", async () => {
  const fixture = await setup([rule({ findRegex: "{{setvar::pending::1}}^(a+)+$", substituteRegex: 1 })]);
  const before = snapshot(fixture.database), pending = fixture.send("a".repeat(60) + "!");
  await new Promise(resolve => setTimeout(resolve, 100));
  const stopped = await fixture.app.inject({ method: "POST", url: `/api/conversations/${fixture.story.id}/generation/stop` });
  expect(stopped.statusCode, stopped.body).toBe(200); await pending;
  expect(snapshot(fixture.database)).toEqual(before); expect(fixture.requests).toHaveLength(0);
});
