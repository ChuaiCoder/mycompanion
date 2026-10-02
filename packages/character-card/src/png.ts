import { Buffer } from "node:buffer";
import { crc32 } from "node:zlib";
import { posix } from "node:path";

import * as textChunk from "png-chunk-text";
import extractChunks from "png-chunks-extract";

import type { CharacterCardPreviewResponse } from "@mycompanion/shared";

import {
  CharacterCardParseError,
  parseCharacterCardDocument,
  type ParsedCharacterCard,
} from "./parse.js";
import type { CharacterCard } from "./schema.js";

const pngSignature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const maximumDimension = 8_192;
const maximumPixels = 40_000_000;
const assetPrefix = "chara-ext-asset_:";
const legacyAssetPrefix = "chara-ext-asset_";
const maximumAssetBytes = 16 * 1024 * 1024, maximumAssetTotal = 64 * 1024 * 1024, maximumAssets = 4096;
const transparentPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

interface PngChunk {
  name: string;
  data: Uint8Array;
}

function hasPngSignature(data: Uint8Array): boolean {
  return pngSignature.every((byte, index) => data[index] === byte);
}

function decodeBase64Json(encoded: string): unknown {
  const normalized = encoded.trim();
  if (
    normalized.length === 0 ||
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
  ) {
    throw new CharacterCardParseError(
      "The PNG character metadata is not valid base64.",
    );
  }

  let json: string;
  try {
    const bytes = Buffer.from(normalized, "base64");
    json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CharacterCardParseError(
      "The PNG character metadata is not valid UTF-8.",
    );
  }

  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw new CharacterCardParseError(
      "The PNG character metadata does not contain valid JSON.",
    );
  }
}

function validatePngDimensions(chunks: PngChunk[]): void {
  const header = chunks.find((chunk) => chunk.name === "IHDR");
  if (!header || header.data.byteLength < 8) {
    throw new CharacterCardParseError("The PNG image has no valid IHDR chunk.");
  }

  const view = new DataView(
    header.data.buffer,
    header.data.byteOffset,
    header.data.byteLength,
  );
  const width = view.getUint32(0);
  const height = view.getUint32(4);
  if (
    width === 0 ||
    height === 0 ||
    width > maximumDimension ||
    height > maximumDimension ||
    width * height > maximumPixels
  ) {
    throw new CharacterCardParseError(
      `The PNG dimensions exceed the safe limit (${maximumDimension}px per side and ${maximumPixels} pixels total).`,
    );
  }
}

function encodeChunks(chunks: PngChunk[]): Uint8Array {
  const encoded = chunks.map((chunk) => {
    if (chunk.name.length !== 4) {
      throw new CharacterCardParseError("The PNG contains an invalid chunk name.");
    }
    const type = Buffer.from(chunk.name, "ascii");
    const data = Buffer.from(chunk.data);
    const output = Buffer.alloc(12 + data.length);
    output.writeUInt32BE(data.length, 0);
    type.copy(output, 4);
    data.copy(output, 8);
    output.writeUInt32BE(
      crc32(Buffer.concat([type, data])) >>> 0,
      8 + data.length,
    );
    return output;
  });

  return Buffer.concat([Buffer.from(pngSignature), ...encoded]);
}

function isCharacterMetadataChunk(chunk: PngChunk): boolean {
  if (chunk.name !== "tEXt") {
    return false;
  }
  try {
    const decoded = textChunk.decode(chunk.data);
    const keyword = decoded.keyword.toLowerCase();
    return keyword === "chara" || keyword === "ccv3";
  } catch {
    return false;
  }
}

function assetPath(keyword: string): string | null {
  const prefix = keyword.startsWith(assetPrefix) ? assetPrefix : keyword.startsWith(legacyAssetPrefix) ? legacyAssetPrefix : null;
  if (!prefix) return null;
  const path = keyword.slice(prefix.length);
  if (!path || path.includes("\\") || path.includes("\0") || path.startsWith("/") || /^[a-z]:/i.test(path)
    || path.split("/").some(part => part === "..") || posix.normalize(path) !== path || path.endsWith("/") || path === "card.json")
    throw new CharacterCardParseError("The PNG contains an unsafe asset path.");
  return path;
}

function embeddedUriPath(uri: string): string | null {
  const match = /^(?:__asset:|embeded:\/\/|embedded:\/\/)(.*)$/i.exec(uri.trim());
  return match ? match[1]! : null;
}

function decodeAsset(encoded: string): Uint8Array {
  if (encoded.length > Math.ceil(maximumAssetBytes / 3) * 4) throw new CharacterCardParseError("The PNG asset exceeds 16 MiB.");
  if (encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new CharacterCardParseError("The PNG asset is not valid base64.");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new CharacterCardParseError("The PNG asset is not valid base64.");
  if (bytes.length > maximumAssetBytes) throw new CharacterCardParseError("The PNG asset exceeds 16 MiB.");
  return bytes;
}

export function parseCharacterCardPngDocument(
  input: Uint8Array,
): ParsedCharacterCard {
  if (!hasPngSignature(input)) {
    throw new CharacterCardParseError("The uploaded file is not a PNG image.");
  }

  let chunks: Array<{ name: string; data: Uint8Array }>;
  try {
    chunks = extractChunks(input);
  } catch {
    throw new CharacterCardParseError(
      "The PNG image is corrupted or has an invalid chunk structure.",
    );
  }
  validatePngDimensions(chunks);

  const metadata = new Map<string, string>(), assets = new Map<string, Uint8Array>();
  let totalAssetBytes = 0;
  for (const chunk of chunks) {
    if (chunk.name !== "tEXt") {
      continue;
    }

    try {
      const decoded = textChunk.decode(chunk.data);
      const path = assetPath(decoded.keyword);
      if (path !== null) {
        if (assets.has(path)) throw new CharacterCardParseError("The PNG contains duplicate asset paths.");
        if (assets.size >= maximumAssets) throw new CharacterCardParseError("The PNG exceeds 4096 assets.");
        const bytes = decodeAsset(decoded.text);
        if ((totalAssetBytes += bytes.length) > maximumAssetTotal) throw new CharacterCardParseError("The PNG assets exceed 64 MiB.");
        assets.set(path,bytes);
      }
      const keyword = decoded.keyword.toLowerCase();
      if (
        (keyword === "ccv3" || keyword === "chara") &&
        !metadata.has(keyword)
      ) {
        // SillyTavern treats metadata keywords case-insensitively and uses the
        // first matching chunk when a malformed file contains duplicates.
        metadata.set(keyword, decoded.text);
      }
    } catch (error) {
      if (error instanceof CharacterCardParseError) throw error;
      throw new CharacterCardParseError(
        "The PNG contains an invalid text metadata chunk.",
      );
    }
  }

  const metadataKey = metadata.has("ccv3")
    ? "ccv3"
    : metadata.has("chara")
      ? "chara"
      : null;

  if (!metadataKey) {
    throw new CharacterCardParseError(
      "The PNG does not contain Character Card V2 or V3 metadata.",
    );
  }

  const parsed = parseCharacterCardDocument(
    decodeBase64Json(metadata.get(metadataKey) ?? ""),
  );

  if (metadataKey === "ccv3" && parsed.preview.format !== "ccv3-json") {
    throw new CharacterCardParseError(
      "The ccv3 PNG chunk does not contain a Character Card V3 object.",
    );
  }

  if (parsed.card.spec === "chara_card_v3") {
    const missing = (parsed.card.data.assets ?? []).filter(asset => {
      const path = embeddedUriPath(asset.uri); return path !== null && !assets.has(path);
    });
    if (missing.length) throw new CharacterCardParseError("The PNG is missing a referenced embedded asset.", missing.map(asset => asset.uri));
  }

  return {
    ...parsed,
    ...(assets.size ? { assets } : {}),
    preview: {
      ...parsed.preview,
      ...(assets.size ? { importedAssetCount: assets.size } : {}),
      warningCodes: parsed.preview.warningCodes.filter(code => code !== "v3_assets_not_imported" || (parsed.card.spec === "chara_card_v3"
        && (parsed.card.data.assets ?? []).some(asset => embeddedUriPath(asset.uri) === null && asset.uri !== "ccdefault:"))),
      format:
        parsed.preview.format === "ccv3-json" ? "ccv3-png" : "ccv2-png",
    },
  };
}

export function parseCharacterCardPng(
  input: Uint8Array,
): CharacterCardPreviewResponse {
  return parseCharacterCardPngDocument(input).preview;
}

export function encodeCharacterCardPng(
  card: CharacterCard,
  sourceImage?: Uint8Array,
  assets?: ReadonlyMap<string, Uint8Array>,
): Uint8Array {
  const parsed = parseCharacterCardDocument(card);
  const baseImage = sourceImage ?? transparentPng;
  if (!hasPngSignature(baseImage)) {
    throw new CharacterCardParseError("The source image is not a PNG image.");
  }

  let chunks: PngChunk[];
  try {
    chunks = extractChunks(baseImage);
  } catch {
    throw new CharacterCardParseError(
      "The source PNG is corrupted or has an invalid chunk structure.",
    );
  }
  validatePngDimensions(chunks);

  const imageChunks = chunks.filter((chunk) => !isCharacterMetadataChunk(chunk) && (assets === undefined || chunk.name !== "tEXt" || !textChunk.decode(chunk.data).keyword.startsWith(legacyAssetPrefix)));
  const endIndex = imageChunks.findIndex((chunk) => chunk.name === "IEND");
  if (endIndex < 0) {
    throw new CharacterCardParseError("The source PNG has no IEND chunk.");
  }

  const keyword = parsed.card.spec === "chara_card_v3" ? "ccv3" : "chara";
  const encodedCard = Buffer.from(JSON.stringify(parsed.card), "utf8").toString(
    "base64",
  );
  const newChunks = [textChunk.encode(keyword, encodedCard)];
  let total = 0;
  if (assets && assets.size > maximumAssets) throw new CharacterCardParseError("The PNG exceeds 4096 assets.");
  for (const [path, bytes] of assets ?? []) {
    const key = assetPrefix + path;
    assetPath(key);
    if (key.length > 79 || !/^[\x01-\xFF]+$/.test(key)) throw new CharacterCardParseError("The PNG asset path cannot be represented in a tEXt keyword; export CHARX to preserve it.");
    if (bytes.length > maximumAssetBytes || (total += bytes.length) > maximumAssetTotal) throw new CharacterCardParseError("The PNG assets exceed the size limit.");
    const encoded = Buffer.from(bytes).toString("base64");
    // png-chunk-text rejects empty content, while an empty file is valid.
    newChunks.push(encoded ? textChunk.encode(key,encoded) : {name:"tEXt",data:Buffer.concat([Buffer.from(key,"latin1"),Buffer.from([0])])});
  }
  imageChunks.splice(endIndex, 0, ...newChunks);
  return encodeChunks(imageChunks);
}
