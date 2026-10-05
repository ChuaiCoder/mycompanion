import type { FastifyInstance } from "fastify";

import {
  backupRestorePreviewResponseSchema,
  backupRestoreRequestSchema,
  backupRestoreResponseSchema,
  storyExportFormatSchema,
  storyExportJsonSchema,
} from "@mycompanion/shared";

import {
  applyRestore,
  assembleBackupPayload,
  previewRestore,
} from "./backup.js";
import type { CharacterRepository } from "./character-repository.js";
import type { RuntimeRepository } from "./runtime-repository.js";
import { buildStoryExportJson, buildStoryExportMarkdown } from "./story-export.js";
import { sendError } from "./http-errors.js";
import type { IdParams } from "./route-types.js";

export function registerBackupRoutes(app: FastifyInstance, runtime: RuntimeRepository, characters: CharacterRepository): void {
  // 完整备份（FR-DATA-003）：导出角色/故事/记忆/世界书/正则/插件/非秘密设置，
  // 带格式版本、内容清单与 sha256 完整性校验；API Key 以 hasApiKey 占位，不含密文。
  app.get<{ Reply: unknown }>("/api/backup", async (_request, reply) => {
    const payload = assembleBackupPayload({ characters, runtime });
    return reply
      .header("Cache-Control", "private, no-store")
      .type("application/json; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="mycompanion-backup-${payload.createdAt.slice(0, 10)}.json"`)
      .send(payload);
  });

  // 备份恢复预览（FR-DATA-003）：校验 + 各分区 新增/覆盖/跳过/冲突 数量。
  app.post<{ Body: unknown; Reply: unknown }>(
    "/api/backup/restore/preview",
    { bodyLimit: 500 * 1024 * 1024 }, async (request, reply) => {
      const parsed = backupRestoreRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return sendError(reply, 400, "INVALID_BACKUP", "备份内容无效。");
      }
      const preview = previewRestore(parsed.data.backup, { characters, runtime }, parsed.data.strategy);
      if (!preview.valid) {
        return reply.status(422).send(backupRestorePreviewResponseSchema.parse(preview));
      }
      return backupRestorePreviewResponseSchema.parse(preview);
    },
  );

  // 备份恢复（FR-DATA-003）：按策略写入，返回应用/跳过数量。
  app.post<{ Body: unknown; Reply: unknown }>(
    "/api/backup/restore",
    { bodyLimit: 500 * 1024 * 1024 }, async (request, reply) => {
      const parsed = backupRestoreRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return sendError(reply, 400, "INVALID_BACKUP", "备份内容无效。");
      }
      const { valid, errors } = previewRestore(parsed.data.backup, { characters, runtime }, parsed.data.strategy);
      if (!valid) {
        return sendError(reply, 422, "BACKUP_INVALID", errors.join("；") || "备份无效。");
      }
      const result = applyRestore(parsed.data.backup, { characters, runtime }, parsed.data.strategy);
      return backupRestoreResponseSchema.parse(result);
    },
  );

  // 故事导出（FR-DATA-002）：人类可读 Markdown 或机器可读 JSON（全分支消息树）。
  // API Key 单独加密存储，不进入故事数据。
  app.get<{
    Params: IdParams;
    Querystring: { format?: string };
    Reply: unknown;
  }>("/api/conversations/:id/export", async (request, reply) => {
    const format = request.query.format ?? "markdown";
    const parsed = storyExportFormatSchema.safeParse(format);
    if (!parsed.success) {
      return sendError(reply, 400, "INVALID_EXPORT_FORMAT", "导出格式必须是 markdown 或 json。");
    }
    const conversation = runtime.getConversation(request.params.id);
    if (!conversation) {
      return sendError(reply, 404, "CONVERSATION_NOT_FOUND", "故事不存在。");
    }
    const stageSummary = runtime.getSummary(conversation.id);
    const memories = runtime.listMemoriesForBackup();
    reply.header("Cache-Control", "private, no-store");
    if (parsed.data === "json") {
      const payload = storyExportJsonSchema.parse(buildStoryExportJson({
        conversation,
        allBranchMessages: runtime.listAllBranchMessages(conversation.id),
        ...(stageSummary ? { stageSummary } : {}),
        memories,
      }));
      return reply
        .type("application/json; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="story-${conversation.id}.json"`)
        .send(payload);
    }
    const markdown = buildStoryExportMarkdown({
      conversation,
      branchMessages: conversation.messages,
      ...(stageSummary ? { stageSummary } : {}),
      memories,
    });
    return reply
      .type("text/markdown; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="story-${conversation.id}.md"`)
      .send(markdown);
  });
}
