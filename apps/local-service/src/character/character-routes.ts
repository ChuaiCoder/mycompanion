import { createHash } from "node:crypto";

import deepmerge from "@fastify/deepmerge";
import type { FastifyInstance, FastifyReply } from "fastify";

import {
  CharacterCardParseError,
  encodeCharacterCardPng,
  parseCharacterCardDocument,
  parseCharacterCardPngDocument,
  type ParsedCharacterCard,
} from "@mycompanion/character-card";
import {
  characterCardPreviewRequestSchema,
  characterImportCommitQuerySchema,
  characterDeleteRequestSchema,
  characterDeleteResponseSchema,
  characterDetailSchema,
  characterExportCheckRequestSchema,
  characterExportCheckResponseSchema,
  characterListResponseSchema,
  characterRelatedCountsSchema,
  characterRestoreResponseSchema,
  characterUpdateRequestSchema,
  type ApiErrorResponse,
  type CharacterCardPreviewResponse,
  type CharacterDetail,
  type CharacterExportCheckResponse,
  type CharacterListResponse,
} from "@mycompanion/shared";

import {
  CharacterRepository,
  IdempotencyConflictError,
  CharacterImportTargetError,
  type CharacterImport,
} from "./character-repository.js";
import { checkCharacterExport } from "./export-compatibility.js";
import type { RuntimeRepository } from "./runtime-repository.js";
import { sendError } from "./http-errors.js";
import type { CharacterExportQuery, CharacterParams } from "./route-types.js";
import { encodeCharacterArchive, parseCharacterArchive, characterAssetContentType, characterCardForPng, mainIconPath } from "./character-archive.js";
import { BoundedZipError } from "./bounded-zip.js";
import { parseCharacterCardYaml } from "./character-yaml.js";
import { parseCharacterByaf, importByafScenarios, type ByafImport } from "./character-byaf.js";
import { materializeCharacterInlineAssets } from "./character-inline-assets.js";

// 与酒馆编辑语义一致：提交的扩展字段合并到已存扩展之上，未提交的键保留。
const mergeExtensions = deepmerge({ mergeArray: () => (_target, source) => structuredClone(source) });

export class InvalidImportRequestError extends Error {
  readonly details: string[];

  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = "InvalidImportRequestError";
    this.details = details;
  }
}

export function convertedExamplesMatchCard(
  raw: string,
  characterName: string,
  blocks: Array<Array<{ role: string; content: string; name?: string | undefined }>>,
): boolean {
  if (!raw.trim()) return false;
  const expected: Array<{ name: string; content: string }> = [];
  for (const block of raw.replace(/\r/g, "").split(/<START>/gi)) {
    let current: { name: string; lines: string[] } | null = null;
    const flush = (): void => {
      if (current) expected.push({ name: current.name, content: current.lines.join("\n").trim() });
    };
    for (const line of block.split("\n")) {
      const match = /^(.{1,100}?)[:：]\s*(.*)$/.exec(line);
      const speaker = match?.[1]?.trim();
      const name = speaker === characterName || /^\{\{char\}\}$/i.test(speaker ?? "")
        ? "example_assistant"
        : speaker === "User" || /^\{\{user\}\}$/i.test(speaker ?? "")
          ? "example_user" : null;
      if (match && name) {
        flush();
        current = { name, lines: [match[2] ?? ""] };
      } else if (current) current.lines.push(line);
    }
    flush();
  }
  const received = blocks.flat();
  return expected.length > 0 && expected.length === received.length &&
    expected.every((item, index) => received[index]?.role === "system" &&
      item.content === received[index]?.content.trim() &&
      (received[index]?.name === undefined || received[index]?.name === item.name));
}

async function readImport(body: unknown, contentType = ""): Promise<{
  imported: CharacterImport;
  requestHash: string;
}> {
  if (Buffer.isBuffer(body)) {
    if (/application\/byaf/i.test(contentType)) {
      return { imported: await parseCharacterByaf(body), requestHash: createHash("sha256").update(body).digest("hex") };
    }
    if (/application\/(?:zip|x-zip-compressed|charx)/i.test(contentType)) {
      return { imported: await parseCharacterArchive(body), requestHash: createHash("sha256").update(body).digest("hex") };
    }
    const parsed = parseCharacterCardPngDocument(body);
    return {
      imported: materializeCharacterInlineAssets({ ...parsed, sourcePng: new Uint8Array(body) }),
      requestHash: createHash("sha256").update(body).digest("hex"),
    };
  }

  const requestResult = characterCardPreviewRequestSchema.safeParse(body);
  if (!requestResult.success) {
    throw new InvalidImportRequestError(
      "The character import request is invalid.",
      requestResult.error.issues.map((issue) => issue.message),
    );
  }

  const parsed: ParsedCharacterCard = /\.ya?ml$/i.test(requestResult.data.filename) && typeof requestResult.data.card === "string"
    ? parseCharacterCardYaml(requestResult.data.card) : parseCharacterCardDocument(requestResult.data.card);
  const serialized = JSON.stringify(parsed.card);
  return {
    imported: materializeCharacterInlineAssets(parsed),
    requestHash: createHash("sha256").update(serialized).digest("hex"),
  };
}

function readIdempotencyKey(
  value: string | string[] | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    throw new InvalidImportRequestError(
      "Only one Idempotency-Key header may be provided.",
    );
  }
  const key = value.trim();
  if (key.length === 0 || key.length > 200) {
    throw new InvalidImportRequestError(
      "Idempotency-Key must contain between 1 and 200 characters.",
    );
  }
  return key;
}

function sendImportError(
  reply: FastifyReply,
  error: unknown,
): FastifyReply | undefined {
  if (error instanceof BoundedZipError) return sendError(reply,422,"INVALID_CHARACTER_ARCHIVE",error.message);
  if (error instanceof CharacterImportTargetError)
    return sendError(reply, error.statusCode, error.statusCode === 409 ? "CHARACTER_VERSION_CONFLICT" : "CHARACTER_NOT_FOUND", error.message);
  if (error instanceof InvalidImportRequestError) {
    return reply.status(400).send({
      error: {
        code: "INVALID_REQUEST",
        message: error.message,
        ...(error.details.length > 0 ? { details: error.details } : {}),
      },
    } satisfies ApiErrorResponse);
  }
  if (error instanceof CharacterCardParseError) {
    return reply.status(422).send({
      error: {
        code: "INVALID_CHARACTER_CARD",
        message: error.message,
        details: error.issues,
      },
    } satisfies ApiErrorResponse);
  }
  if (error instanceof IdempotencyConflictError) {
    return reply.status(409).send({
      error: {
        code: "IDEMPOTENCY_CONFLICT",
        message: error.message,
      },
    } satisfies ApiErrorResponse);
  }
  return undefined;
}

export function registerCharacterRoutes(app: FastifyInstance, characters: CharacterRepository, runtime: RuntimeRepository): void {
  app.get<{ Reply: CharacterListResponse }>("/api/characters", async () => {
    return characterListResponseSchema.parse(characters.list());
  });

  app.get<{
    Params: CharacterParams;
    Reply: CharacterDetail | ApiErrorResponse;
  }>("/api/characters/:id", async (request, reply) => {
    const character = characters.get(request.params.id);
    if (!character) {
      return sendError(reply, 404, "CHARACTER_NOT_FOUND", "The requested character does not exist.");
    }
    return characterDetailSchema.parse(character);
  });

  // 原生角色更新：接收完整角色卡 JSON，走 character-repository 更新。
  // 扩展字段合并保留、avatar 文件名稳定，更新后返回 CharacterDetail。
  app.put<{
    Params: CharacterParams;
    Body: unknown;
    Reply: CharacterDetail | ApiErrorResponse;
  }>("/api/characters/:id", async (request, reply) => {
    const stored = characters.getStored(request.params.id);
    if (!stored) {
      return sendError(reply, 404, "CHARACTER_NOT_FOUND", "The requested character does not exist.");
    }
    const parsed = characterUpdateRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "INVALID_REQUEST", "The character update request is invalid.");
    }
    try {
      const card = parseCharacterCardDocument(parsed.data.card).card;
      card.data.extensions = mergeExtensions(stored.rawCard.data.extensions, card.data.extensions) as Record<string, unknown>;
      const updated = characters.update(stored.detail.id, card);
      if (!updated) {
        return sendError(reply, 404, "CHARACTER_NOT_FOUND", "The requested character does not exist.");
      }
      return characterDetailSchema.parse(updated.detail);
    } catch (error) {
      if (error instanceof CharacterCardParseError) {
        return reply.status(422).send({
          error: {
            code: "INVALID_CHARACTER_CARD",
            message: error.message,
            details: error.issues,
          },
        } satisfies ApiErrorResponse);
      }
      throw error;
    }
  });

  // 角色头像图像：URL 与酒馆兼容层保持一致（原生 UI 的 CharacterAvatar 直接使用）。
  app.get<{ Params: { avatar: string } }>("/characters/:avatar", async (request, reply) => {
    const stored = characters.getByAvatar(request.params.avatar);
    if (stored) {
      const path = mainIconPath(stored.rawCard), asset = path ? characters.assets.get(stored.detail.id,path) : undefined;
      if (asset) return reply.type(characterAssetContentType(path!)).header("Cache-Control","no-store").send(asset);
    }
    return stored ? reply.type("image/png").header("Cache-Control", "no-store").send(Buffer.from(encodeCharacterCardPng(stored.rawCard, stored.sourcePng)))
      : reply.code(404).send({ error: "Character not found" });
  });

  app.get<{
    Params: CharacterParams;
    Querystring: CharacterExportQuery;
    Reply: unknown;
  }>("/api/characters/:id/export", async (request, reply) => {
    const stored = characters.getStored(request.params.id, request.query.format === "charx" || request.query.format === "png");
    if (!stored) {
      return sendError(reply, 404, "CHARACTER_NOT_FOUND", "The requested character does not exist.");
    }

    const format = request.query.format ?? "json";
    reply.header("Cache-Control", "private, no-store");
    if (format === "json") {
      return reply
        .type("application/json; charset=utf-8")
        .header(
          "Content-Disposition",
          `attachment; filename="character-${stored.detail.id}.json"`,
        )
        .send(stored.rawCard);
    }
    if (format === "png") {
      let png: Uint8Array;
      const iconPath=mainIconPath(stored.rawCard),icon=iconPath?stored.assets?.get(iconPath):undefined;
      const pngIcon=icon?.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?icon:stored.sourcePng;
      try { png = encodeCharacterCardPng(characterCardForPng(stored), pngIcon, stored.assets); }
      catch (error) { if (error instanceof CharacterCardParseError || error instanceof BoundedZipError) return sendError(reply,422,"PNG_ASSET_EXPORT_UNSUPPORTED",error.message); throw error; }
      return reply
        .type("image/png")
        .header(
          "Content-Disposition",
          `attachment; filename="character-${stored.detail.id}.png"`,
        )
        .send(Buffer.from(png));
    }
    if (format === "charx") return reply.type("application/zip")
      .header("Content-Disposition", `attachment; filename="character-${stored.detail.id}.charx"`)
      .send(await encodeCharacterArchive(stored));
    return sendError(reply, 400, "INVALID_EXPORT_FORMAT", "Export format must be json, png or charx.");
  });

  app.get<{ Params: CharacterParams & { "*": string } }>("/api/characters/:id/assets/*", async (request,reply) => {
    const character = characters.get(request.params.id);
    if (!character || character.deletedAt) return sendError(reply,404,"CHARACTER_NOT_FOUND","角色不存在。");
    try {
      const bytes = characters.assets.get(character.id,request.params["*"]);
      if (!bytes) return sendError(reply,404,"ASSET_NOT_FOUND","角色资产不存在。");
      const type = characterAssetContentType(request.params["*"]);
      if (type === "application/octet-stream") reply.header("Content-Disposition","attachment");
      return reply.type(type).header("Cache-Control","private, no-store").header("X-Content-Type-Options","nosniff").send(bytes);
    } catch (error) {
      if (error instanceof BoundedZipError) return sendError(reply,400,"INVALID_ASSET_PATH",error.message);
      throw error;
    }
  });

  // 导出兼容性检查（FR-DATA-001）：导出前列出目标格式无法表示/第三方可能无法识别的字段。
  app.post<{
    Params: CharacterParams;
    Body: unknown;
    Reply: CharacterExportCheckResponse | ApiErrorResponse;
  }>("/api/characters/:id/export/check", async (request, reply) => {
    const stored = characters.getStored(request.params.id);
    if (!stored) {
      return sendError(reply, 404, "CHARACTER_NOT_FOUND", "The requested character does not exist.");
    }
    const parsed = characterExportCheckRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendError(reply, 400, "INVALID_REQUEST", "导出格式无效。");
    }
    const format = parsed.data.format ?? "json";
    return characterExportCheckResponseSchema.parse(checkCharacterExport(stored, format));
  });

  // 删除前的关联数量（FR-DATA-004）。
  app.get<{
    Params: CharacterParams;
    Reply: unknown;
  }>("/api/characters/:id/related-counts", async (request, reply) => {
    const character = characters.get(request.params.id);
    if (!character) {
      return sendError(reply, 404, "CHARACTER_NOT_FOUND", "The requested character does not exist.");
    }
    return characterRelatedCountsSchema.parse({
      characterId: character.id,
      conversationCount: runtime.countConversationsForCharacter(character.id),
      memoryCount: runtime.countMemoriesForCharacter(character.id),
    });
  });

  // 删除角色（FR-DATA-004）：默认软删除（可恢复）；permanent=true 需再次确认后级联删除。
  // DELETE 不携带请求体，permanent 走查询参数（"true" 才视为永久删除）。
  app.delete<{
    Params: CharacterParams;
    Querystring: { permanent?: string };
    Reply: unknown;
  }>("/api/characters/:id", async (request, reply) => {
    const rawPermanent = request.query?.permanent;
    if (rawPermanent !== undefined && rawPermanent !== "true" && rawPermanent !== "false") {
      return sendError(reply, 400, "INVALID_REQUEST", "删除参数无效。");
    }
    const permanent = characterDeleteRequestSchema.parse({
      permanent: rawPermanent === "true",
    }).permanent;
    const character = characters.get(request.params.id);
    if (!character) {
      return sendError(reply, 404, "CHARACTER_NOT_FOUND", "角色不存在。");
    }
    const conversationCount = runtime.countConversationsForCharacter(character.id);
    const memoryCount = runtime.countMemoriesForCharacter(character.id);
    if (permanent) {
      // 永久删除：级联删除对话、消息、记忆、摘要、设置（SQLite FK ON DELETE CASCADE）。
      if (!characters.permanentDelete(character.id)) {
        return sendError(reply, 404, "CHARACTER_NOT_FOUND", "角色不存在。");
      }
    } else {
      // 软删除：关联内容随之隐藏但保留，可恢复。
      if (!characters.softDelete(character.id)) {
        return sendError(reply, 404, "CHARACTER_NOT_FOUND", "角色不存在。");
      }
    }
    return characterDeleteResponseSchema.parse({
      characterId: character.id,
      permanent,
      hiddenConversations: conversationCount,
      hiddenMemories: memoryCount,
    });
  });

  // 回收站：软删除角色列表（FR-DATA-004）。
  app.get<{ Reply: unknown }>("/api/characters/deleted", async () => {
    const items = characters.listDeleted();
    return { items, total: items.length };
  });

  // 恢复软删除角色（FR-DATA-004）。
  app.post<{
    Params: CharacterParams;
    Reply: unknown;
  }>("/api/characters/:id/restore", async (request, reply) => {
    if (!characters.restoreDeleted(request.params.id)) {
      return sendError(reply, 404, "CHARACTER_NOT_FOUND", "角色不存在或尚未删除。");
    }
    return characterRestoreResponseSchema.parse({
      characterId: request.params.id,
      restored: true,
    });
  });

  app.post<{
    Body: unknown;
    Reply: CharacterCardPreviewResponse | ApiErrorResponse;
  }>("/api/characters/import/preview", async (request, reply) => {
    try {
      const { imported } = await readImport(request.body, request.headers["content-type"]);
      return { ...imported.preview, duplicates: characters.findImportDuplicates(imported) };
    } catch (error) {
      const response = sendImportError(reply, error);
      if (response) {
        return response;
      }
      throw error;
    }
  });

  app.post<{
    Body: unknown;
    Querystring: unknown;
    Reply: CharacterDetail | ApiErrorResponse;
  }>("/api/characters/import/commit", async (request, reply) => {
    try {
      const { imported, requestHash } = await readImport(request.body, request.headers["content-type"]);
      const query = characterImportCommitQuerySchema.safeParse(request.query);
      if (!query.success) return sendError(reply, 400, "INVALID_REQUEST", "导入策略无效；替换前请先选择角色并预览。");
      const idempotencyKey = readIdempotencyKey(
        request.headers["idempotency-key"],
      );
      const actionHash = query.data.mode === "copy" ? requestHash : createHash("sha256").update(JSON.stringify([requestHash, query.data])).digest("hex");
      const result = runtime.withTransaction(() => {
        const result = characters.import(imported, actionHash, idempotencyKey, query.data);
        if (!result.replayed && "byafScenarios" in imported) importByafScenarios(imported as ByafImport, result.character.id, runtime);
        return result;
      });
      return reply
        .status(result.replayed ? 200 : 201)
        .header("Idempotency-Replayed", result.replayed ? "true" : "false")
        .send(characterDetailSchema.parse(result.character));
    } catch (error) {
      const response = sendImportError(reply, error);
      if (response) {
        return response;
      }
      throw error;
    }
  });
}
