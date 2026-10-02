import { describe, expect, it } from "vitest";

import {
  apiErrorResponseSchema,
  characterCardPreviewRequestSchema,
  characterCardPreviewResponseSchema,
  characterDetailSchema,
  characterListResponseSchema,
} from "./character-card.js";

describe("character card API contracts", () => {
  it("accepts an unknown card payload for server-side validation", () => {
    expect(
      characterCardPreviewRequestSchema.parse({
        filename: "aster.json",
        card: { spec: "chara_card_v2" },
      }).filename,
    ).toBe("aster.json");
  });

  it("rejects undocumented request properties", () => {
    expect(() =>
      characterCardPreviewRequestSchema.parse({
        filename: "aster.json",
        card: {},
        ownerId: "another-user",
      }),
    ).toThrow();
  });

  it("keeps preview and error responses machine-readable", () => {
    expect(
      characterCardPreviewResponseSchema.parse({
        format: "ccv2-json",
        specVersion: "2.0",
        name: "Aster",
        descriptionPreview: "A cartographer.",
        firstMessagePreview: "Welcome.",
        creator: "MyCompanion",
        characterVersion: "1.0",
        tags: ["adventure"],
        alternateGreetingsCount: 1,
        groupOnlyGreetingsCount: 0,
        lorebookEntryCount: 0,
        regexScriptCount: 0,
        lorebookEntries: [],
        regexScripts: [],
        assetCount: 0,
        extensionKeys: [],
        unknownFieldPaths: [],
        warningCodes: [],
      }).name,
    ).toBe("Aster");

    expect(
      apiErrorResponseSchema.parse({
        error: {
          code: "INVALID_CHARACTER_CARD",
          message: "The character card is invalid.",
          details: ["data.name: expected string"],
        },
      }).error.code,
    ).toBe("INVALID_CHARACTER_CARD");
  });

  it("validates list and detail timestamps and identifiers", () => {
    const detail = characterDetailSchema.parse({
      id: "00000000-0000-4000-8000-000000000001",
      name: "Aster",
      description: "A cartographer.",
      personality: "Curious.",
      scenario: "A workshop.",
      firstMessage: "Welcome.",
      alternateGreetings: [],
      alternateGreetingsCount: 0,
      exampleDialogue: "",
      systemPrompt: "Stay in character.",
      postHistoryInstructions: "",
      creatorNotes: "Original fixture.",
      tags: ["original"],
      creator: "MyCompanion",
      characterVersion: "1.0",
      sourceFormat: "ccv2-json",
      sourceVersion: "2.0",
      rawExtensions: {},
      unknownFieldPaths: [],
      regexEnabled: [],
      lorebookEnabled: [],
      lorebookEntryCount: 0,
      regexScriptCount: 0,
      lorebookEntries: [],
      regexScripts: [],
      deletedAt: null,
      createdAt: "2026-09-17T00:00:00.000Z",
      updatedAt: "2026-09-17T00:00:00.000Z",
    });

    expect(
      characterListResponseSchema.parse({ items: [detail], total: 1 }).total,
    ).toBe(1);
  });
});
