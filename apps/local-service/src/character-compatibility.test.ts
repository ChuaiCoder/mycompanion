import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeCharacterCardPng, parseCharacterCardDocument, parseCharacterCardPngDocument } from "@mycompanion/character-card";
import { buildApp } from "./app.js";
import { backupChecksum } from "./backup.js";

type App = ReturnType<typeof buildApp>;
const apps: App[] = [];
const app = () => { const result = buildApp(); apps.push(result); return result; };
afterEach(async () => { for (const item of apps.splice(0)) await item.close(); vi.unstubAllGlobals(); });
async function form(instance: App, path: string, fields: Record<string, string | string[] | Blob>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const item of value) data.append(key + "[]", item);
    else data.append(key, value);
  }
  const request = new Request("http://localhost", { method: "POST", body: data });
  return instance.inject({ method: "POST", url: "/api/characters/" + path, headers: { "content-type": request.headers.get("content-type")! }, payload: Buffer.from(await request.arrayBuffer()) });
}
const read = async (instance: App, avatar: string) => (await instance.inject({ method: "POST", url: "/api/characters/get", payload: { avatar_url: avatar } })).json();
async function create(instance: App, name = "旅人", fields: Record<string, string | string[] | Blob> = {}) {
  const response = await form(instance, "create", { ch_name: name, ...fields });
  expect(response.statusCode, response.body).toBe(200);
  return response.body;
}
const sourceCard = () => parseCharacterCardDocument({ spec: "chara_card_v3", spec_version: "3.0", id: "original-card-identifier", avatar: "original-card-avatar", unknownRoot: { keep: 17 }, data: {
  name: "V3", description: "Before", personality: "Calm", scenario: "Observatory", first_mes: "Hello", mes_example: "EXAMPLE", creator_notes: "notes",
  system_prompt: "SYSTEM", post_history_instructions: "POST", alternate_greetings: ["Other"], tags: ["tag"], creator: "Author", character_version: "3",
  extensions: { custom: { untouched: true }, tavern_helper: { scripts: ["preserved"], variables: { score: 1 } }, regex_scripts: [
    { id: "rule-a", scriptName: "A", findRegex: "x", replaceString: "y", placement: [1], disabled: false },
    { id: "rule-b", scriptName: "B", findRegex: "y", replaceString: "z", placement: [1], disabled: true },
  ] }, unknownData: [3, 2], assets: [{ type: "icon", uri: "embed://x", name: "x", ext: "png" }],
  character_book: { name: "inside", entries: [{ id: 4, keys: ["star"], content: "embedded", extensions: {}, enabled: true, insertion_order: 10 }] },
} });

describe("independent Tavern character storage", () => {
  it("replaces complete helper extension documents so deleted variables and arrays stay deleted", async () => {
    const instance = app(), avatar = await create(instance, "Variables", { json_data: JSON.stringify(sourceCard().card) });
    const extensions = (await read(instance, avatar)).data.extensions;
    delete extensions.tavern_helper.variables.score;
    extensions.tavern_helper.scripts = []; extensions.regex_scripts = [];
    const saved = await form(instance, "edit", { avatar_url: avatar, extensions: JSON.stringify(extensions) });
    expect(saved.statusCode, saved.body).toBe(200);
    const result = (await read(instance, avatar)).data.extensions;
    expect(result.tavern_helper.variables).toEqual({}); expect(result.tavern_helper.scripts).toEqual([]);
    expect(result.regex_scripts).toEqual([]); expect(result.custom).toEqual({ untouched: true });
  });

  it("preserves an unbound embedded book when a real edit form submits the empty world selector", async () => {
    const instance = app(), avatar = await create(instance, "Embedded", { json_data: JSON.stringify(sourceCard().card) });
    const character = await read(instance, avatar);
    const saved = await form(instance, "edit", { avatar_url: avatar, json_data: character.json_data, description: "Keep the book", world: "" });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await read(instance, avatar)).data.character_book).toEqual(character.data.character_book);
  });
  it("accepts actual helper multipart fields, stable avatars, duplicate display names and array clearing", async () => {
    const instance = app(), avatar = await create(instance, "旅人", { first_mes: "Hi", alternate_greetings: ["A", "B"], tags: ["one", "two"] });
    const duplicate = await create(instance, "旅人"); expect(duplicate).not.toBe(avatar);
    const before = await read(instance, avatar);
    expect(before.data.alternate_greetings).toEqual(["A", "B"]); expect(before.data.tags).toEqual(["one", "two"]);
    const changed = await form(instance, "edit", { avatar_url: avatar, ch_name: "新名字", first_mes: "Changed", alternate_greetings: [] });
    expect(changed.statusCode, changed.body).toBe(200);
    const after = await read(instance, avatar);
    expect(after.id).toBe(before.id); expect(after.avatar).toBe(avatar); expect(after.name).toBe("新名字");
    expect(after.data.alternate_greetings).toEqual([]);
    const emptied = await form(instance, "edit", { avatar_url: avatar, json_data: before.json_data, first_mes: "Empty greetings override the stale snapshot", tags: "one, two, " });
    expect(emptied.statusCode, emptied.body).toBe(200);
    const fromForm = await read(instance, avatar);
    expect(fromForm.data.alternate_greetings).toEqual([]); expect(fromForm.data.tags).toEqual(["one", "two"]);
    expect((await instance.inject({ method: "POST", url: "/api/characters/all", payload: {} })).json()).toHaveLength(2);
  });

  it("preserves V3, unknown metadata, extension variables and image bytes across edit, PNG export and restore", async () => {
    const instance = app(), card = sourceCard(), png = encodeCharacterCardPng(card.card);
    const avatar = await create(instance, "V3", { json_data: JSON.stringify(card.card), avatar: new Blob([Buffer.from(png)], { type: "image/png" }) });
    const original = await read(instance, avatar);
    const response = await form(instance, "edit", { avatar_url: avatar, json_data: original.json_data, description: "Changed", extensions: JSON.stringify({ tavern_helper: { variables: { score: 9 } } }) });
    expect(response.statusCode, response.body).toBe(200);
    const updated = await read(instance, avatar);
    expect(updated.spec).toBe("chara_card_v3"); expect(updated.unknownRoot).toEqual({ keep: 17 });
    expect(updated.data.assets).toEqual(card.card.data.assets); expect(updated.data.unknownData).toEqual([3, 2]);
    expect(updated.data.extensions.tavern_helper).toEqual({ scripts: ["preserved"], variables: { score: 9 } });
    expect(updated.data.description).toBe("Changed"); expect(updated.description).toBe("Changed");
    const document = JSON.parse(updated.json_data); expect(document.id).toBe("original-card-identifier"); expect(document.avatar).toBe("original-card-avatar");
    await form(instance, "edit", { avatar_url: avatar, json_data: updated.json_data, description: "Changed" });
    const exported = await instance.inject({ method: "GET", url: `/api/characters/${original.id}/export?format=png` });
    expect(exported.statusCode).toBe(200); expect(parseCharacterCardPngDocument(exported.rawPayload).card.data.description).toBe("Changed");
    const backup = (await instance.inject({ method: "GET", url: "/api/backup" })).json();
    expect(backup.characters[0].sourcePngBase64).toBe(Buffer.from(png).toString("base64")); expect(backup.characters[0].avatar).toBe(avatar);
    const target = app(); const restored = await target.inject({ method: "POST", url: "/api/backup/restore", payload: { backup, strategy: "overwrite" } });
    expect(restored.statusCode, restored.body).toBe(200); expect((await read(target, avatar)).data).toEqual(updated.data);
    const detail = (await target.inject({ method: "GET", url: `/api/characters/${original.id}` })).json();
    expect(detail.sourceFormat).toBe("ccv3-png"); expect(detail.sourceVersion).toBe("3.0");
    expect(detail.lorebookEntryCount).toBe(1); expect(detail.regexScriptCount).toBe(2); expect(detail.unknownFieldPaths).toContain("unknownRoot");
  });

  it("keeps imported runtime switches through metadata edits and honors explicitly submitted regex switches", async () => {
    const instance = app();
    const imported = (await instance.inject({ method: "POST", url: "/api/characters/import/commit", payload: { filename: "v3.json", card: sourceCard().card } })).json();
    expect(imported.avatar).toBe(`${imported.id}.png`);
    const avatar = imported.avatar;
    expect((await read(instance, avatar)).data.extensions.regex_scripts.every((rule: { disabled: boolean }) => rule.disabled)).toBe(true);
    await form(instance, "edit", { avatar_url: avatar, description: "Metadata only" });
    expect((await read(instance, avatar)).data.extensions.regex_scripts.every((rule: { disabled: boolean }) => rule.disabled)).toBe(true);
    const extensions = (await read(instance, avatar)).data.extensions;
    extensions.regex_scripts.reverse(); extensions.regex_scripts[0].disabled = false;
    await form(instance, "edit", { avatar_url: avatar, extensions: JSON.stringify(extensions) });
    const effective = (await read(instance, avatar)).data.extensions.regex_scripts;
    expect(effective.map((rule: { id: string; disabled: boolean }) => [rule.id, rule.disabled])).toEqual([["rule-b", false], ["rule-a", true]]);
  });

  it("binds primary and avatar-named auxiliary worldbooks to real prompt requests and clears the embedded snapshot on unbind", async () => {
    const instance = app(), avatar = await create(instance, "Bound", { description: "OLD_DESCRIPTION", first_mes: "Hello" });
    const character = await read(instance, avatar);
    const conversation = (await instance.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } })).json();
    for (const name of ["primary", "extra"]) await instance.inject({ method: "POST", url: "/api/worldinfo/edit", payload: {
      name, data: { entries: { 9: { uid: 9, key: ["star"], content: name.toUpperCase() + "_LORE", position: 1, order: 100 } } },
    } });
    const settings = (await instance.inject({ method: "GET", url: "/api/worldinfo/settings" })).json();
    settings.world_info.charLore = [{ name: avatar.replace(/\.png$/, ""), extraBooks: ["extra"] }];
    await instance.inject({ method: "PUT", url: "/api/worldinfo/settings", payload: settings });
    const edited = await form(instance, "edit", { avatar_url: avatar, ch_name: "Renamed", description: "NEW_DESCRIPTION", world: "primary" });
    expect(edited.statusCode, edited.body).toBe(200);
    expect((await read(instance, avatar)).data.character_book.entries[0].content).toBe("PRIMARY_LORE");
    await instance.inject({ method: "PUT", url: "/api/settings/provider", payload: { baseUrl: "https://model.invalid/v1", model: "fixture", apiKey: "fixture", contextLimitTokens: 8192, maxTokens: 100 } });
    let sent = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, options: RequestInit) => {
      sent = String(options.body); return new Response(JSON.stringify({ choices: [{ message: { content: "Reply" } }] }), { headers: { "Content-Type": "application/json" } });
    }));
    const generated = await instance.inject({ method: "POST", url: `/api/conversations/${conversation.id}/messages`, payload: { content: "star" } });
    expect(generated.statusCode, generated.body).toBe(200);
    expect(sent).toContain("NEW_DESCRIPTION"); expect(sent).not.toContain("OLD_DESCRIPTION"); expect(sent).toContain("PRIMARY_LORE"); expect(sent).toContain("EXTRA_LORE");
    await form(instance, "edit", { avatar_url: avatar, world: "" });
    const unbound = await read(instance, avatar); expect(unbound.data.character_book).toBeUndefined(); expect(unbound.data.extensions.world).toBe("");
    const prompt = (await instance.inject({ method: "POST", url: `/api/conversations/${conversation.id}/prompt-preview`, payload: { draft: "star" } })).json();
    expect(JSON.stringify(prompt.messages)).not.toContain("PRIMARY_LORE"); expect(JSON.stringify(prompt.messages)).toContain("EXTRA_LORE");
    expect((await instance.inject({ method: "GET", url: `/api/conversations/${conversation.id}` })).json().characterName).toBe("Renamed");
  });

  it("rejects invalid edits and avatar paths without partially overwriting a card", async () => {
    const instance = app(), avatar = await create(instance), original = await read(instance, avatar);
    for (const fields of [{ description: "Must not save", extensions: "{" }, { ch_name: "" }, { json_data: '{"data":null}' }, { avatar: new Blob(["bad png"], { type: "image/png" }) }]) {
      expect((await form(instance, "edit", { avatar_url: avatar, ...fields })).statusCode).toBe(400);
      expect((await read(instance, avatar)).data).toEqual(original.data);
    }
    expect((await read(instance, "../../outside.png")).error).toBe("Character not found");
    const image = await instance.inject({ method: "GET", url: `/thumbnail?type=avatar&file=${encodeURIComponent(avatar)}` });
    expect(image.headers["content-type"]).toContain("image/png"); expect(image.rawPayload.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });

  it("lists and reads the real selected-branch chat with metadata and enforces character ownership", async () => {
    const instance = app(), avatar = await create(instance, "Story", { first_mes: "Real greeting" }), other = await create(instance, "Other");
    const character = await read(instance, avatar);
    const conversation = (await instance.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } })).json();
    const histories = (await instance.inject({ method: "POST", url: "/api/characters/chats", payload: { avatar_url: avatar } })).json();
    expect(histories[0].file_name).toBe(`${conversation.id}.jsonl`);
    const history = (await instance.inject({ method: "POST", url: "/api/chats/get", payload: { avatar_url: avatar, file_name: conversation.id } })).json();
    expect(history[0].character_name).toBe("Story"); expect(history[1].mes).toBe("Real greeting");
    expect((await instance.inject({ method: "POST", url: "/api/chats/get", payload: { avatar_url: other, file_name: conversation.id } })).statusCode).toBe(404);
  });

  it("migrates old SQLite identities, reopens modified cards, and reads legacy backups without an avatar field", async () => {
    const path = join(tmpdir(), `character-compat-${randomUUID()}.sqlite`);
    let instance = buildApp({ databasePath: path });
    try {
      const avatar = await create(instance), character = await read(instance, avatar);
      await instance.close();
      const database = new DatabaseSync(path); database.exec("DROP INDEX characters_avatar; ALTER TABLE characters DROP COLUMN avatar"); database.close();
      instance = buildApp({ databasePath: path });
      const migrated = `${character.id}.png`;
      expect((await read(instance, migrated)).id).toBe(character.id);
      await form(instance, "edit", { avatar_url: migrated, description: "After reopen" });
      const backup = (await instance.inject({ method: "GET", url: "/api/backup" })).json(); delete backup.characters[0].avatar; backup.manifest.checksum = backupChecksum(backup);
      await instance.close(); instance = buildApp({ databasePath: path });
      expect((await read(instance, migrated)).description).toBe("After reopen");
      const target = app(); expect((await target.inject({ method: "POST", url: "/api/backup/restore", payload: { backup, strategy: "overwrite" } })).statusCode).toBe(200);
      expect((await read(target, migrated)).id).toBe(character.id);
    } finally { await instance.close(); for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true }); }
  });

  it("rejects avatar collisions in backups before any character is written", async () => {
    const source = app(), target = app(); await create(source, "Same"); await create(target, "Same");
    const backup = (await source.inject({ method: "GET", url: "/api/backup" })).json();
    const preview = await target.inject({ method: "POST", url: "/api/backup/restore/preview", payload: { backup, strategy: "overwrite" } });
    expect(preview.json().valid).toBe(false);
    expect((await target.inject({ method: "POST", url: "/api/backup/restore", payload: { backup, strategy: "overwrite" } })).statusCode).toBe(422);
    expect((await target.inject({ method: "GET", url: "/api/characters" })).json().total).toBe(1);
  });
});
