import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseCharacterCardDocument,
  parseCharacterCardPngDocument,
} from "@mycompanion/character-card";
import {
  characterDetailSchema,
  characterListResponseSchema,
} from "@mycompanion/shared";

import { buildApp } from "./app.js";
import { apps, fullV2Card } from "./test-helpers.js";

describe("character persistence and export", () => {
  it("does not persist a preview, then commits and reads the full character", async () => {
    const app = buildApp();
    apps.push(app);
    const payload = { filename: "ccv2-full.json", card: fullV2Card };

    const preview = await app.inject({
      method: "POST",
      url: "/api/characters/import/preview",
      payload,
    });
    expect(preview.statusCode).toBe(200);

    const emptyList = await app.inject({
      method: "GET",
      url: "/api/characters",
    });
    expect(characterListResponseSchema.parse(emptyList.json()).total).toBe(0);

    const commit = await app.inject({
      method: "POST",
      url: "/api/characters/import/commit",
      headers: { "idempotency-key": "card-import-1" },
      payload,
    });
    expect(commit.statusCode).toBe(201);
    const character = characterDetailSchema.parse(commit.json());
    expect(character).toMatchObject({
      name: "阿斯特",
      sourceFormat: "ccv2-json",
      alternateGreetingsCount: 1,
      lorebookEntryCount: 1,
      regexScriptCount: 1,
      unknownFieldPaths: ["data.x_mycompanion_fixture"],
    });

    const list = await app.inject({ method: "GET", url: "/api/characters" });
    expect(characterListResponseSchema.parse(list.json())).toMatchObject({
      total: 1,
      items: [{ id: character.id, name: "阿斯特" }],
    });

    const detail = await app.inject({
      method: "GET",
      url: `/api/characters/${character.id}`,
    });
    expect(characterDetailSchema.parse(detail.json())).toEqual(character);
  });

  it("makes repeated commits idempotent and rejects key reuse for other content", async () => {
    const app = buildApp();
    apps.push(app);
    const payload = { filename: "ccv2-full.json", card: fullV2Card };
    const headers = { "idempotency-key": "retry-safe-key" };

    const first = await app.inject({
      method: "POST",
      url: "/api/characters/import/commit",
      headers,
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/characters/import/commit",
      headers,
      payload,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.headers["idempotency-replayed"]).toBe("true");
    expect(second.json()).toMatchObject({ id: first.json().id });

    const changed = structuredClone(fullV2Card) as {
      data: { name: string };
    };
    changed.data.name = "另一个角色";
    const conflict = await app.inject({
      method: "POST",
      url: "/api/characters/import/commit",
      headers,
      payload: { filename: "changed.json", card: changed },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { code: "IDEMPOTENCY_CONFLICT" },
    });

    const list = await app.inject({ method: "GET", url: "/api/characters" });
    expect(characterListResponseSchema.parse(list.json()).total).toBe(1);
  });

  it("round-trips unknown fields through JSON and PNG exports", async () => {
    const app = buildApp();
    apps.push(app);
    const commit = await app.inject({
      method: "POST",
      url: "/api/characters/import/commit",
      payload: { filename: "ccv2-full.json", card: fullV2Card },
    });
    const character = characterDetailSchema.parse(commit.json());
    const expectedCard = parseCharacterCardDocument(fullV2Card).card;

    const jsonExport = await app.inject({
      method: "GET",
      url: `/api/characters/${character.id}/export?format=json`,
    });
    expect(jsonExport.statusCode).toBe(200);
    expect(jsonExport.headers["content-type"]).toContain("application/json");
    expect(jsonExport.json()).toEqual(expectedCard);

    const pngExport = await app.inject({
      method: "GET",
      url: `/api/characters/${character.id}/export?format=png`,
    });
    expect(pngExport.statusCode).toBe(200);
    expect(pngExport.headers["content-type"]).toContain("image/png");
    const reparsed = parseCharacterCardPngDocument(pngExport.rawPayload);
    expect(reparsed.card).toEqual(expectedCard);
  });

  it("keeps committed characters after the local service reopens its SQLite database", async () => {
    const databasePath = join(
      tmpdir(),
      `mycompanion-character-test-${randomUUID()}.sqlite`,
    );

    try {
      const firstApp = buildApp({ databasePath });
      const commit = await firstApp.inject({
        method: "POST",
        url: "/api/characters/import/commit",
        payload: { filename: "ccv2-full.json", card: fullV2Card },
      });
      expect(commit.statusCode).toBe(201);
      await firstApp.close();

      const reopenedApp = buildApp({ databasePath });
      const list = await reopenedApp.inject({
        method: "GET",
        url: "/api/characters",
      });
      expect(characterListResponseSchema.parse(list.json())).toMatchObject({
        total: 1,
        items: [{ name: "阿斯特" }],
      });
      await reopenedApp.close();
    } finally {
      rmSync(databasePath, { force: true });
      rmSync(`${databasePath}-shm`, { force: true });
      rmSync(`${databasePath}-wal`, { force: true });
    }
  });
});
