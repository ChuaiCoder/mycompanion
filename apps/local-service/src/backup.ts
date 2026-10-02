import { createHash } from "node:crypto";
import { parseCharacterCardDocument } from "@mycompanion/character-card";

import type {
  BackupPayload,
  BackupRestorePreviewResponse,
  BackupRestoreResponse,
  RetainedCharacterChats,
} from "@mycompanion/shared";
import { backupPayloadSchemaShared, backupRestoreResponseSchema, worldInfoSettingsSchema } from "@mycompanion/shared";
import type { CharacterRepository } from "./character-repository.js";
import type { RuntimeRepository } from "./runtime-repository.js";
import { imageType, validAvatarId } from "./persona-avatars.js";
import { validateCharacterAssetBackup } from "./character-assets.js";

/**
 * 完整备份与恢复（FR-DATA-003）。
 * - 备份包：角色（原始卡 + 世界书/正则启用状态 + 头像）、故事线（全部分支消息树）、
 *   记忆、阶段摘要、对话设置、声明式插件、SillyTavern 扩展、非秘密模型设置。
 * - API Key 以 hasApiKey 占位，不含密文（密钥单独加密存储，不参与迁移）。
 * - 完整性：manifest.checksum 为去掉 checksum 字段后的规范化 JSON 的 sha256；
 *   恢复前必须通过校验。
 */

export interface BackupSources {
  characters: CharacterRepository;
  runtime: RuntimeRepository;
}

function extensionSource(value: Pick<BackupPayload["codePlugins"][number], "sourceUrl" | "sourceRef" | "sourceRevision">): Record<string, string> {
  return {
    ...(value.sourceUrl ? { sourceUrl: value.sourceUrl } : {}),
    ...(value.sourceRef ? { sourceRef: value.sourceRef } : {}),
    ...(value.sourceRevision ? { sourceRevision: value.sourceRevision } : {}),
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/** 规范化 JSON 的 sha256（键排序、剔除 undefined），作为内容完整性校验。 */
export function backupChecksum(payload: Omit<BackupPayload, "manifest"> & { manifest?: unknown }): string {
  const { manifest, ...content } = payload;
  void manifest;
  return createHash("sha256").update(canonicalJson(content), "utf8").digest("hex");
}

function sameConversation(entry: BackupPayload["conversations"][number], runtime: RuntimeRepository): boolean {
  const existing = runtime.getConversation(entry.id);
  if (!existing || existing.title !== entry.title || existing.characterId !== entry.characterId || existing.characterName !== entry.characterName || existing.activeBranchId !== entry.activeBranchId) return false;
  if (entry.chatMetadata !== undefined && canonicalJson(existing.chatMetadata) !== canonicalJson(entry.chatMetadata)) return false;
  const saved = new Map(entry.messages.map(message => [`${message.branchId}/${message.id}`, message]));
  const normalize = (messages: typeof entry.messages) => {
    const branches = new Map<string, unknown[]>();
    for (const message of messages) {
      const branch = branches.get(message.branchId) ?? [];
      branch.push({ id: message.id, parentMessageId: message.parentMessageId, role: message.role, content: message.content, status: message.status,
        ...(saved.get(`${message.branchId}/${message.id}`)?.generationMetadata === undefined ? {} : { generationMetadata: message.generationMetadata }),
        ...(saved.get(`${message.branchId}/${message.id}`)?.extensionData === undefined ? {} : { extensionData: message.extensionData }) });
      branches.set(message.branchId, branch);
    }
    return canonicalJson(Object.fromEntries(branches));
  };
  return normalize(runtime.listAllBranchMessages(entry.id)) === normalize(entry.messages);
}

export function assembleBackupPayload(sources: BackupSources): BackupPayload {
  const { characters, runtime } = sources;
  const characterEntries = characters.listForBackup();
  const conversations = runtime.listConversationsForBackup();
  const memories = runtime.listMemoriesForBackup();
  const stageSummaries = runtime.listStageSummariesForBackup();
  const conversationSettings = runtime.listConversationSettingsForBackup();
  const plugins = runtime.listPlugins().items
    .filter((plugin) => Boolean(runtime.getPluginManifest(plugin.id)))
    .map((plugin) => ({
      id: plugin.id,
      manifest: runtime.getPluginManifest(plugin.id) as Record<string, unknown>,
      enabled: plugin.enabled,
      installedAt: plugin.installedAt,
    }));
  const codePlugins = runtime.listCodePlugins().items.map((plugin) => {
    const entry = runtime.getCodePluginBackupEntry(plugin.id);
    return {
      id: plugin.id,
      manifest: runtime.getCodePluginManifest(plugin.id) as Record<string, unknown>,
      enabled: plugin.enabled,
      installedAt: plugin.installedAt,
      contributions: entry?.contributions ?? { systemPrompt: "", commands: [] },
      files: entry?.files ?? {},
      ...extensionSource(plugin),
    };
  });
  const settings = runtime.getProvider();

  const base = {
    format: "mycompanion-backup" as const,
    formatVersion: 1 as const,
    createdAt: new Date().toISOString(),
    characters: characterEntries.map((entry) => ({
      ...entry,
      regexEnabledIndexes: entry.regexEnabledIndexes,
      lorebookEnabledIndexes: entry.lorebookEnabledIndexes,
    })),
    conversations: conversations.map((conversation) => ({
      id: conversation.id,
      characterId: conversation.characterId,
      characterName: conversation.characterName,
      title: conversation.title,
      activeBranchId: conversation.activeBranchId,
      chatMetadata: conversation.chatMetadata,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messages: conversation.messages.map((message) => ({
        id: message.id,
        branchId: message.branchId,
        parentMessageId: message.parentMessageId,
        role: message.role,
        content: message.content,
        status: message.status,
        ...(message.generationMetadata === undefined ? {} : { generationMetadata: message.generationMetadata }),
        ...(message.extensionData === undefined ? {} : { extensionData: message.extensionData }),
        createdAt: message.createdAt,
      })),
    })),
    memories: memories.map((memory) => ({ ...memory })),
    stageSummaries: stageSummaries.map((summary) => ({ ...summary })),
    conversationSettings: conversationSettings.map((setting) => ({ ...setting })),
    plugins,
    codePlugins,
    extensionSettings: runtime.getExtensionSettings(),
    userAvatars: runtime.avatars.listForBackup(),
    worldbooks: runtime.worldInfo.names().map(name => ({ name, data: runtime.worldInfo.get(name)! })),
    worldInfoSettings: runtime.worldInfo.settings(),
    retainedCharacterChats: runtime.retainedChats.list(),
    providerSettings: {
      kind: settings.kind,
      baseUrl: settings.baseUrl,
      model: settings.model,
      // 密钥不进备份：只记录是否已配置，恢复后仍需在本机重新输入。
      hasApiKey: settings.hasApiKey,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      contextLimitTokens: settings.contextLimitTokens,
    },
  };
  const checksum = backupChecksum(base);
  return backupPayloadSchemaShared.parse({
    ...base,
    manifest: {
      characterCount: base.characters.length,
      conversationCount: base.conversations.length,
      messageCount: base.conversations.reduce((sum, item) => sum + item.messages.length, 0),
      memoryCount: base.memories.length,
      pluginCount: base.plugins.length,
      codePluginCount: base.codePlugins.length,
      settingsIncluded: true,
      checksum,
    },
  });
}

/** 恢复前校验：格式契约 + 完整性校验 + 交叉引用（故事/记忆必须指向备份内的角色）。 */
export function verifyBackupPayload(payload: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const parsed = backupPayloadSchemaShared.safeParse(payload);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.slice(0, 10).map((issue) => issue.message),
    };
  }
  const backup = parsed.data;
  errors.push(...detachedIdentityErrors(backup.retainedCharacterChats ?? [], backup.characters, backup.conversations, backup.memories));
  const expected = backupChecksum(backup);
  if (backup.worldInfoSettings !== undefined && !worldInfoSettingsSchema.safeParse(backup.worldInfoSettings).success) errors.push("世界书设置无效。");
  if (new Set(backup.worldbooks?.map(book => book.name)).size !== (backup.worldbooks?.length ?? 0)) errors.push("备份包含重复的世界书名称。");
  if (backup.worldbooks?.some(book => !book.name.trim() || book.name.includes("\0"))) errors.push("世界书名称无效。");
  if (backup.manifest.checksum !== expected) {
    errors.push("完整性校验失败：备份内容已改动或不完整，请重新导出。");
  }
  const characterIds = new Set(backup.characters.map((item) => item.id));
  for (const entry of backup.characters) {
    try { parseCharacterCardDocument(entry.rawCard); } catch { errors.push(`角色卡数据无效：${entry.id}`); }
    try { validateCharacterAssetBackup(entry.assets); } catch (error) { errors.push(`角色资产无效：${entry.id}（${error instanceof Error ? error.message : String(error)}）`); }
  }
  const avatars = backup.characters.map(item => (item.avatar ?? `${item.id}.png`).toLowerCase());
  if (new Set(avatars).size !== avatars.length) errors.push("备份包含重复的角色头像标识。");
  const userAvatarIds = (backup.userAvatars ?? []).map(item => item.avatarId.toLowerCase());
  if (new Set(userAvatarIds).size !== userAvatarIds.length) errors.push("备份包含重复的用户头像标识。");
  for (const avatar of backup.userAvatars ?? []) {
    const bytes = Buffer.from(avatar.bytesBase64, "base64");
    if (!validAvatarId(avatar.avatarId) || bytes.length === 0 || bytes.length > 20 * 1024 * 1024 ||
      bytes.toString("base64") !== avatar.bytesBase64 || !imageType(bytes)) errors.push(`用户头像数据无效：${avatar.avatarId}`);
  }
  if (backup.conversations.some((item) => !characterIds.has(item.characterId))) {
    errors.push("存在指向未包含角色的故事线，请重新导出备份。");
  }
  if (backup.memories.some((item) => !characterIds.has(item.characterId))) {
    errors.push("存在指向未包含角色的记忆，请重新导出备份。");
  }
  const conversationIds = new Set(backup.conversations.map((item) => item.id));
  if (backup.memories.some((item) => !conversationIds.has(item.conversationId))) {
    errors.push("存在指向未包含故事线的记忆，请重新导出备份。");
  }
  if (backup.stageSummaries.some((item) => !conversationIds.has(item.conversationId))) {
    errors.push("存在指向未包含故事线的阶段摘要，请重新导出备份。");
  }
  errors.push(...summaryReferenceErrors(backup));
  return { valid: errors.length === 0, errors: errors.slice(0, 50) };
}

/** Preserve stale derived content, but never allow it to claim another story's sources. */
function summaryReferenceErrors(backup: BackupPayload): string[] {
  const conversations = [...backup.conversations, ...(backup.retainedCharacterChats ?? []).flatMap(entry => entry.conversations)];
  const summaries = [...backup.stageSummaries, ...(backup.retainedCharacterChats ?? []).flatMap(entry => entry.stageSummaries)];
  const stories = new Map(conversations.map(story => [story.id, story]));
  const branches = new Map<string, Set<string>>(), messages = new Map<string, Set<string>>();
  for (const story of conversations) {
    for (const branchId of new Set([story.activeBranchId, ...story.messages.map(message => message.branchId)])) {
      const owners = branches.get(branchId) ?? new Set<string>();
      owners.add(story.id); branches.set(branchId, owners);
    }
    for (const message of story.messages) {
      const owners = messages.get(message.id) ?? new Set<string>();
      owners.add(story.id); messages.set(message.id, owners);
    }
  }
  const errors: string[] = [];
  for (const summary of summaries) {
    const story = stories.get(summary.conversationId);
    if (!story) continue; // Missing stories are rejected by the section schemas/identity checks.
    const branchId = summary.branchId ?? story.activeBranchId;
    const branchOwners = branches.get(branchId);
    if (branchOwners && !branchOwners.has(story.id)) errors.push(`阶段摘要分支属于其他故事：${summary.conversationId}/${branchId}`);
    for (const sourceId of [...(summary.sourceMessageIds ?? []), ...(summary.previousSource?.sourceMessageIds ?? [])]) {
      const sourceOwners = messages.get(sourceId);
      if (sourceOwners && !sourceOwners.has(story.id)) {
        errors.push(`阶段摘要来源属于其他故事：${summary.conversationId}/${sourceId}`);
      }
    }
    // A deleted source may survive on another branch of the same story. Preserve
    // such history; branch prefix/ID/revision validity is checked by getSummary.
  }
  return errors;
}

interface SectionTally {
  new: number;
  overwrite: number;
  skip: number;
  conflict: number;
}

const emptyTally = (): SectionTally => ({ new: 0, overwrite: 0, skip: 0, conflict: 0 });

function detachedIdentityErrors(
  archives: RetainedCharacterChats[],
  characters: Array<{ id: string; avatar?: string | undefined }>,
  conversations: Array<{ id: string; messages: Array<{ id: string; branchId: string }> }>,
  memories: Array<{ id: string }>,
): string[] {
  const avatars = new Set(characters.map(item => (item.avatar ?? `${item.id}.png`).toLowerCase()));
  const chats = new Set(conversations.map(item => item.id)), memoryIds = new Set(memories.map(item => item.id));
  const messages = new Set(conversations.flatMap(chat => chat.messages.map(message => `${message.id}/${message.branchId}`)));
  const errors: string[] = [];
  for (const archive of archives) {
    const key = archive.avatar.toLowerCase();
    if (avatars.has(key)) errors.push(`保留聊天与已有角色/档案的头像标识冲突：${archive.avatar}`);
    avatars.add(key);
    for (const chat of archive.conversations) {
      if (chats.has(chat.id)) errors.push(`保留聊天的故事标识冲突：${chat.id}`);
      chats.add(chat.id);
      for (const message of chat.messages) {
        const key = `${message.id}/${message.branchId}`;
        if (messages.has(key)) errors.push(`保留聊天的消息标识冲突：${message.id}`);
        messages.add(key);
      }
    }
    for (const memory of archive.memories) {
      if (memoryIds.has(memory.id)) errors.push(`保留聊天的记忆标识冲突：${memory.id}`);
      memoryIds.add(memory.id);
    }
  }
  return errors;
}

function retainedRestoreConflicts(backup: BackupPayload, sources: BackupSources, strategy: "skip" | "overwrite"): string[] {
  const { characters, runtime } = sources;
  const archives = new Map(runtime.retainedChats.list().map(item => [item.avatar.toLowerCase(), item]));
  for (const entry of backup.retainedCharacterChats ?? []) if (strategy === "overwrite" || !archives.has(entry.avatar.toLowerCase())) archives.set(entry.avatar.toLowerCase(), entry);
  const combine = <T extends { id: string }>(existing: T[], incoming: T[]) => {
    const result = new Map(existing.map(item => [item.id, item]));
    for (const item of incoming) if (strategy === "overwrite" || !result.has(item.id)) result.set(item.id, item);
    return [...result.values()];
  };
  return detachedIdentityErrors([...archives.values()],
    combine<{ id: string; avatar?: string | undefined }>(characters.list({ includeDeleted: true }).items, backup.characters),
    combine<{ id: string; messages: Array<{ id: string; branchId: string }> }>(runtime.listConversationsForBackup(), backup.conversations),
    combine<{ id: string }>(runtime.listMemoriesForBackup(), backup.memories));
}

function avatarConflicts(backup: BackupPayload, characters: CharacterRepository, strategy: "skip" | "overwrite"): string[] {
  const owners = new Map(characters.list({ includeDeleted: true }).items.map(item => [(item.avatar ?? `${item.id}.png`).toLowerCase(), item.id]));
  const errors: string[] = [];
  for (const entry of backup.characters) {
    const existing = characters.getBackupEntry(entry.id);
    if (existing && strategy === "skip") continue;
    const avatar = (entry.avatar ?? existing?.avatar ?? `${entry.id}.png`).toLowerCase();
    if (owners.has(avatar) && owners.get(avatar) !== entry.id) errors.push(`角色头像标识冲突：${entry.avatar ?? avatar}`);
    owners.set(avatar, entry.id);
  }
  return errors;
}

/**
 * 恢复预览（FR-DATA-003）：按分区统计 新增 / 覆盖 / 跳过 / 冲突。
 * - 同 ID 内容一致 → skip（无需写入）；
 * - 同 ID 内容不同 → overwrite（strategy=skip 时计为 skip）；
 * - 内容差异无法自动合并（如故事消息树不同）→ conflict，默认按 overwrite 处理并提示。
 */
export function previewRestore(
  payload: unknown,
  sources: BackupSources,
  strategy: "overwrite" | "skip",
): BackupRestorePreviewResponse {
  const { valid, errors } = verifyBackupPayload(payload);
  const parsed = backupPayloadSchemaShared.safeParse(payload);
  if (!parsed.success) {
    return {
      valid: false,
      errors,
      sections: {
        characters: emptyTally(),
        conversations: emptyTally(),
        memories: emptyTally(),
        plugins: emptyTally(),
        codePlugins: emptyTally(),
        extensionSettings: emptyTally(),
        userAvatars: emptyTally(),
        worldbooks: emptyTally(),
        worldInfoSettings: emptyTally(),
        retainedCharacterChats: emptyTally(),
      },
      totals: emptyTally(),
    };
  }
  const backup = parsed.data;
  const { characters, runtime } = sources;
  errors.push(...avatarConflicts(backup, characters, strategy));
  errors.push(...retainedRestoreConflicts(backup, sources, strategy));

  const characterTally = emptyTally();
  for (const entry of backup.characters) {
    if (!characters.existsById(entry.id)) {
      characterTally.new += 1;
      continue;
    }
    const existing = characters.getBackupEntry(entry.id);
    if (!existing) {
      characterTally.overwrite += 1;
      continue;
    }
    const same =
      canonicalJson(existing.rawCard) === canonicalJson(entry.rawCard) &&
      (entry.avatar === undefined || existing.avatar === entry.avatar) &&
      existing.sourcePngBase64 === entry.sourcePngBase64 &&
      (entry.sourceFormat === undefined || existing.sourceFormat === entry.sourceFormat) &&
      canonicalJson(existing.assets ?? {}) === canonicalJson(entry.assets ?? {}) &&
      canonicalJson(existing.regexEnabledIndexes) === canonicalJson(entry.regexEnabledIndexes) &&
      canonicalJson(existing.lorebookEnabledIndexes) === canonicalJson(entry.lorebookEnabledIndexes);
    if (same) {
      characterTally.skip += 1;
    } else if (strategy === "skip") {
      characterTally.skip += 1;
    } else {
      characterTally.overwrite += 1;
    }
  }

  const conversationTally = emptyTally();
  for (const entry of backup.conversations) {
    if (!runtime.conversationExists(entry.id)) {
      conversationTally.new += 1;
      continue;
    }
    if (sameConversation(entry, runtime)) {
      conversationTally.skip += 1;
    } else if (strategy === "skip") {
      // 消息树差异无法自动合并：skip 策略下保留现有，计为冲突提示。
      conversationTally.conflict += 1;
    } else {
      conversationTally.overwrite += 1;
    }
  }

  const memoryTally = emptyTally();
  for (const entry of backup.memories) {
    if (!runtime.memoryExists(entry.id)) {
      memoryTally.new += 1;
      continue;
    }
    const existing = runtime.getMemory(entry.id);
    const same =
      existing !== undefined &&
      canonicalJson(existing) === canonicalJson(entry);
    if (same) {
      memoryTally.skip += 1;
    } else if (strategy === "skip") {
      memoryTally.skip += 1;
    } else {
      memoryTally.overwrite += 1;
    }
  }

  const pluginTally = emptyTally();
  for (const entry of backup.plugins) {
    if (!runtime.pluginExists(entry.id)) {
      pluginTally.new += 1;
      continue;
    }
    const existing = runtime.getPlugin(entry.id);
    const same =
      existing !== undefined &&
      canonicalJson(existing) === canonicalJson(entry);
    if (same) {
      pluginTally.skip += 1;
    } else if (strategy === "skip") {
      pluginTally.skip += 1;
    } else {
      pluginTally.overwrite += 1;
    }
  }

  const codePluginTally = emptyTally();
  for (const entry of backup.codePlugins) {
    if (!runtime.codePluginExists(entry.id)) {
      codePluginTally.new += 1;
      continue;
    }
    const existing = runtime.getCodePluginBackupEntry(entry.id);
    const existingManifest = runtime.getCodePluginManifest(entry.id);
    const same =
      existing !== undefined &&
      existingManifest !== undefined &&
      canonicalJson(existingManifest) === canonicalJson(entry.manifest) &&
      canonicalJson(extensionSource(existing)) === canonicalJson(extensionSource(entry)) &&
      canonicalJson(existing.contributions) === canonicalJson(entry.contributions) &&
      canonicalJson(existing.files) === canonicalJson(entry.files);
    if (same) {
      codePluginTally.skip += 1;
    } else if (strategy === "skip") {
      codePluginTally.skip += 1;
    } else {
      codePluginTally.overwrite += 1;
    }
  }

  const extensionSettingsTally = emptyTally();
  if (backup.extensionSettings !== undefined) {
    if (!runtime.hasExtensionSettings()) extensionSettingsTally.new = 1;
    else if (strategy === "skip" || canonicalJson(runtime.getExtensionSettings()) === canonicalJson(backup.extensionSettings)) extensionSettingsTally.skip = 1;
    else extensionSettingsTally.overwrite = 1;
  }
  const userAvatarTally = emptyTally();
  for (const avatar of backup.userAvatars ?? []) {
    const existing = runtime.avatars.get(avatar.avatarId);
    if (!existing) userAvatarTally.new++;
    else if (strategy === "skip" || Buffer.from(existing.bytes).toString("base64") === avatar.bytesBase64) userAvatarTally.skip++;
    else userAvatarTally.overwrite++;
  }

  const worldbookTally = emptyTally();
  for (const book of backup.worldbooks ?? []) {
    const existing = runtime.worldInfo.get(book.name);
    if (!existing) worldbookTally.new += 1;
    else if (strategy === "skip" || canonicalJson(existing) === canonicalJson(book.data)) worldbookTally.skip += 1;
    else worldbookTally.overwrite += 1;
  }
  const worldInfoSettingsTally = emptyTally();
  if (backup.worldInfoSettings !== undefined) {
    if (!runtime.worldInfo.hasSettings()) worldInfoSettingsTally.new = 1;
    else if (strategy === "skip" || canonicalJson(runtime.worldInfo.settings()) === canonicalJson(backup.worldInfoSettings)) worldInfoSettingsTally.skip = 1;
    else worldInfoSettingsTally.overwrite = 1;
  }
  const totals = emptyTally();
  const retainedTally = emptyTally();
  for (const entry of backup.retainedCharacterChats ?? []) {
    const existing = runtime.retainedChats.get(entry.avatar);
    if (!existing) retainedTally.new++;
    else if (strategy === "skip" || canonicalJson(existing) === canonicalJson(entry)) retainedTally.skip++;
    else retainedTally.overwrite++;
  }
  for (const section of [characterTally, conversationTally, memoryTally, pluginTally, codePluginTally, extensionSettingsTally, userAvatarTally, worldbookTally, worldInfoSettingsTally, retainedTally]) {
    totals.new += section.new;
    totals.overwrite += section.overwrite;
    totals.skip += section.skip;
    totals.conflict += section.conflict;
  }
  return {
    valid: valid && errors.length === 0,
    errors,
    sections: {
      characters: characterTally,
      conversations: conversationTally,
      memories: memoryTally,
      plugins: pluginTally,
      codePlugins: codePluginTally,
      extensionSettings: extensionSettingsTally,
      userAvatars: userAvatarTally,
      worldbooks: worldbookTally,
      worldInfoSettings: worldInfoSettingsTally,
      retainedCharacterChats: retainedTally,
    },
    totals,
  };
}

/** 按预览策略真正写入：skip 的项不写，overwrite/new 的项写入。 */
export function applyRestore(
  payload: unknown,
  sources: BackupSources,
  strategy: "overwrite" | "skip",
): BackupRestoreResponse {
  const { valid, errors } = verifyBackupPayload(payload);
  if (!valid) {
    throw new Error(errors.join("；") || "备份无效。");
  }
  const backup = backupPayloadSchemaShared.parse(payload);
  const { characters, runtime } = sources;
  const identityErrors = [...avatarConflicts(backup, characters, strategy), ...retainedRestoreConflicts(backup, sources, strategy)];
  if (identityErrors.length) throw new Error(identityErrors.join("；"));

  // The app repositories share one connection. Attachments and extension files
  // are SQLite BLOBs, so a single outer transaction includes every restored byte.
  return runtime.withBackupTransaction(() => applyRestoreSections(backup, sources, strategy));
}

function applyRestoreSections(
  backup: BackupPayload,
  { characters, runtime }: BackupSources,
  strategy: "overwrite" | "skip",
): BackupRestoreResponse {

  const applied: BackupRestoreResponse["applied"] = {
    characters: 0,
    conversations: 0,
    memories: 0,
    plugins: 0,
    codePlugins: 0,
    extensionSettings: 0,
    userAvatars: 0,
    worldbooks: 0,
    worldInfoSettings: 0,
    retainedCharacterChats: 0,
  };
  const skipped: BackupRestoreResponse["skipped"] = {
    characters: 0,
    conversations: 0,
    memories: 0,
    plugins: 0,
    codePlugins: 0,
    extensionSettings: 0,
    userAvatars: 0,
    worldbooks: 0,
    worldInfoSettings: 0,
    retainedCharacterChats: 0,
  };

  // 角色先行（后续故事/记忆依赖角色存在）。
  for (const entry of backup.characters) {
    if (!characters.existsById(entry.id)) {
      characters.restoreCharacter(entry);
      applied.characters += 1;
      continue;
    }
    const existing = characters.getBackupEntry(entry.id);
    if (
      existing &&
      canonicalJson(existing.rawCard) === canonicalJson(entry.rawCard) &&
      (entry.avatar === undefined || existing.avatar === entry.avatar) &&
      existing.sourcePngBase64 === entry.sourcePngBase64 &&
      (entry.sourceFormat === undefined || existing.sourceFormat === entry.sourceFormat) &&
      canonicalJson(existing.assets ?? {}) === canonicalJson(entry.assets ?? {}) &&
      canonicalJson(existing.regexEnabledIndexes) === canonicalJson(entry.regexEnabledIndexes) &&
      canonicalJson(existing.lorebookEnabledIndexes) === canonicalJson(entry.lorebookEnabledIndexes)
    ) {
      skipped.characters += 1;
      continue;
    }
    if (strategy === "skip" && existing) {
      skipped.characters += 1;
      continue;
    }
    characters.restoreCharacter(entry);
    applied.characters += 1;
  }

  for (const entry of backup.conversations) {
    if (!runtime.conversationExists(entry.id)) {
      runtime.restoreConversation(entry);
      applied.conversations += 1;
      continue;
    }
    if (sameConversation(entry, runtime)) {
      skipped.conversations += 1;
      continue;
    }
    if (strategy === "skip") {
      skipped.conversations += 1;
      continue;
    }
    runtime.restoreConversation(entry);
    applied.conversations += 1;
  }

  for (const entry of backup.memories) {
    const existing = runtime.getMemory(entry.id);
    if (existing && canonicalJson(existing) === canonicalJson(entry)) {
      skipped.memories += 1;
      continue;
    }
    if (strategy === "skip" && existing) {
      skipped.memories += 1;
      continue;
    }
    runtime.upsertMemoryForBackup(entry);
    applied.memories += 1;
  }

  for (const entry of backup.plugins) {
    const existing = runtime.getPlugin(entry.id);
    if (existing && canonicalJson(existing) === canonicalJson(entry)) {
      skipped.plugins += 1;
      continue;
    }
    if (strategy === "skip" && existing) {
      skipped.plugins += 1;
      continue;
    }
    runtime.restorePlugin(entry);
    applied.plugins += 1;
  }

  for (const entry of backup.codePlugins) {
    const existing = runtime.getCodePluginBackupEntry(entry.id);
    const existingManifest = runtime.getCodePluginManifest(entry.id);
    if (
      existing &&
      existingManifest &&
      canonicalJson(existingManifest) === canonicalJson(entry.manifest) &&
      canonicalJson(extensionSource(existing)) === canonicalJson(extensionSource(entry)) &&
      canonicalJson(existing.contributions) === canonicalJson(entry.contributions) &&
      canonicalJson(existing.files) === canonicalJson(entry.files)
    ) {
      skipped.codePlugins += 1;
      continue;
    }
    if (strategy === "skip" && existing) {
      skipped.codePlugins += 1;
      continue;
    }
    runtime.restoreCodePlugin(entry);
    applied.codePlugins += 1;
  }

  // 阶段摘要与对话设置随故事恢复。
  for (const summary of backup.stageSummaries) {
    if (strategy === "skip" && runtime.stageSummaryExists(summary.conversationId, summary.branchId)) continue;
    runtime.restoreStageSummary(summary);
  }
  for (const setting of backup.conversationSettings) {
    runtime.restoreConversationSetting(setting);
  }

  // Older backups omit this field and must not reset current extension data.
  for (const entry of backup.retainedCharacterChats ?? []) {
    const existing = runtime.retainedChats.get(entry.avatar);
    if (existing && (strategy === "skip" || canonicalJson(existing) === canonicalJson(entry))) skipped.retainedCharacterChats++;
    else { runtime.retainedChats.save(entry); applied.retainedCharacterChats++; }
  }
  if (backup.extensionSettings !== undefined) {
    if (runtime.hasExtensionSettings() && (strategy === "skip" || canonicalJson(runtime.getExtensionSettings()) === canonicalJson(backup.extensionSettings))) {
      skipped.extensionSettings = 1;
    } else {
      runtime.saveExtensionSettings(backup.extensionSettings);
      applied.extensionSettings = 1;
    }
  }
  for (const avatar of backup.userAvatars ?? []) {
    const existing = runtime.avatars.get(avatar.avatarId);
    if (existing && (strategy === "skip" || Buffer.from(existing.bytes).toString("base64") === avatar.bytesBase64)) skipped.userAvatars++;
    else { runtime.avatars.put(avatar.avatarId, Buffer.from(avatar.bytesBase64, "base64")); applied.userAvatars++; }
  }

  for (const book of backup.worldbooks ?? []) {
    const existing = runtime.worldInfo.get(book.name);
    if (existing && (strategy === "skip" || canonicalJson(existing) === canonicalJson(book.data))) skipped.worldbooks += 1;
    else { runtime.worldInfo.save(book.name, book.data); applied.worldbooks += 1; }
  }
  if (backup.worldInfoSettings !== undefined) {
    if (runtime.worldInfo.hasSettings() && (strategy === "skip" || canonicalJson(runtime.worldInfo.settings()) === canonicalJson(backup.worldInfoSettings))) skipped.worldInfoSettings = 1;
    else { runtime.worldInfo.saveSettings(worldInfoSettingsSchema.parse(backup.worldInfoSettings)); applied.worldInfoSettings = 1; }
  }

  // 非秘密模型设置：只写回 kind/baseUrl/model/采样参数，本机已加密的 API Key 保持不变。
  if (backup.providerSettings) {
    const { kind, baseUrl, model, temperature, maxTokens, contextLimitTokens } = backup.providerSettings;
    runtime.saveProvider({
      kind,
      baseUrl,
      model,
      clearApiKey: false,
      temperature,
      maxTokens,
      contextLimitTokens,
    });
  }

  // Validate the response before releasing the outer transaction.
  return backupRestoreResponseSchema.parse({ applied, skipped });
}
