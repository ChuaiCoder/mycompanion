import { describe, expect, it } from "vitest";

import { characterDetailSchema } from "@mycompanion/shared";

import { buildApp } from "./app.js";
import { apps, commitCard, fullV2Card, type TestApp } from "./testing/helpers.js";

async function exportRawCard(app: TestApp, id: string) {
  const response = await app.inject({ method: "GET", url: `/api/characters/${id}/export?format=json` });
  expect(response.statusCode).toBe(200);
  return JSON.parse(response.body) as { data: Record<string, unknown> };
}

describe("PUT /api/characters/:id", () => {
  it("updates card fields, preserves unsubmitted extension keys and keeps the avatar stable", async () => {
    const app = buildApp();
    apps.push(app);
    const before = await commitCard(app, fullV2Card);
    const card = await exportRawCard(app, before.id);
    card.data.description = "更新后的描述。";
    // 提交时丢弃扩展键：服务端按编辑语义合并，已存扩展键必须保留。
    card.data.extensions = {};

    const response = await app.inject({ method: "PUT", url: `/api/characters/${before.id}`, payload: { card } });

    expect(response.statusCode, response.body).toBe(200);
    const detail = characterDetailSchema.parse(response.json());
    expect(detail.id).toBe(before.id);
    expect(detail.avatar).toBe(before.avatar);
    expect(detail.description).toBe("更新后的描述。");
    expect(detail.rawExtensions).toHaveProperty("regex_scripts");
    expect(Date.parse(detail.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt));
    const stored = await exportRawCard(app, before.id);
    expect(stored.data.description).toBe("更新后的描述。");
  });

  it("returns 404 for an unknown character and 422 for an invalid card", async () => {
    const app = buildApp();
    apps.push(app);

    const missing = await app.inject({
      method: "PUT",
      url: "/api/characters/00000000-0000-4000-8000-000000000000",
      payload: { card: fullV2Card },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("CHARACTER_NOT_FOUND");

    const character = await commitCard(app, fullV2Card);
    const invalid = await app.inject({
      method: "PUT",
      url: `/api/characters/${character.id}`,
      payload: { card: { spec: "chara_card_v2" } },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().error.code).toBe("INVALID_CHARACTER_CARD");
  });
});

describe("GET /characters/:avatar", () => {
  it("serves the character avatar image at the compatibility URL", async () => {
    const app = buildApp();
    apps.push(app);
    const character = await commitCard(app, fullV2Card);

    const response = await app.inject({ method: "GET", url: `/characters/${character.avatar}` });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/png");
    expect(response.rawPayload.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true);

    const missing = await app.inject({ method: "GET", url: "/characters/missing.png" });
    expect(missing.statusCode).toBe(404);
  });
});
