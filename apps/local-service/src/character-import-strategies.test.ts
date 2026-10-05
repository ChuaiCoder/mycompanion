import { describe, expect, it, vi } from "vitest";
import { encodeCharacterCardPng } from "@mycompanion/character-card";
import { buildApp } from "./app.js";
import { CharacterRepository } from "./character/character-repository.js";
import { apps, fullV2Card } from "./testing/helpers.js";

const payload = (card: unknown = fullV2Card) => ({ filename: "original.json", card });
const setup = () => { const app = buildApp({ databasePath: ":memory:" }); apps.push(app); return app; };
type App = ReturnType<typeof setup>;
async function commit(app: App, card: unknown = fullV2Card, key?: string, query = "") {
  return app.inject({ method: "POST", url: "/api/characters/import/commit" + query,
    payload: payload(card), ...(key ? { headers: { "Idempotency-Key": key } } : {}) });
}
const replacementQuery = (character: { id: string; updatedAt: string }) =>
  `?mode=replace&targetId=${character.id}&expectedUpdatedAt=${encodeURIComponent(character.updatedAt)}`;

describe("character import strategies", () => {
  it("reports exact and same-name duplicates without writing preview data", async () => {
    const app = setup(); const original = (await commit(app)).json();
    const exact = (await app.inject({ method: "POST", url: "/api/characters/import/preview", payload: payload() })).json();
    expect(exact.duplicates).toEqual([{ id: original.id, name: original.name, updatedAt: original.updatedAt, match: "exact" }]);
    const changed = structuredClone(fullV2Card) as any; changed.data.description = "A changed description.";
    const preview = (await app.inject({ method: "POST", url: "/api/characters/import/preview", payload: payload(changed) })).json();
    expect(preview.duplicates[0].match).toBe("same-name");
    expect((await app.inject({ method: "GET", url: "/api/characters" })).json().total).toBe(1);
  });

  it("copies by default while an explicit replace keeps the story identity and unknown fields", async () => {
    const app = setup(); const initial = structuredClone(fullV2Card) as any;
    initial.unknown_top = { retained: true }; initial.data.unknown_data = { retained: true };
    initial.data.extensions.local_extra = { old: 1, shared: "old" };
    const first = (await commit(app, initial)).json();
    const story = (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: first.id } })).json();
    const incoming = structuredClone(fullV2Card) as any;
    incoming.data.name = "Updated cartographer"; incoming.data.extensions.local_extra = { added: 2, shared: "new" };
    const replaced = await commit(app, incoming, "replace-once", replacementQuery(first));
    expect(replaced.statusCode).toBe(201); expect(replaced.json().id).toBe(first.id);
    expect(replaced.json().avatar).toBe(first.avatar);
    const exported = (await app.inject({ method: "GET", url: `/api/characters/${first.id}/export` })).json();
    expect(exported).toMatchObject({ unknown_top: { retained: true }, data: { unknown_data: { retained: true },
      extensions: { local_extra: { old: 1, added: 2, shared: "new" } } } });
    const savedStory = (await app.inject({ method: "GET", url: `/api/conversations/${story.id}` })).json();
    expect(savedStory.characterId).toBe(first.id); expect(savedStory.characterName).toBe(incoming.data.name);
    const copy = (await commit(app, incoming)).json(); expect(copy.id).not.toBe(first.id);
    expect((await app.inject({ method: "GET", url: "/api/characters" })).json().total).toBe(2);
  });

  it("replays a replacement despite its changed preview version, but rejects a different action under the same key", async () => {
    const app = setup(); const original = (await commit(app)).json(); const query = replacementQuery(original);
    const first = await commit(app, fullV2Card, "same-action", query);
    const replay = await commit(app, fullV2Card, "same-action", query);
    expect(replay.statusCode).toBe(200); expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(replay.json()).toEqual(first.json());
    expect((await commit(app, fullV2Card, "same-action")).statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: "/api/characters" })).json().total).toBe(1);
  });

  it("rejects a stale preview before changing the target", async () => {
    const app = setup(); const original = (await commit(app)).json(); const query = replacementQuery(original);
    await commit(app, fullV2Card, undefined, query);
    const before = (await app.inject({ method: "GET", url: `/api/characters/${original.id}/export` })).json();
    const changed = structuredClone(fullV2Card) as any; changed.data.name = "Must not overwrite";
    const stale = await commit(app, changed, undefined, query);
    expect(stale.statusCode).toBe(409); expect(stale.json().error.code).toBe("CHARACTER_VERSION_CONFLICT");
    expect((await app.inject({ method: "GET", url: `/api/characters/${original.id}/export` })).json()).toEqual(before);
  });

  it("rolls back target and story changes if the replacement fails after update", async () => {
    const app = setup(); const original = (await commit(app)).json();
    const update = CharacterRepository.prototype.update;
    const spy = vi.spyOn(CharacterRepository.prototype, "update").mockImplementation(function (this: CharacterRepository, ...args) {
      update.apply(this, args); throw new Error("injected after update");
    });
    const incoming = structuredClone(fullV2Card) as any; incoming.data.name = "Failed replacement";
    try { expect((await commit(app, incoming, "retryable", replacementQuery(original))).statusCode).toBe(500); }
    finally { spy.mockRestore(); }
    expect((await app.inject({ method: "GET", url: `/api/characters/${original.id}` })).json()).toEqual(original);
    expect((await commit(app, incoming, "retryable", replacementQuery(original))).statusCode).toBe(201);
  });

  it("preserves the original PNG image when a JSON card replaces its metadata", async () => {
    const app = setup(); const originalCard = structuredClone(fullV2Card) as any;
    const image = encodeCharacterCardPng(originalCard);
    const imported = await app.inject({ method: "POST", url: "/api/characters/import/commit", payload: Buffer.from(image), headers: { "Content-Type": "image/png" } });
    const original = imported.json(); const updated = structuredClone(fullV2Card) as any; updated.data.description = "New metadata";
    await commit(app, updated, undefined, replacementQuery(original));
    const raw = (await app.inject({ method: "GET", url: `/api/characters/${original.id}/export` })).json();
    const png = await app.inject({ method: "GET", url: `/api/characters/${original.id}/export?format=png` });
    expect(png.rawPayload).toEqual(Buffer.from(encodeCharacterCardPng(raw, image)));
  });

  it.each(["?mode=replace", "?mode=unknown", "?mode=copy&targetId=not-a-uuid"])("rejects invalid import strategy %s", async query => {
    const app = setup(); expect((await commit(app, fullV2Card, undefined, query)).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/characters" })).json().total).toBe(0);
  });
});
