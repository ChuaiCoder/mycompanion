import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

type App = ReturnType<typeof buildApp>;
const apps: App[] = [], paths: string[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });
function instance() { const app = buildApp(); apps.push(app); return app; }
const embedded = () => ({ name: "Imported sky", future: { nested: [false, { v: 7 }] }, extensions: { imported: true }, entries: [
  { id: 12, keys: ["observatory"], content: "ACTIVE_SKY", constant: true, enabled: true, insertion_order: 100,
    extensions: { position: 4, depth: 0, role: 1, group: "sky", group_weight: 42, unknown: { list: [null, "kept"] } } },
  { id: "quiet", keys: ["observatory"], content: "DISABLED_SKY", constant: true, enabled: true, insertion_order: 90, extensions: {} },
] });
async function imported(app: App, book: unknown = embedded(), world?: string) {
  const response = await app.inject({ method: "POST", url: "/api/characters/import/commit", payload: { filename: "sky.json", card: {
    spec: "chara_card_v3", spec_version: "3.0", data: { name: "Astronomer", description: "Role", personality: "", scenario: "",
      first_mes: "Opening", mes_example: "", creator_notes: "", system_prompt: "", post_history_instructions: "", alternate_greetings: [],
      tags: [], creator: "Fixture", character_version: "1", extensions: { custom: { retained: true }, ...(world ? { world } : {}) },
      ...(book === undefined ? {} : { character_book: book }),
    },
  } } });
  expect(response.statusCode, response.body).toBe(201); return response.json();
}
const character = async (app: App, id: string) => (await app.inject({ method: "GET", url: `/api/characters/${id}` })).json();
const rawCard = async (app: App, id: string) => (await app.inject({ method: "GET", url: `/api/characters/${id}/export?format=json` })).json();
const names = async (app: App) => (await app.inject({ method: "GET", url: "/api/worldinfo/list" })).json().world_names;
const edit = (app: App, role: { id: string; updatedAt: string }, name = "Sky") => app.inject({ method: "POST", url: `/api/characters/${role.id}/worldinfo/edit`,
  payload: { name, expectedUpdatedAt: role.updatedAt } });

describe("editing embedded lore as an atomic named book", () => {
  it("preserves the source, unknown fields and effective enabled state, with only one prompt injection", async () => {
    const app = instance(), role = await imported(app);
    expect((await app.inject({ method: "PUT", url: `/api/characters/${role.id}/lorebook/0`, payload: { enabled: true } })).statusCode).toBe(200);
    const before = await rawCard(app, role.id), current = await character(app, role.id);
    const response = await edit(app, current, "Sky"); expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ name: "Sky", created: true, character: { id: role.id, rawExtensions: { world: "Sky" } } });
    const after = await rawCard(app, role.id); expect(after.data.character_book).toEqual(before.data.character_book);
    expect(after.data.extensions).toEqual({ ...before.data.extensions, world: "Sky" });
    const book = (await app.inject({ method: "POST", url: "/api/worldinfo/get", payload: { name: "Sky" } })).json();
    expect(book.originalData).toEqual(before.data.character_book);
    expect(book.entries[12]).toMatchObject({ disable: false, position: 4, depth: 0, role: 1, group: "sky", groupWeight: 42, extensions: { unknown: { list: [null, "kept"] } } });
    expect(book.entries.quiet.disable).toBe(true);
    const story = (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: role.id } })).json();
    const settings = (await app.inject({ method: "GET", url: "/api/worldinfo/settings" })).json();
    // Selecting the primary book globally must not activate the embedded source a second time.
    await app.inject({ method: "PUT", url: "/api/worldinfo/settings", payload: { ...settings, world_info: { globalSelect: ["Sky"], charLore: [] } } });
    const preview = await app.inject({ method: "POST", url: `/api/conversations/${story.id}/prompt-preview`, payload: { draft: "observatory" } });
    expect(preview.statusCode, preview.body).toBe(200);
    const text = JSON.stringify(preview.json().messages); expect(text.match(/ACTIVE_SKY/g)).toHaveLength(1); expect(text).not.toContain("DISABLED_SKY");
  });

  it("opens the existing binding without a write and rejects case-insensitive name collisions", async () => {
    const app = instance(), role = await imported(app);
    await app.inject({ method: "POST", url: "/api/worldinfo/edit", payload: { name: "SKY", data: { entries: { 9: { content: "existing" } } } } });
    expect((await edit(app, role, "sky")).statusCode).toBe(409);
    expect((await character(app, role.id)).updatedAt).toBe(role.updatedAt);
    const copied = await edit(app, role, "Distinct"); expect(copied.statusCode, copied.body).toBe(200);
    const reopened = await edit(app, copied.json().character, "Unused"); expect(reopened.statusCode).toBe(200);
    expect(reopened.json()).toEqual({ name: "Distinct", created: false, character: copied.json().character });
    expect(await names(app)).toEqual(["Distinct", "SKY"]);
    expect((await app.inject({ method: "POST", url: "/api/worldinfo/get", payload: { name: "SKY" } })).json()).toEqual({ entries: { 9: { content: "existing" } } });
  });

  it("never drops duplicated or absent imported entry IDs and leaves the original IDs untouched", async () => {
    const app = instance(), source = embedded();
    const extra = { keys: [], content: "MISSING_ID", enabled: true, insertion_order: 70, extensions: {} };
    const role = await imported(app, { ...source, entries: [...source.entries, { ...source.entries[0], content: "DUPLICATED_ID" }, extra] });
    const before = await rawCard(app, role.id), response = await edit(app, role); expect(response.statusCode, response.body).toBe(200);
    const book = (await app.inject({ method: "POST", url: "/api/worldinfo/get", payload: { name: "Sky" } })).json();
    expect(Object.values(book.entries).map((entry: any) => entry.content)).toEqual(["DUPLICATED_ID", "MISSING_ID", "ACTIVE_SKY", "DISABLED_SKY"]);
    expect(book.originalData).toEqual(before.data.character_book);
    expect((await rawCard(app, role.id)).data.character_book).toEqual(before.data.character_book);
  });

  for (const target of ["world_info_books", "characters"] as const) it(`rolls back a real SQL failure at ${target} and retries exactly once`, async () => {
    const path = mkdtempSync(join(tmpdir(), "mycompanion-world-editor-")); paths.push(path);
    const databasePath = join(path, "profile.sqlite"), app = buildApp({ databasePath }); apps.push(app);
    const role = await imported(app), before = await rawCard(app, role.id), db = new DatabaseSync(databasePath);
    try {
      db.exec(`CREATE TRIGGER fail_world_copy BEFORE ${target === "characters" ? "UPDATE" : "INSERT"} ON ${target} BEGIN SELECT RAISE(ABORT, 'actual fixture failure'); END;`);
      const failed = await edit(app, role); expect(failed.statusCode, failed.body).toBe(500);
      expect(failed.json().error.code).toBe("CHARACTER_WORLD_INFO_EDIT_FAILED"); expect(failed.body).not.toContain("actual fixture failure");
      expect(await names(app)).toEqual([]); expect(await rawCard(app, role.id)).toEqual(before);
      expect(await character(app, role.id)).toEqual(role);
      db.exec("DROP TRIGGER fail_world_copy");
      const retried = await edit(app, role); expect(retried.statusCode, retried.body).toBe(200); expect(await names(app)).toEqual(["Sky"]);
      expect((await edit(app, role)).statusCode).toBe(409); expect(await names(app)).toEqual(["Sky"]);
      expect((await edit(app, retried.json().character)).json().created).toBe(false);
    } finally { db.close(); }
  });

  it("rejects stale revisions and invalid names before writing", async () => {
    const app = instance(), role = await imported(app);
    const stale = await edit(app, { ...role, updatedAt: "old revision" }); expect(stale.statusCode).toBe(409);
    for (const name of ["   ", "///"])
      expect((await edit(app, role, name)).statusCode).toBe(400);
    expect(await names(app)).toEqual([]); expect((await character(app, role.id)).updatedAt).toBe(role.updatedAt);
  });
});
