import { DatabaseSync } from "node:sqlite";

type AvatarRow = { bytes: Uint8Array; content_type: string };
const maxAvatarBytes = 20 * 1024 * 1024;
export const validAvatarId = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 200 && /^[\p{L}\p{N}._-]+\.png$/u.test(value) && value !== "..png";

export function imageType(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 6 && Buffer.from(bytes.subarray(0, 3)).toString() === "GIF" && ["87a", "89a"].includes(Buffer.from(bytes.subarray(3, 6)).toString())) return "image/gif";
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString() === "RIFF" && Buffer.from(bytes.subarray(8, 12)).toString() === "WEBP") return "image/webp";
  return null;
}

/** Avatar bytes have their own SQLite identity; the filename is never a disk path. */
export class PersonaAvatarRepository {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`CREATE TABLE IF NOT EXISTS user_avatars (
      avatar_id TEXT PRIMARY KEY COLLATE NOCASE,
      bytes BLOB NOT NULL,
      content_type TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
  }

  list(): string[] {
    return (this.database.prepare("SELECT avatar_id FROM user_avatars ORDER BY avatar_id COLLATE NOCASE").all() as Array<{ avatar_id: string }>).map(row => row.avatar_id);
  }

  listForBackup(): Array<{ avatarId: string; bytesBase64: string }> {
    return this.list().map(avatarId => ({ avatarId, bytesBase64: Buffer.from(this.get(avatarId)!.bytes).toString("base64") }));
  }

  get(id: string): AvatarRow | null {
    return this.database.prepare("SELECT bytes, content_type FROM user_avatars WHERE avatar_id = ?").get(id) as AvatarRow | undefined ?? null;
  }

  put(id: string, bytes: Uint8Array): void {
    if (!validAvatarId(id)) throw Object.assign(new Error("头像文件名无效。"), { statusCode: 400 });
    if (!bytes.length || bytes.length > maxAvatarBytes) throw Object.assign(new Error("头像大小必须在 1 字节至 20 MiB 之间。"), { statusCode: 413 });
    const contentType = imageType(bytes);
    if (!contentType) throw Object.assign(new Error("仅支持 PNG、JPEG、GIF 或 WebP 头像。"), { statusCode: 400 });
    this.database.prepare(`INSERT INTO user_avatars (avatar_id, bytes, content_type, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(avatar_id) DO UPDATE SET bytes=excluded.bytes,
      content_type=excluded.content_type, updated_at=excluded.updated_at`)
      .run(id, Buffer.from(bytes), contentType, new Date().toISOString());
  }

  delete(id: string): boolean {
    return this.database.prepare("DELETE FROM user_avatars WHERE avatar_id = ?").run(id).changes > 0;
  }
}
