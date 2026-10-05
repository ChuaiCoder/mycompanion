import { extname } from "node:path";
import { ZipFile } from "yazl";
import { CharacterCardParseError, parseCharacterCardDocument } from "@mycompanion/character-card";
import type { CharacterImport, StoredCharacter } from "./character-repository.js";
import { readBoundedZip, normalizeZipPath } from "./bounded-zip.js";
import { inlineCharacterAssetPath, materializeCharacterInlineAssets } from "./character-inline-assets.js";

export const characterAssetLimits = { archiveBytes: 32 * 1024 * 1024, fileBytes: 16 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, entries: 4096 };

// Adapted from pinned SillyTavern src/charx.js getEmbeddedZipPathFromUri,
// collectCharXAssets and pickCharXIconAsset (AGPL-3.0-only, contributors).
// Keep Risu's intentional embeded:// spelling and the two compatibility aliases.
export function embeddedAssetPath(uri: unknown): string | null {
  if (typeof uri !== "string" || !uri.trim()) return null;
  const trimmed = uri.trim(), lower = trimmed.toLowerCase();
  for (const prefix of ["embeded://", "embedded://", "__asset:"]) {
    if (lower.startsWith(prefix)) return normalizeZipPath(trimmed.slice(prefix.length));
  }
  return null;
}

export function mainIconPath(card: StoredCharacter["rawCard"]): string | null {
  if (card.spec !== "chara_card_v3") return null;
  const icons = (card.data.assets ?? []).filter(asset => asset.type.toLowerCase() === "icon"
    && ["png", "jpg", "jpeg", "webp", "gif", "apng", "avif", "bmp", "jfif"].includes((asset.ext || extname(asset.uri).slice(1)).toLowerCase().replace(/^\./, "")));
  const icon = icons.find(asset => asset.name.toLowerCase() === "main") ?? icons[0];
  // JSON cards can preserve an unsupported/unsafe URI as metadata. Their
  // portrait still needs a fallback; archive import separately rejects paths.
  try { return icon ? embeddedAssetPath(icon.uri) ?? inlineCharacterAssetPath(icon.uri,icon.ext) : null; } catch { return null; }
}

/** Format conversion changes only URI transport, retaining unknown metadata. */
export function characterCardForPng(stored: StoredCharacter): StoredCharacter["rawCard"] {
  const card = structuredClone(stored.rawCard);
  if (card.spec === "chara_card_v3") {
    for (const asset of card.data.assets ?? []) {
      const path = embeddedAssetPath(asset.uri) ?? inlineCharacterAssetPath(asset.uri,asset.ext);
      if (path && stored.assets?.has(path)) asset.uri = "__asset:" + path;
    }
  }
  return card;
}

/** A portrait edit must survive CHARX export as well as the local thumbnail. */
export function replaceCharacterMainIcon(card: StoredCharacter["rawCard"], files: Map<string,Buffer>, image: Uint8Array): Map<string,Buffer> {
  if (card.spec !== "chara_card_v3") return files;
  const result = new Map(files), previous = mainIconPath(card);
  const root = previous ? previous.slice(0,previous.length - extname(previous).length) : "assets/icon/images/main";
  let path = root + ".png", suffix = 1;
  while (path !== previous && result.has(path)) path = root + "-portrait-" + suffix++ + ".png";
  const icons = card.data.assets ?? (card.data.assets = []);
  const icon = icons.find(asset => asset.type.toLowerCase() === "icon" && asset.name.toLowerCase() === "main")
    ?? icons.find(asset => asset.type.toLowerCase() === "icon");
  if (icon) { icon.uri = "embeded://" + path; icon.ext = "png"; }
  else icons.push({type:"icon",name:"main",ext:"png",uri:"embeded://"+path});
  result.set(path,Buffer.from(image));
  return result;
}

export async function parseCharacterArchive(bytes: Buffer): Promise<CharacterImport> {
  if (bytes.length > characterAssetLimits.archiveBytes) throw new CharacterCardParseError("CHARX 不能超过 32 MiB。");
  // JPEG CHARX and other SFX formats prepend a cover to the ZIP local header.
  const start = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const archive = start > 0 ? bytes.subarray(start) : bytes;
  const files = await readBoundedZip(archive, characterAssetLimits);
  if (!files.has("card.json") && files.has("manifest.json")) {
    const { parseCharacterByaf } = await import("./character-byaf.js");
    return parseCharacterByaf(archive, files);
  }
  const document = files.get("card.json");
  if (!document) throw new CharacterCardParseError("CHARX 根目录缺少 card.json。");
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(document)); }
  catch { throw new CharacterCardParseError("CHARX card.json 不是有效 UTF-8 JSON。"); }
  const parsed = parseCharacterCardDocument(raw);
  files.delete("card.json");
  const missing = parsed.card.spec === "chara_card_v3" ? (parsed.card.data.assets ?? []).filter(asset => {
    const path = embeddedAssetPath(asset.uri); return path !== null && !files.has(path);
  }) : [];
  if (missing.length) throw new CharacterCardParseError("CHARX 缺少角色卡引用的内嵌资产。", missing.map(asset => asset.uri));
  const icon = mainIconPath(parsed.card), image = icon ? files.get(icon) : undefined;
  const isPng = image?.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ?? false;
  return materializeCharacterInlineAssets({ ...parsed, assets: files,
    ...(image && isPng ? { sourcePng: image } : {}),
    preview: { ...parsed.preview, format: parsed.card.spec === "chara_card_v3" ? "ccv3-charx" : "ccv2-charx",
      importedAssetCount: files.size, warningCodes: parsed.preview.warningCodes.filter(code => code !== "v3_assets_not_imported"
        || (parsed.card.spec === "chara_card_v3" && (parsed.card.data.assets ?? []).some(asset => embeddedAssetPath(asset.uri) === null))) } });
}

export function encodeCharacterArchive(stored: StoredCharacter): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new ZipFile(), chunks: Buffer[] = [];
    zip.outputStream.on("data", chunk => chunks.push(chunk));
    zip.outputStream.on("error", reject); zip.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.addBuffer(Buffer.from(JSON.stringify(stored.rawCard)), "card.json");
    for (const [path, content] of stored.assets ?? []) zip.addBuffer(content, normalizeZipPath(path));
    zip.end();
  });
}

export function characterAssetContentType(path: string): string {
  const types: Record<string, string> = { ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".webp":"image/webp",
    ".gif":"image/gif", ".avif":"image/avif", ".bmp":"image/bmp", ".mp3":"audio/mpeg", ".wav":"audio/wav", ".ogg":"audio/ogg", ".mp4":"video/mp4", ".webm":"video/webm" };
  return types[extname(path).toLowerCase()] ?? "application/octet-stream";
}
