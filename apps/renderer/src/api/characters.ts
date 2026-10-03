import {
  apiErrorResponseSchema,
  characterCardPreviewResponseSchema,
  characterDetailSchema,
  characterListResponseSchema,
  type CharacterDetail,
  type CharacterExportCheckResponse,
  type CharacterRelatedCounts,
  type CharacterRestoreResponse,
  type CharacterListResponse,
  type CharacterCardPreviewResponse,
} from "@mycompanion/shared";

import { ApiRequestError, readApiPayload } from "./core";

const maximumJsonCardBytes = 20 * 1024 * 1024;

export async function previewCharacterCard(
  file: File,
  signal?: AbortSignal,
): Promise<CharacterCardPreviewResponse> {
  if (file.size > maximumJsonCardBytes) {
    throw new ApiRequestError(
      "FILE_TOO_LARGE",
      "角色卡超过 20 MiB，无法导入。",
    );
  }

  const { body: requestBody, contentType, filename } =
    await prepareCharacterCardRequest(file);

  const response = await fetch("/api/characters/import/preview", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": contentType,
      ...(filename ? { "X-Character-Filename": encodeURIComponent(filename) } : {}),
    },
    body: requestBody,
    ...(signal ? { signal } : {}),
  });
  const payload = (await response.json()) as unknown;

  if (!response.ok) {
    const error = apiErrorResponseSchema.safeParse(payload);
    if (error.success) {
      throw new ApiRequestError(
        error.data.error.code,
        error.data.error.message,
        error.data.error.details ?? [],
      );
    }
    throw new ApiRequestError(
      "IMPORT_PREVIEW_FAILED",
      `角色卡预览失败（HTTP ${response.status}）。`,
    );
  }

  return characterCardPreviewResponseSchema.parse(payload);
}

const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];

async function prepareCharacterCardRequest(
  file: File,
): Promise<{ body: BodyInit; contentType: string; filename?: string }> {
  const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const isPng =
    header.length === pngSignature.length &&
    pngSignature.every((byte, index) => header[index] === byte);
  if (isPng) {
    return { body: file, contentType: "image/png" };
  }

  // CHARX can carry a JPEG prefix, so inspect bytes rather than trusting its name.
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hasZip = bytes.some((byte, index) => byte === 80 && bytes[index + 1] === 75
    && ((bytes[index + 2] === 3 && bytes[index + 3] === 4) || (bytes[index + 2] === 5 && bytes[index + 3] === 6)));
  if (hasZip || /\.(charx|zip|byaf)$/i.test(file.name)) {
    return { body: file, contentType: /\.byaf$/i.test(file.name) ? "application/byaf" : "application/charx", filename: file.name };
  }

  if (/\.ya?ml$/i.test(file.name)) {
    return { body: JSON.stringify({ filename: file.name, card: await file.text() }), contentType: "application/json" };
  }

  let card: unknown;
  try {
    card = JSON.parse(await file.text()) as unknown;
  } catch {
    throw new ApiRequestError(
      "UNSUPPORTED_OR_INVALID_FILE",
      /\.jpe?g$/i.test(file.name) ? "这张 JPEG 图片没有检测到 CHARX 数据。请选择包含角色设定的卡片文件。" : "无法识别这个文件。请选择有效的 PNG、JSON、YAML 或 CHARX 角色卡。",
    );
  }
  return {
    body: JSON.stringify({ filename: file.name, card }),
    contentType: "application/json",
  };
}

export async function commitCharacterCard(
  file: File,
  idempotencyKey: string,
  signal?: AbortSignal,
  options?: { mode: "copy" | "replace"; targetId?: string; expectedUpdatedAt?: string },
): Promise<CharacterDetail> {
  if (file.size > maximumJsonCardBytes) {
    throw new ApiRequestError(
      "FILE_TOO_LARGE",
      "角色卡超过 20 MiB，无法导入。",
    );
  }
  const { body, contentType, filename } = await prepareCharacterCardRequest(file);
  const query = options ? new URLSearchParams(Object.entries(options).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : null;
  const response = await fetch("/api/characters/import/commit" + (query ? "?" + query : ""), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": contentType,
      ...(filename ? { "X-Character-Filename": encodeURIComponent(filename) } : {}),
      "Idempotency-Key": idempotencyKey,
    },
    body,
    ...(signal ? { signal } : {}),
  });
  return characterDetailSchema.parse(await readApiPayload(response));
}

export async function listCharacters(
  signal?: AbortSignal,
): Promise<CharacterListResponse> {
  const response = await fetch("/api/characters", {
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  return characterListResponseSchema.parse(await readApiPayload(response));
}

export async function fetchCharacter(
  id: string,
  signal?: AbortSignal,
): Promise<CharacterDetail> {
  const response = await fetch(`/api/characters/${encodeURIComponent(id)}`, {
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  return characterDetailSchema.parse(await readApiPayload(response));
}

// 原生角色编辑：读取完整角色卡 JSON（保留未知字段往返），PUT 更新后返回 CharacterDetail。
export async function fetchCharacterCard(id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(characterExportUrl(id, "json"), {
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) await readApiPayload(response);
  const card: unknown = JSON.parse(await response.text());
  if (!card || typeof card !== "object" || Array.isArray(card)) {
    throw new ApiRequestError("INVALID_CHARACTER_CARD", "角色卡数据无效。");
  }
  return card as Record<string, unknown>;
}

export async function updateCharacter(id: string, card: unknown): Promise<CharacterDetail> {
  const response = await fetch(`/api/characters/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ card }),
  });
  return characterDetailSchema.parse(await readApiPayload(response));
}

export function characterExportUrl(
  id: string,
  format: "json" | "png" | "charx",
): string {
  return `/api/characters/${encodeURIComponent(id)}/export?format=${format}`;
}

// 导出兼容性检查（FR-DATA-001）：导出前列出目标格式无法表示/第三方可能无法识别的字段。
export async function checkCharacterExport(
  id: string,
  format: "json" | "png" | "charx",
): Promise<CharacterExportCheckResponse> {
  const response = await fetch(`/api/characters/${encodeURIComponent(id)}/export/check`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ format }),
  });
  return readApiPayload(response) as Promise<CharacterExportCheckResponse>;
}

// 删除角色（FR-DATA-004）：关联计数、软删除（默认）、恢复、永久删除（permanent）。
export async function characterRelatedCounts(id: string): Promise<CharacterRelatedCounts> {
  const response = await fetch(`/api/characters/${encodeURIComponent(id)}/related-counts`, {
    headers: { Accept: "application/json" },
  });
  return readApiPayload(response) as Promise<CharacterRelatedCounts>;
}

export async function deleteCharacter(
  id: string,
  permanent = false,
): Promise<{ characterId: string; permanent: boolean; hiddenConversations: number; hiddenMemories: number }> {
  const query = permanent ? "?permanent=true" : "";
  const response = await fetch(
    `/api/characters/${encodeURIComponent(id)}${query}`,
    { method: "DELETE", headers: { Accept: "application/json" } },
  );
  return readApiPayload(response) as Promise<{
    characterId: string;
    permanent: boolean;
    hiddenConversations: number;
    hiddenMemories: number;
  }>;
}

export async function restoreCharacter(id: string): Promise<CharacterRestoreResponse> {
  const response = await fetch(`/api/characters/${encodeURIComponent(id)}/restore`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  return readApiPayload(response) as Promise<CharacterRestoreResponse>;
}
