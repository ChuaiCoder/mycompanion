import { posix } from "node:path";
import { crc32 } from "node:zlib";
import yauzl from "yauzl";

export interface ZipLimits { archiveBytes: number; fileBytes: number; totalBytes: number; entries: number }
export class BoundedZipError extends Error {}

/** Shared ZIP resource reader, extracted from the existing extension installer. */
export function normalizeZipPath(value: string): string {
  if (!value || value.includes("\\") || value.includes("\0") || value.startsWith("/") || /^[a-z]:/i.test(value))
    throw new BoundedZipError("ZIP 包含不安全路径。");
  if (value.split("/").some(part => part === "..")) throw new BoundedZipError("ZIP 包含路径穿越。");
  const normalized = posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) throw new BoundedZipError("ZIP 包含路径穿越。");
  return normalized;
}

export function readBoundedZip(buffer: Buffer, limits: ZipLimits): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    let settled = false, archive: yauzl.ZipFile | undefined;
    const fail = (cause: unknown): void => {
      if (settled) return;
      settled = true; archive?.close();
      reject(cause instanceof BoundedZipError ? cause : new BoundedZipError(String(cause)));
    };
    if (buffer.length > limits.archiveBytes) { fail(`ZIP 不能超过 ${limits.archiveBytes / 1024 / 1024} MiB。`); return; }
    yauzl.fromBuffer(buffer, { lazyEntries: true, strictFileNames: true }, (error, zipfile) => {
      if (error || !zipfile) { fail("无法读取 ZIP 文件。"); return; }
      archive = zipfile;
      const files = new Map<string, Buffer>(), paths = new Set<string>();
      let entries = 0, total = 0;
      zipfile.on("entry", entry => {
        if (settled) return;
        let path: string;
        try {
          path = normalizeZipPath(entry.fileName);
          if (++entries > limits.entries) throw new BoundedZipError(`ZIP 最多允许 ${limits.entries} 个文件和目录。`);
          if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > limits.fileBytes)
            throw new BoundedZipError(`ZIP 单文件不能超过 ${limits.fileBytes / 1024 / 1024} MiB。`);
          total += entry.uncompressedSize;
          if (total > limits.totalBytes) throw new BoundedZipError(`ZIP 资源总量不能超过 ${limits.totalBytes / 1024 / 1024} MiB。`);
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (mode && mode !== 0o100000 && mode !== 0o040000) throw new BoundedZipError("ZIP 不能包含符号链接或特殊文件。");
          if (paths.has(path)) throw new BoundedZipError(`ZIP 包含重复路径：${path}`);
          paths.add(path);
          if (path.endsWith("/")) { zipfile.readEntry(); return; }
        } catch (cause) { fail(cause); return; }
        zipfile.openReadStream(entry, (streamError, stream) => {
          if (settled) { stream?.destroy(); return; }
          if (streamError || !stream) { fail(`无法读取 ZIP 文件：${path}`); return; }
          const chunks: Buffer[] = []; let bytes = 0, checksum = 0;
          stream.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > entry.uncompressedSize || bytes > limits.fileBytes) { stream.destroy(); fail(`ZIP 文件大小超出声明或限制：${path}`); return; }
            checksum = crc32(chunk, checksum); chunks.push(chunk);
          });
          stream.on("error", () => fail(`ZIP 文件读取失败：${path}`));
          stream.on("end", () => {
            if (settled) return;
            if (bytes !== entry.uncompressedSize || checksum !== entry.crc32) { fail(`ZIP 文件校验失败：${path}`); return; }
            files.set(path, Buffer.concat(chunks, bytes)); zipfile.readEntry();
          });
        });
      });
      zipfile.on("end", () => { if (!settled) { settled = true; resolve(files); } });
      zipfile.on("error", (cause: Error) => fail(cause.message.startsWith("invalid relative path:") ? "ZIP 包含路径穿越。" : "ZIP 读取失败。"));
      zipfile.readEntry();
    });
  });
}
