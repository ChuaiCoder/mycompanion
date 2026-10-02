import { describe, expect, it } from "vitest";

import {
  encodeCharacterCardPng,
  parseCharacterCardDocument,
} from "@mycompanion/character-card";

import { buildApp } from "./app.js";
import { apps, fullV2Card } from "./test-helpers.js";

describe("POST /api/characters/import/preview", () => {
  it("returns a structured V2 preview without persisting the card", async () => {
    const app = buildApp();
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/characters/import/preview",
      payload: {
        filename: "aster.json",
        card: {
          spec: "chara_card_v2",
          spec_version: "2.0",
          data: {
            name: "Aster",
            description: "A cartographer.",
            personality: "Curious.",
            scenario: "A workshop.",
            first_mes: "Welcome.",
            mes_example: "",
            creator_notes: "Original fixture.",
            system_prompt: "Stay in character.",
            post_history_instructions: "",
            alternate_greetings: [],
            tags: ["original"],
            creator: "MyCompanion",
            character_version: "1.0",
            extensions: {},
          },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      format: "ccv2-json",
      name: "Aster",
      lorebookEntryCount: 0,
      regexScriptCount: 0,
    });
  });

  it("returns validation details for a malformed card", async () => {
    const app = buildApp();
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/characters/import/preview",
      payload: {
        filename: "broken.json",
        card: {
          spec: "chara_card_v2",
          spec_version: "2.0",
          data: {},
        },
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: {
        code: "INVALID_CHARACTER_CARD",
      },
    });
  });

  it("validates PNG metadata through the HTTP endpoint", async () => {
    const app = buildApp();
    apps.push(app);
    const card = parseCharacterCardDocument(fullV2Card).card;
    const png = encodeCharacterCardPng(card);

    const response = await app.inject({
      method: "POST",
      url: "/api/characters/import/preview",
      headers: { "content-type": "image/png" },
      payload: Buffer.from(png),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      format: "ccv2-png",
      name: "阿斯特",
      lorebookEntryCount: 1,
      regexScriptCount: 1,
    });
  });
});
