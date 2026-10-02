import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  backupPayloadSchemaShared,
  characterDetailSchema,
  conversationDetailSchema,
  storyExportJsonSchema,
  type MemoryRecord,
} from "@mycompanion/shared";

import { buildApp } from "./app.js";
import { backupChecksum } from "./backup.js";
import {
  apps,
  completionByKind,
  fullV2Card,
  isCompletionRequest,
  sandboxExtensionZip,
  sseResponse,
  waitFor,
  type TestApp,
} from "./test-helpers.js";

describe("数据导入、导出与备份 (FR-DATA-001…004)", () => {
  /** 轮询后台记忆提取直到本故事出现至少一条记忆。 */
  async function waitForMemories(
    app: TestApp,
    conversationId: string,
  ): Promise<MemoryRecord[]> {
    return waitFor(() =>
      app.inject({ method: "GET", url: `/api/conversations/${conversationId}/memories` })
        .then((response) => {
          const items = (response.json() as { items: MemoryRecord[] }).items;
          return items.length > 0 ? items : undefined;
        }),
      4_000,
    );
  }

  /** 建应用、导入完整卡、配置模型、开故事并发一轮消息（记忆提取走 stub 补全）。 */
  async function seedConversation(): Promise<{
    app: TestApp;
    character: ReturnType<typeof characterDetailSchema.parse>;
    conversation: ReturnType<typeof conversationDetailSchema.parse>;
  }> {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(
      async (_url: URL, init?: RequestInit) =>
        (isCompletionRequest(init) ? completionByKind(init) : sseResponse(["好的。"])),
    ));
    const app = buildApp();
    apps.push(app);
    const character = characterDetailSchema.parse((await app.inject({
      method: "POST",
      url: "/api/characters/import/commit",
      payload: { filename: "ccv2-full.json", card: fullV2Card },
    })).json());
    await app.inject({
      method: "PUT",
      url: "/api/settings/provider",
      payload: { kind: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "test-model" },
    });
    const conversation = conversationDetailSchema.parse((await app.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { characterId: character.id },
    })).json());
    const sent = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages`,
      payload: { content: "我们明天出发去北行吗？" },
    });
    expect(sent.statusCode).toBe(200);
    return { app, character, conversation };
  }

  it("runs an export compatibility check before character export (FR-DATA-001)", async () => {
    const { app, character } = await seedConversation();
    const jsonCheck = await app.inject({
      method: "POST",
      url: `/api/characters/${character.id}/export/check`,
      payload: { format: "json" },
    });
    expect(jsonCheck.statusCode).toBe(200);
    const jsonResult = jsonCheck.json() as { characterId: string; warnings: string[] };
    expect(jsonResult.characterId).toBe(character.id);
    // 卡内正则会随卡导出；运行时启用状态是本地概念，需要提示。
    expect(jsonResult.warnings.some((warning) => warning.includes("正则"))).toBe(true);

    const pngCheck = await app.inject({
      method: "POST",
      url: `/api/characters/${character.id}/export/check`,
      payload: { format: "png" },
    });
    expect(pngCheck.statusCode).toBe(200);
    expect((pngCheck.json() as { warnings: string[] }).warnings.some((warning) => warning.includes("PNG"))).toBe(true);

    // 无卡角色：无未知字段/扩展风险时仍给出明确结论。
    const bareCharacter = characterDetailSchema.parse((await app.inject({
      method: "POST",
      url: "/api/characters/import/commit",
      payload: {
        filename: "bare.json",
        card: {
          spec: "chara_card_v2",
          spec_version: "2.0",
          data: {
            name: "素卡", description: "", personality: "", scenario: "",
            first_mes: "你好。", mes_example: "", creator_notes: "", system_prompt: "",
            post_history_instructions: "", alternate_greetings: [], tags: [],
            creator: "MyCompanion", character_version: "1.0", extensions: {},
          },
        },
      },
    })).json());
    const bareCheck = await app.inject({
      method: "POST",
      url: `/api/characters/${bareCharacter.id}/export/check`,
      payload: {},
    });
    expect(bareCheck.statusCode).toBe(200);
    const bareWarnings = (bareCheck.json() as { warnings: string[] }).warnings;
    // 裸卡没有任何运行时扩展/未知字段：只有“无风险”的明确结论。
    expect(bareWarnings).toHaveLength(1);
    expect(bareWarnings[0]).toContain("未发现兼容性风险");

    // 未知角色 404；非法格式 400。
    expect((await app.inject({ method: "POST", url: "/api/characters/00000000-0000-4000-8000-000000000000/export/check", payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/characters/${character.id}/export/check`, payload: { format: "xml" } })).statusCode).toBe(400);
  });

  it("exports a story as Markdown and machine-readable JSON (FR-DATA-002)", async () => {
    const { app, character, conversation } = await seedConversation();
    await waitForMemories(app, conversation.id);

    const markdown = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}/export?format=markdown`,
    });
    expect(markdown.statusCode).toBe(200);
    expect(markdown.headers["content-type"]).toContain("text/markdown");
    expect(markdown.headers["content-disposition"]).toContain(`story-${conversation.id}.md`);
    const mdBody = markdown.body as string;
    expect(mdBody).toContain(character.name);
    expect(mdBody).toContain("## 对话");
    expect(mdBody).toContain("我们明天出发去北行吗？");
    // 故事作用域记忆进入导出（FR-MEM-003：只导出本故事记忆）。
    expect(mdBody).toContain("## 故事记忆");

    const jsonExport = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}/export?format=json`,
    });
    expect(jsonExport.statusCode).toBe(200);
    const payload = storyExportJsonSchema.parse(jsonExport.json());
    expect(payload.format).toBe("mycompanion-story");
    expect(payload.conversation.characterId).toBe(character.id);
    expect(payload.conversation.characterName).toBe(character.name);
    expect(payload.conversation.activeBranchId).toBe(conversation.activeBranchId);
    // 全分支消息树：开场白 + 用户 + 助手。
    expect(payload.messages.length).toBeGreaterThanOrEqual(3);
    expect(payload.messages.some((message) => message.role === "user" && message.content.includes("北行"))).toBe(true);
    expect(payload.memories.length).toBeGreaterThanOrEqual(1);
    // 默认不导出 API Key：整个 JSON 文本中不出现密钥字段。
    expect((jsonExport.body as string).includes("api_key")).toBe(false);
    expect((jsonExport.body as string).includes("ciphertext")).toBe(false);

    // 未知故事 404；非法格式 400。
    expect((await app.inject({ method: "GET", url: "/api/conversations/00000000-0000-4000-8000-000000000000/export" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/conversations/${conversation.id}/export?format=xml` })).statusCode).toBe(400);
  });

  it("soft-deletes a character by default, hides its data, and can restore it (FR-DATA-004)", async () => {
    const { app, character, conversation } = await seedConversation();
    await waitForMemories(app, conversation.id);

    const counts = (await app.inject({
      method: "GET",
      url: `/api/characters/${character.id}/related-counts`,
    })).json() as { conversationCount: number; memoryCount: number };
    expect(counts.conversationCount).toBeGreaterThanOrEqual(1);
    expect(counts.memoryCount).toBeGreaterThanOrEqual(1);

    // 默认软删除：可恢复，关联内容随之隐藏。
    const deleted = (await app.inject({
      method: "DELETE",
      url: `/api/characters/${character.id}`,
    })).json() as { permanent: boolean; hiddenConversations: number };
    expect(deleted.permanent).toBe(false);
    expect(deleted.hiddenConversations).toBeGreaterThanOrEqual(1);

    // 列表默认不再出现；回收站可见。
    const list = (await app.inject({ method: "GET", url: "/api/characters" })).json() as { total: number };
    expect(list.total).toBe(0);
    const deletedList = (await app.inject({ method: "GET", url: "/api/characters/deleted" })).json() as {
      total: number;
      items: Array<{ id: string; deletedAt: string | null }>;
    };
    expect(deletedList.total).toBe(1);
    expect(deletedList.items[0]?.id).toBe(character.id);
    expect(deletedList.items[0]?.deletedAt).not.toBeNull();
    // 软删除后故事不再出现在故事列表。
    const conversations = (await app.inject({ method: "GET", url: "/api/conversations" })).json() as { total: number };
    expect(conversations.total).toBe(0);

    // 恢复：重新出现在列表，故事与记忆回归。
    const restored = (await app.inject({
      method: "POST",
      url: `/api/characters/${character.id}/restore`,
    })).json() as { restored: boolean };
    expect(restored.restored).toBe(true);
    const relisted = (await app.inject({ method: "GET", url: "/api/characters" })).json() as { total: number };
    expect(relisted.total).toBe(1);
    const reloaded = characterDetailSchema.parse((await app.inject({
      method: "GET",
      url: `/api/characters/${character.id}`,
    })).json());
    expect(reloaded.deletedAt).toBeNull();
    expect((await app.inject({ method: "GET", url: "/api/conversations" })).json()).toMatchObject({ total: 1 });

    // 边界：非法 permanent 值 400；未删除角色恢复 404；未知角色 404。
    expect((await app.inject({ method: "DELETE", url: `/api/characters/${character.id}?permanent=maybe` })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/characters/${character.id}/restore` })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/api/characters/00000000-0000-4000-8000-000000000000" })).statusCode).toBe(404);
  });

  it("permanently deletes a character and cascades conversations and memories (FR-DATA-004)", async () => {
    const { app, character, conversation } = await seedConversation();
    await waitForMemories(app, conversation.id);

    const deleted = (await app.inject({
      method: "DELETE",
      url: `/api/characters/${character.id}?permanent=true`,
    })).json() as { permanent: boolean; hiddenConversations: number; hiddenMemories: number };
    expect(deleted.permanent).toBe(true);
    expect(deleted.hiddenConversations).toBeGreaterThanOrEqual(1);

    // 级联清理：角色、故事、消息、记忆全部消失。
    expect((await app.inject({ method: "GET", url: `/api/characters/${character.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/characters" })).json()).toMatchObject({ total: 0 });
    expect((await app.inject({ method: "GET", url: "/api/characters/deleted" })).json()).toMatchObject({ total: 0 });
    expect((await app.inject({ method: "GET", url: "/api/conversations" })).json()).toMatchObject({ total: 0 });
    expect((await app.inject({ method: "GET", url: `/api/conversations/${conversation.id}` })).statusCode).toBe(404);
    // 回收站里没有软删除记录（是永久删除）。
    const deletedList = (await app.inject({ method: "GET", url: "/api/characters/deleted" })).json() as { total: number };
    expect(deletedList.total).toBe(0);
  });

  it("exports a full backup with checksum and restores it into a fresh service (FR-DATA-003)", async () => {
    const { app, character, conversation } = await seedConversation();
    await waitForMemories(app, conversation.id);

    // 安装一个声明式插件与一个代码扩展，验证两者都进入备份。
    const pluginInstalled = await app.inject({
      method: "POST",
      url: "/api/plugins/install",
      payload: {
        schemaVersion: 1,
        id: "scene-director",
        name: "场景导演",
        version: "1.0.0",
        license: "AGPL-3.0-only",
        permissions: ["prompt:system"],
        contributes: { systemPrompt: "Maintain continuity." },
      },
    });
    expect(pluginInstalled.statusCode).toBe(201);
    const codeInstalled = await app.inject({
      method: "POST",
      url: "/api/code-plugins/install",
      headers: {
        "content-type": "application/zip",
        "x-plugin-filename": "sandbox-test.zip",
      },
      payload: sandboxExtensionZip,
    });
    expect(codeInstalled.statusCode).toBe(201);

    const backupResponse = await app.inject({ method: "GET", url: "/api/backup" });
    expect(backupResponse.statusCode).toBe(200);
    expect(backupResponse.headers["content-disposition"]).toContain("mycompanion-backup-");
    const backup = backupPayloadSchemaShared.parse(backupResponse.json());
    expect(backup.format).toBe("mycompanion-backup");
    expect(backup.manifest.characterCount).toBe(1);
    expect(backup.manifest.conversationCount).toBe(1);
    expect(backup.manifest.messageCount).toBeGreaterThanOrEqual(3);
    expect(backup.manifest.memoryCount).toBeGreaterThanOrEqual(1);
    expect(backup.manifest.pluginCount).toBe(1);
    expect(backup.manifest.codePluginCount).toBe(1);
    expect(backup.manifest.checksum).toMatch(/^[a-f0-9]{64}$/);
    // 非秘密设置包含在内；API Key 只以 hasApiKey 占位，无密文。
    expect(backup.providerSettings).toMatchObject({ kind: "ollama", model: "test-model" });
    expect((backupResponse.body as string).includes("ciphertext")).toBe(false);

    // 恢复预览：全新服务全部为“新增”。
    const restoreApp = buildApp();
    apps.push(restoreApp);
    const preview = (await restoreApp.inject({
      method: "POST",
      url: "/api/backup/restore/preview",
      payload: { backup, strategy: "overwrite" },
    })).json() as {
      valid: boolean;
      sections: {
        characters: { new: number };
        conversations: { new: number };
        memories: { new: number };
        plugins: { new: number };
        codePlugins: { new: number };
      };
    };
    expect(preview.valid).toBe(true);
    expect(preview.sections.characters.new).toBe(1);
    expect(preview.sections.conversations.new).toBe(1);
    expect(preview.sections.memories.new).toBeGreaterThanOrEqual(1);
    expect(preview.sections.plugins.new).toBe(1);
    expect(preview.sections.codePlugins.new).toBe(1);

    // 执行恢复。
    const restored = (await restoreApp.inject({
      method: "POST",
      url: "/api/backup/restore",
      payload: { backup, strategy: "overwrite" },
    })).json() as { applied: { characters: number; conversations: number; memories: number; plugins: number; codePlugins: number } };
    expect(restored.applied.characters).toBe(1);
    expect(restored.applied.conversations).toBe(1);
    expect(restored.applied.memories).toBeGreaterThanOrEqual(1);
    expect(restored.applied.plugins).toBe(1);
    expect(restored.applied.codePlugins).toBe(1);

    // 恢复后的数据完整：角色、故事（含消息树）、记忆、插件、设置。
    const restoredCharacter = characterDetailSchema.parse((await restoreApp.inject({
      method: "GET",
      url: `/api/characters/${character.id}`,
    })).json());
    expect(restoredCharacter.name).toBe(character.name);
    const restoredConversation = conversationDetailSchema.parse((await restoreApp.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}`,
    })).json());
    expect(restoredConversation.characterName).toBe(character.name);
    expect(restoredConversation.messages.some((message) => message.content.includes("北行"))).toBe(true);
    const restoredMemories = (await restoreApp.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}/memories`,
    })).json() as { items: MemoryRecord[] };
    expect(restoredMemories.items.length).toBeGreaterThanOrEqual(1);
    const restoredPlugins = (await restoreApp.inject({ method: "GET", url: "/api/plugins" })).json() as { total: number };
    expect(restoredPlugins.total).toBe(1);
    const restoredCodePlugins = (await restoreApp.inject({ method: "GET", url: "/api/code-plugins" })).json() as { total: number };
    expect(restoredCodePlugins.total).toBe(1);
    // 非秘密设置已恢复；密钥未进入备份，恢复后仍是“未配置”。
    expect((await restoreApp.inject({ method: "GET", url: "/api/settings/provider" })).json()).toMatchObject({
      kind: "ollama",
      model: "test-model",
      hasApiKey: false,
    });

    // 幂等性：重复恢复同一备份，全部计入跳过，不再写入。
    const secondPreview = (await restoreApp.inject({
      method: "POST",
      url: "/api/backup/restore/preview",
      payload: { backup, strategy: "overwrite" },
    })).json() as { sections: { characters: { skip: number } } };
    expect(secondPreview.sections.characters.skip).toBe(1);
    const secondRestore = await restoreApp.inject({
      method: "POST",
      url: "/api/backup/restore",
      payload: { backup, strategy: "overwrite" },
    });
    const secondRestoreJson = secondRestore.json() as { applied: { characters: number }; skipped: { characters: number } };
    expect(secondRestoreJson.applied.characters).toBe(0);
    expect(secondRestoreJson.skipped.characters).toBe(1);

    // Install provenance is part of restore equality even when all assets are
    // identical. Old backups without provenance must remain valid too.
    const sourceBackup = structuredClone(backup);
    const installSource = { sourceUrl: "https://example.invalid/sandbox-test.git", sourceRef: "feature/preserved", sourceRevision: "1234567890abcdef1234567890abcdef12345678" };
    Object.assign(sourceBackup.codePlugins[0]!, installSource);
    sourceBackup.manifest.checksum = backupChecksum(sourceBackup);
    const sourcePreview = await restoreApp.inject({ method: "POST", url: "/api/backup/restore/preview", payload: { backup: sourceBackup, strategy: "overwrite" } });
    expect(sourcePreview.statusCode).toBe(200);
    expect(sourcePreview.json().sections.codePlugins.overwrite).toBe(1);
    const sourceRestore = await restoreApp.inject({ method: "POST", url: "/api/backup/restore", payload: { backup: sourceBackup, strategy: "overwrite" } });
    expect(sourceRestore.json().applied.codePlugins).toBe(1);
    const sourceExportResponse = await restoreApp.inject({ method: "GET", url: "/api/backup" });
    expect(sourceExportResponse.statusCode, sourceExportResponse.body).toBe(200);
    const sourceExport = backupPayloadSchemaShared.parse(sourceExportResponse.json());
    expect(sourceExport.codePlugins[0]).toMatchObject(installSource);
    expect(sourceExport.manifest.checksum).toBe(backupChecksum(sourceExport));
    const sourceRepeat = await restoreApp.inject({ method: "POST", url: "/api/backup/restore/preview", payload: { backup: sourceBackup, strategy: "overwrite" } });
    expect(sourceRepeat.json().sections.codePlugins.skip).toBe(1);

    // 完整性校验：篡改内容后 checksum 不匹配 → 预览标记无效，恢复返回 422。
    const tampered = structuredClone(backup);
    (tampered.characters[0]!.rawCard.data as { name: string }).name = "被改动";
    const tamperedPreview = await restoreApp.inject({
      method: "POST",
      url: "/api/backup/restore/preview",
      payload: { backup: tampered, strategy: "overwrite" },
    });
    expect(tamperedPreview.statusCode).toBe(422);
    expect((tamperedPreview.json() as { valid: boolean }).valid).toBe(false);
    const tamperedRestore = await restoreApp.inject({
      method: "POST",
      url: "/api/backup/restore",
      payload: { backup: tampered, strategy: "overwrite" },
    });
    expect(tamperedRestore.statusCode).toBe(422);

    // 交叉引用：记忆指向的角色不在备份内 → 即使重算 checksum 一致也判定无效。
    const dangling = structuredClone(backup);
    dangling.memories[0]!.characterId = randomUUID();
    dangling.manifest.checksum = backupChecksum(dangling);
    const danglingPreview = await restoreApp.inject({
      method: "POST",
      url: "/api/backup/restore/preview",
      payload: { backup: dangling, strategy: "overwrite" },
    });
    expect(danglingPreview.statusCode).toBe(422);
    const danglingErrors = (danglingPreview.json() as { errors: string[] }).errors;
    expect(danglingErrors.some((error) => error.includes("记忆"))).toBe(true);
  });

  it("rejects an invalid restore payload (FR-DATA-003)", async () => {
    const restoreApp = buildApp();
    apps.push(restoreApp);
    // 备份包不满足格式契约（strict 校验）→ 400。
    const invalid = await restoreApp.inject({
      method: "POST",
      url: "/api/backup/restore/preview",
      payload: { backup: { format: "wrong" }, strategy: "overwrite" },
    });
    expect(invalid.statusCode).toBe(400);
    // 恢复策略取值非法 → 400。
    const badStrategy = await restoreApp.inject({
      method: "POST",
      url: "/api/backup/restore/preview",
      payload: { strategy: "merge" },
    });
    expect(badStrategy.statusCode).toBe(400);
  });
});
