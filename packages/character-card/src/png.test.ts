import { Buffer } from "node:buffer";
import { crc32 } from "node:zlib";

import * as textChunk from "png-chunk-text";
import extractChunks from "png-chunks-extract";
import { describe, expect, it } from "vitest";

import { CharacterCardParseError } from "./parse.js";
import { parseCharacterCardDocument } from "./parse.js";
import {
  encodeCharacterCardPng,
  parseCharacterCardPng,
  parseCharacterCardPngDocument,
} from "./png.js";

const transparentPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function v2Card(name = "Aster"): Record<string, unknown> {
  return {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name,
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
  };
}

function v3Card(): Record<string, unknown> {
  return {
    ...v2Card("Mira"),
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      ...(v2Card("Mira").data as Record<string, unknown>),
      group_only_greetings: [],
    },
  };
}

function embedTextChunks(
  entries: Array<{ keyword: string; value: string }>,
): Uint8Array {
  const chunks = extractChunks(transparentPng);
  chunks.splice(
    chunks.length - 1,
    0,
    ...entries.map(({ keyword, value }) => textChunk.encode(keyword, value)),
  );
  const encodedChunks = chunks.map((chunk) => {
    const type = Buffer.from(chunk.name, "ascii");
    const data = Buffer.from(chunk.data);
    const encoded = Buffer.alloc(12 + data.length);
    encoded.writeUInt32BE(data.length, 0);
    type.copy(encoded, 4);
    data.copy(encoded, 8);
    encoded.writeUInt32BE(crc32(Buffer.concat([type, data])) >>> 0, 8 + data.length);
    return encoded;
  });

  return Buffer.concat([transparentPng.subarray(0, 8), ...encodedChunks]);
}

function encodeCard(card: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(card), "utf8").toString("base64");
}

describe("parseCharacterCardPng", () => {
  it("roundtrips V3 standard embedded assets, empty files and unknown metadata without changing bytes", () => {
    const input=v3Card(); (input.data as Record<string,unknown>).assets=[{type:"icon",name:"main",ext:"png",uri:"ccdefault:"},
      {type:"audio",name:"voice",ext:"wav",uri:"__asset:assets/audio/voice.wav",custom:{retained:true}}];
    const card=parseCharacterCardDocument(input).card;
    const assets=new Map<string,Uint8Array>([["assets/audio/voice.wav",Buffer.from([1,2,3,255])],["empty.bin",Buffer.alloc(0)],["private-script.js",Buffer.from("throw new Error('never run')")]]);
    const encoded=encodeCharacterCardPng(card,undefined,assets), parsed=parseCharacterCardPngDocument(encoded);
    expect(parsed.card).toEqual(card); expect(parsed.assets).toEqual(assets);
    expect(parsed.preview.importedAssetCount).toBe(3); expect(parsed.preview.warningCodes).not.toContain("v3_assets_not_imported");
    expect(parseCharacterCardPngDocument(encodeCharacterCardPng(parsed.card,encoded,parsed.assets)).assets).toEqual(assets);
  });
  it("reads Risu's old asset chunk alias while retaining the exact URI", () => {
    const input=v3Card(); (input.data as Record<string,unknown>).assets=[{type:"icon",name:"main",ext:"png",uri:"__asset:1"}];
    const parsed=parseCharacterCardPngDocument(embedTextChunks([{keyword:"ccv3",value:encodeCard(input)},{keyword:"chara-ext-asset_1",value:"AAEC"}]));
    expect(parsed.assets?.get("1")).toEqual(Buffer.from([0,1,2]));
    expect(parsed.card.data.assets).toEqual((input.data as Record<string,unknown>).assets);
  });
  it("rejects unsafe, duplicate, corrupt or missing embedded PNG assets", () => {
    const input=v3Card(); (input.data as Record<string,unknown>).assets=[{type:"audio",name:"voice",ext:"wav",uri:"__asset:1"}];
    const root={keyword:"ccv3",value:encodeCard(input)};
    expect(()=>parseCharacterCardPngDocument(embedTextChunks([root]))).toThrow("missing a referenced");
    expect(()=>parseCharacterCardPngDocument(embedTextChunks([root,{keyword:"chara-ext-asset_:../1",value:"AAEC"}]))).toThrow("unsafe");
    expect(()=>parseCharacterCardPngDocument(embedTextChunks([root,{keyword:"chara-ext-asset_:1",value:"AAEC"},{keyword:"chara-ext-asset_1",value:"AAEC"}]))).toThrow("duplicate");
    expect(()=>parseCharacterCardPngDocument(embedTextChunks([root,{keyword:"chara-ext-asset_:1",value:"AB=="}]))).toThrow("base64");
  });
  it("replaces old chunks and explicitly refuses unrepresentable PNG paths instead of dropping files", () => {
    const card=parseCharacterCardDocument(v3Card()).card;
    const old=encodeCharacterCardPng(card,undefined,new Map([["old.bin",Buffer.from([1])]]));
    const changed=encodeCharacterCardPng(card,old,new Map([["new.bin",Buffer.from([2])]]));
    expect([...parseCharacterCardPngDocument(changed).assets!.keys()]).toEqual(["new.bin"]);
    for(const path of ["assets/"+"a".repeat(80),"assets/头像.png"])
      expect(()=>encodeCharacterCardPng(card,undefined,new Map([[path,Buffer.from([1])]]))).toThrow("export CHARX");
  });
  it("reads a V2 card from the chara text chunk", () => {
    const png = embedTextChunks([
      { keyword: "chara", value: encodeCard(v2Card()) },
    ]);

    expect(parseCharacterCardPng(png)).toMatchObject({
      format: "ccv2-png",
      name: "Aster",
    });
  });

  it("prefers the ccv3 chunk when a compatibility chara chunk also exists", () => {
    const png = embedTextChunks([
      { keyword: "chara", value: encodeCard(v2Card("Fallback")) },
      { keyword: "ccv3", value: encodeCard(v3Card()) },
    ]);

    expect(parseCharacterCardPng(png)).toMatchObject({
      format: "ccv3-png",
      name: "Mira",
    });
  });

  it("matches SillyTavern's case-insensitive metadata keywords", () => {
    const png = embedTextChunks([
      { keyword: "ChArA", value: encodeCard(v2Card("Mixed case")) },
    ]);

    expect(parseCharacterCardPng(png)).toMatchObject({
      format: "ccv2-png",
      name: "Mixed case",
    });
  });

  it("uses the first chunk when a metadata keyword is duplicated", () => {
    const png = embedTextChunks([
      { keyword: "chara", value: encodeCard(v2Card("First")) },
      { keyword: "CHARA", value: encodeCard(v2Card("Second")) },
    ]);

    expect(parseCharacterCardPng(png)).toMatchObject({ name: "First" });
  });

  it("removes case-variant character metadata before export", () => {
    const source = embedTextChunks([
      { keyword: "ChArA", value: encodeCard(v2Card("Old")) },
      { keyword: "CCV3", value: encodeCard(v3Card()) },
    ]);
    const card = parseCharacterCardDocument(v2Card("Exported")).card;
    const exported = encodeCharacterCardPng(card, source);
    const metadataKeywords = extractChunks(exported)
      .filter((chunk) => chunk.name === "tEXt")
      .map((chunk) => textChunk.decode(chunk.data).keyword)
      .filter((keyword) => ["chara", "ccv3"].includes(keyword.toLowerCase()));

    expect(metadataKeywords).toEqual(["chara"]);
    expect(parseCharacterCardPng(exported)).toMatchObject({ name: "Exported" });
  });

  it("rejects PNG images without character metadata", () => {
    expect(() => parseCharacterCardPng(transparentPng)).toThrow(
      CharacterCardParseError,
    );
  });

  it("rejects invalid base64 metadata", () => {
    const png = embedTextChunks([{ keyword: "chara", value: "***" }]);

    expect(() => parseCharacterCardPng(png)).toThrow(
      "The PNG character metadata is not valid base64.",
    );
  });

  it("exports a card to an importable PNG without losing unknown fields", () => {
    const input = v2Card();
    (input.data as Record<string, unknown>).future_field = {
      nested: [true, 7, "kept"],
    };
    const card = parseCharacterCardDocument(input).card;

    const exported = encodeCharacterCardPng(card);
    const reparsed = parseCharacterCardPngDocument(exported);

    expect(reparsed.preview.format).toBe("ccv2-png");
    expect(reparsed.card).toEqual(card);
  });
});
