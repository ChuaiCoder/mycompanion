import { describe, expect, it } from "vitest";

import {
  CharacterCardParseError,
  parseCharacterCard,
  parseCharacterCardDocument,
} from "./parse.js";

function v2Card(): Record<string, unknown> {
  return {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: "Aster",
      description: "A cartographer who maps impossible places.",
      personality: "Patient and curious.",
      scenario: "The user arrives at Aster's workshop.",
      first_mes: "The ink is still wet. Would you like to see the map?",
      mes_example: "<START>\n{{char}}: Mind the edge of the paper.",
      creator_notes: "An original fixture for MyCompanion tests.",
      system_prompt: "Stay in character.",
      post_history_instructions: "Continue naturally.",
      alternate_greetings: ["You found the hidden door."],
      tags: ["adventure", "original"],
      creator: "MyCompanion",
      character_version: "1.0",
      extensions: {
        regex_scripts: [
          {
            scriptName: "Compass cleanup",
            findRegex: "/northward/gi",
            replaceString: "north",
            placement: [1, 2, 99],
            runOnEdit: true,
          },
        ],
      },
      character_book: {
        name: "Atlas notes",
        extensions: {},
        entries: [
          {
            keys: ["workshop"],
            content: "The workshop is built inside an old observatory.",
            extensions: {},
            enabled: true,
            insertion_order: 100,
            name: "Old observatory",
            secondary_keys: ["telescope"],
          },
        ],
      },
      future_field: { preserved: true },
    },
  };
}

function v3Card(): Record<string, unknown> {
  return {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name: "Mira",
      description: "A lighthouse keeper.",
      personality: "Direct and warm.",
      scenario: "A storm approaches the island.",
      first_mes: "Help me close the western shutters.",
      mes_example: "",
      creator_notes: "Original test fixture.",
      system_prompt: "Stay in character.",
      post_history_instructions: "",
      alternate_greetings: [],
      tags: ["coastal"],
      creator: "MyCompanion",
      character_version: "1.0",
      extensions: {},
      group_only_greetings: ["Everyone, get inside!"],
      assets: [
        {
          type: "icon",
          uri: "https://example.invalid/mira.png",
          name: "main",
          ext: "png",
        },
      ],
      character_book: {
        extensions: {},
        entries: [
          {
            keys: ["lighthouse"],
            content: "The lighthouse lens was installed in 1892.",
            extensions: {},
            enabled: true,
            insertion_order: 50,
            use_regex: false,
          },
        ],
      },
    },
  };
}

describe("parseCharacterCard", () => {
  it("previews a V2 card while reporting extensions and unknown fields", () => {
    const preview = parseCharacterCard(v2Card());

    expect(preview).toMatchObject({
      format: "ccv2-json",
      specVersion: "2.0",
      name: "Aster",
      alternateGreetingsCount: 1,
      groupOnlyGreetingsCount: 0,
      lorebookEntryCount: 1,
      regexScriptCount: 1,
      lorebookEntries: [
        expect.objectContaining({
          name: "Old observatory",
          keys: ["workshop"],
          secondaryKeys: ["telescope"],
          runtimeState: "stored_inactive",
        }),
      ],
      regexScripts: [
        expect.objectContaining({
          name: "Compass cleanup",
          placements: ["user_input", "ai_output", "unknown:99"],
          runOnEdit: true,
          runtimeState: "stored_disabled",
        }),
      ],
      assetCount: 0,
      extensionKeys: ["regex_scripts"],
      unknownFieldPaths: ["data.future_field"],
    });
    expect(preview.warningCodes).toEqual([
      "unknown_fields_preserved",
      "extensions_present",
      "lorebook_stored_inactive",
      "regex_scripts_stored_disabled",
    ]);
  });

  it("previews V3 assets and group-only greetings without claiming support", () => {
    const preview = parseCharacterCard(v3Card());

    expect(preview).toMatchObject({
      format: "ccv3-json",
      name: "Mira",
      groupOnlyGreetingsCount: 1,
      lorebookEntryCount: 1,
      assetCount: 1,
    });
    expect(preview.warningCodes).toContain("v3_assets_not_imported");
    expect(preview.warningCodes).toContain("group_greetings_not_supported");
  });

  it("imports community V3 cards that omit defaultable required fields", () => {
    const input = v3Card();
    const data = input.data as Record<string, unknown>;
    delete data.group_only_greetings;
    const book = data.character_book as {
      extensions?: Record<string, unknown>;
      entries: Array<{ use_regex?: boolean }>;
    };
    delete book.extensions;
    delete book.entries[0]?.use_regex;

    const parsed = parseCharacterCardDocument(input);

    expect(parsed.preview.compatibilityDefaultPaths).toEqual([
      "data.group_only_greetings",
      "data.character_book.extensions",
      "data.character_book.entries.0.use_regex",
    ]);
    expect(parsed.preview.warningCodes).toContain(
      "compatibility_defaults_applied",
    );
    expect(parsed.card.data).not.toHaveProperty("group_only_greetings");
  });

  it("rejects an unsupported declared specification", () => {
    expect(() =>
      parseCharacterCard({
        spec: "chara_card_v9",
        spec_version: "9.0",
        data: {},
      }),
    ).toThrow(CharacterCardParseError);
  });

  it("reports the path of a missing required field", () => {
    const card = v2Card();
    const data = card.data as Record<string, unknown>;
    delete data.name;

    try {
      parseCharacterCard(card);
      expect.fail("Expected the malformed card to be rejected.");
    } catch (error) {
      expect(error).toBeInstanceOf(CharacterCardParseError);
      expect((error as CharacterCardParseError).issues).toEqual(
        expect.arrayContaining([expect.stringContaining("data.name")]),
      );
    }
  });

  it("truncates long preview text without splitting emoji", () => {
    const card = v2Card();
    const data = card.data as Record<string, unknown>;
    data.description = `${"界".repeat(499)}🧭more`;

    const preview = parseCharacterCard(card);

    expect(Array.from(preview.descriptionPreview)).toHaveLength(501);
    expect(preview.descriptionPreview.endsWith("🧭…")).toBe(true);
  });

  it("flags cards whose greetings carry a scripted frontend card", () => {
    const card = v2Card();
    const data = card.data as Record<string, unknown>;
    expect(parseCharacterCard(card).containsScripts).toBe(false);

    data.first_mes = "```html\n<html><head></head><body><p>开局</p><script>1</script></body></html>\n```";
    expect(parseCharacterCard(card).containsScripts).toBe(true);

    // 无脚本的纯界面卡不触发确认。
    data.first_mes = "```html\n<html><head></head><body><p>开局</p></body></html>\n```";
    expect(parseCharacterCard(card).containsScripts).toBe(false);

    // 备用开场白里的前端卡同样计数。
    data.first_mes = "你好。";
    data.alternate_greetings = ["```html\n<html><body><script>1</script></body></html>\n```"];
    expect(parseCharacterCard(card).containsScripts).toBe(true);
  });

  it("flags cards carrying a tavern_helper script library", () => {
    const card = v2Card();
    const data = card.data as Record<string, unknown>;
    const extensions = data.extensions as Record<string, unknown>;
    extensions.tavern_helper = { scripts: [{ name: "MVU", enabled: true, content: "import 'https://cdn.example/mvu.js';" }] };
    expect(parseCharacterCard(card).containsScripts).toBe(true);

    // 空脚本条目不算（内容被清掉的壳）。
    extensions.tavern_helper = { scripts: [{ name: "empty", content: "  " }] };
    expect(parseCharacterCard(card).containsScripts).toBe(false);
  });
});
