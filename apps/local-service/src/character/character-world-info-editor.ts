import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import sanitize from "sanitize-filename";
import { convertCharacterBook } from "@mycompanion/shared";
import type { CharacterRepository } from "./character-repository.js";
import type { WorldInfoRepository } from "../world-info/world-info-repository.js";
import { sendError } from "../http-errors.js";

/** The embedded source remains part of the card; the valid primary binding is
 * the only source used by world-info-service after this atomic conversion. */
export function registerCharacterWorldInfoEditor(app: FastifyInstance, database: DatabaseSync,
  characters: CharacterRepository, books: WorldInfoRepository): void {
  app.post<{ Params: { id: string }; Body: { name?: string; expectedUpdatedAt: string } }>(
    "/api/characters/:id/worldinfo/edit", {
      schema: { body: { type: "object", required: ["expectedUpdatedAt"], properties: {
        expectedUpdatedAt: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 },
      } } },
    }, async (request, reply) => {
      const source = characters.getStored(request.params.id);
      if (!source || source.detail.deletedAt) return sendError(reply, 404, "CHARACTER_NOT_FOUND", "角色不存在。");
      if (source.detail.updatedAt !== request.body.expectedUpdatedAt)
        return sendError(reply, 409, "CHARACTER_VERSION_CONFLICT", "角色已被修改，请重新打开后再编辑世界书。");
      const primary = source.rawCard.data.extensions.world;
      if (typeof primary === "string" && books.get(primary))
        return { name: primary, created: false, character: source.detail };
      const embedded = source.rawCard.data.character_book;
      if (!embedded) return sendError(reply, 422, "CHARACTER_WORLD_INFO_MISSING", "角色没有可编辑的随卡世界书。");
      const name = sanitize(request.body.name?.trim() ?? "").trim();
      if (!name) return sendError(reply, 400, "INVALID_WORLD_INFO_NAME", "请输入有效的世界书名称。");
      if (books.names().some(existing => existing.toLowerCase() === name.toLowerCase()))
        return sendError(reply, 409, "WORLD_INFO_NAME_CONFLICT", "同名世界书已存在，请使用其他名称。");

      database.exec("SAVEPOINT character_world_info_editor");
      try {
        const originalData = structuredClone(embedded);
        const conversion = structuredClone(embedded);
        // Imported cards can repeat/miss IDs. Retain every entry without changing
        // the archived source, instead of silently replacing an object key.
        const used = new Set<string>();
        const reserved = new Set(conversion.entries.flatMap(entry => entry.id === undefined ? [] : [String(entry.id)]));
        let nextId = 0;
        for (const entry of conversion.entries) {
          let id = entry.id;
          if (id === undefined || used.has(String(id))) {
            while (used.has(String(nextId)) || reserved.has(String(nextId))) nextId++;
            id = nextId++; entry.id = id;
          }
          used.add(String(id));
        }
        const converted = convertCharacterBook(conversion);
        const enabled = new Map(source.detail.lorebookEnabled.map(entry => [entry.index, entry.enabled]));
        conversion.entries.forEach((entry, index) => {
          const namedEntry = converted.entries[String(entry.id)];
          if (!namedEntry) throw new Error("Converted world-info entry is missing.");
          namedEntry.disable = !enabled.get(index);
        });
        books.save(name, { ...converted, originalData });
        const card = structuredClone(source.rawCard);
        card.data.extensions.world = name;
        const updated = characters.update(source.detail.id, card);
        if (!updated) throw new Error("Character disappeared during world-info binding.");
        database.exec("RELEASE character_world_info_editor");
        return { name, created: true, character: updated.detail };
      } catch (error) {
        database.exec("ROLLBACK TO character_world_info_editor; RELEASE character_world_info_editor");
        request.log.error(error, "Cannot copy and bind embedded world info");
        return sendError(reply, 500, "CHARACTER_WORLD_INFO_EDIT_FAILED", "世界书保存失败，原角色与条目未修改；请重试。");
      }
    });
}
