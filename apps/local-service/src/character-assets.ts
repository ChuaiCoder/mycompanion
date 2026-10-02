import type { DatabaseSync } from "node:sqlite";
import { normalizeZipPath } from "./bounded-zip.js";

const maximumFileBytes = 16 * 1024 * 1024, maximumTotalBytes = 64 * 1024 * 1024, maximumEntries = 4096;
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function validateAssetPath(path: string): void {
  if (normalizeZipPath(path) !== path || path.endsWith("/") || path === "card.json") throw new Error("角色资产路径无效。");
}
export function characterAssetBase64Size(encoded: string): number {
  if (encoded.length > Math.ceil(maximumFileBytes / 3) * 4) throw new Error("角色资产大小超出限制。");
  if (encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
    || (encoded.endsWith("==") && (alphabet.indexOf(encoded.at(-3)!) & 15) !== 0)
    || (!encoded.endsWith("==") && encoded.endsWith("=") && (alphabet.indexOf(encoded.at(-2)!) & 3) !== 0)) throw new Error("角色资产不是有效 base64。");
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const bytes = encoded.length / 4 * 3 - padding;
  if(bytes>maximumFileBytes)throw new Error("角色资产大小超出限制。");
  return bytes;
}

/** Validate before decoding or changing the database; preview and restore agree. */
export function validateCharacterAssetBackup(assets?: Record<string,string>): void {
  const entries = Object.entries(assets ?? {});
  if (entries.length > maximumEntries) throw new Error("角色资产最多允许 4096 个文件。");
  let total = 0;
  for (const [path, encoded] of entries) {
    validateAssetPath(path);
    const bytes = characterAssetBase64Size(encoded);
    if (bytes > maximumFileBytes || (total += bytes) > maximumTotalBytes) throw new Error("角色资产大小超出限制。");
  }
}

/** Byte-preserving assets share the same SQLite transactions as cards and backups. */
export class CharacterAssetRepository {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`CREATE TABLE IF NOT EXISTS character_assets (
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      path TEXT NOT NULL, content BLOB NOT NULL, PRIMARY KEY(character_id,path)
    )`);
  }
  getAll(id: string): Map<string, Buffer> {
    const rows = this.database.prepare("SELECT path,content FROM character_assets WHERE character_id=? ORDER BY path").all(id) as unknown as {path:string;content:Uint8Array}[];
    return new Map(rows.map(row => [row.path, Buffer.from(row.content)]));
  }
  get(id: string, path: string): Buffer | undefined {
    const row = this.database.prepare("SELECT content FROM character_assets WHERE character_id=? AND path=?").get(id,normalizeZipPath(path)) as {content:Uint8Array} | undefined;
    return row ? Buffer.from(row.content) : undefined;
  }
  replace(id: string, files: ReadonlyMap<string, Uint8Array>): void {
    let bytes = 0;
    if (files.size > maximumEntries) throw new Error("角色资产最多允许 4096 个文件。");
    for (const [path, content] of files) {
      validateAssetPath(path);
      if (content.length > maximumFileBytes || (bytes += content.length) > maximumTotalBytes) throw new Error("角色资产大小超出限制。");
    }
    this.database.prepare("DELETE FROM character_assets WHERE character_id=?").run(id);
    const insert = this.database.prepare("INSERT INTO character_assets(character_id,path,content) VALUES(?,?,?)");
    for (const [path, content] of files) insert.run(id,path,content);
  }
  backup(id: string): Record<string,string> | undefined {
    const files = this.getAll(id);
    return files.size ? Object.fromEntries([...files].map(([path,content]) => [path,content.toString("base64")])) : undefined;
  }
  backupFields(id: string): { assets?: Record<string,string> } {
    const assets = this.backup(id); return assets ? { assets } : {};
  }
  restore(id: string, assets?: Record<string,string>): void {
    validateCharacterAssetBackup(assets);
    const files = new Map<string,Buffer>();
    for (const [path, encoded] of Object.entries(assets ?? {})) {
      files.set(path,Buffer.from(encoded,"base64"));
    }
    this.replace(id, files);
  }
}
