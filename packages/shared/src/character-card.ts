import { z } from "zod";

export const characterCardPreviewWarningCodeSchema = z.enum([
  "unknown_fields_preserved",
  "extensions_present",
  "lorebook_stored_inactive",
  "regex_scripts_stored_disabled",
  "v3_assets_not_imported",
  "group_greetings_not_supported",
  "compatibility_defaults_applied",
  "legacy_format_converted",
]);

export type CharacterCardPreviewWarningCode = z.infer<
  typeof characterCardPreviewWarningCodeSchema
>;

export const characterCardPreviewRequestSchema = z
  .object({
    filename: z.string().trim().min(1).max(255),
    card: z.unknown(),
  })
  .strict();

export type CharacterCardPreviewRequest = z.infer<
  typeof characterCardPreviewRequestSchema
>;

export const characterCardFormatSchema = z.enum([
  "ccv2-json",
  "ccv3-json",
  "ccv2-png",
  "ccv3-png",
  "ccv2-charx",
  "ccv3-charx",
  "tavern-v1-json",
  "pygmalion-json",
  "tavern-yaml",
  "backyard-byaf",
]);

export const lorebookEntryPreviewSchema = z.object({
  index: z.number().int().nonnegative(),
  name: z.string(),
  keys: z.array(z.string()),
  secondaryKeys: z.array(z.string()),
  contentPreview: z.string(),
  sourceEnabled: z.boolean(),
  constant: z.boolean(),
  selective: z.boolean(),
  useRegex: z.boolean(),
  insertionOrder: z.number(),
  runtimeState: z.literal("stored_inactive"),
});

export type LorebookEntryPreview = z.infer<typeof lorebookEntryPreviewSchema>;

export const regexScriptPreviewSchema = z.object({
  index: z.number().int().nonnegative(),
  name: z.string(),
  findRegexPreview: z.string(),
  replaceStringPreview: z.string(),
  placements: z.array(z.string()),
  sourceDisabled: z.boolean(),
  markdownOnly: z.boolean(),
  promptOnly: z.boolean(),
  runOnEdit: z.boolean(),
  minDepth: z.number().nullable(),
  maxDepth: z.number().nullable(),
  runtimeState: z.literal("stored_disabled"),
});

export type RegexScriptPreview = z.infer<typeof regexScriptPreviewSchema>;

// 角色卡内保存的完整正则规则（FR-REGEX-001）。查找表达式采用 SillyTavern 的
// "/pattern/flags" 斜杠分隔格式；执行阶段的映射由本地服务负责。
export const characterRegexRuleSchema = z.object({
  id: z.string().optional(),
  scriptName: z.string().min(1),
  findRegex: z.string().min(1),
  replaceString: z.string(),
  trimStrings: z.array(z.string()).optional(),
  substituteRegex: z.number().optional(),
  placement: z.array(z.unknown()).default([]),
  // 与 SillyTavern 行为一致：导入的规则默认停用，由用户显式启用后才参与聊天。
  disabled: z.boolean().default(true),
  markdownOnly: z.boolean().default(false),
  promptOnly: z.boolean().default(false),
  runOnEdit: z.boolean().default(false),
  minDepth: z.number().nullable().default(null),
  maxDepth: z.number().nullable().default(null),
  // 原始导入顺序（FR-REGEX-002：没有显式顺序时保持导入顺序）。
  order: z.number().int().nonnegative().default(0),
  // 卡片自带的 disabled 值，仅供展示（与运行时启用状态分离）。
  sourceDisabled: z.boolean().default(false),
});

export type CharacterRegexRule = z.infer<typeof characterRegexRuleSchema>;

// 角色卡内保存的完整世界书条目（FR-LORE-002）。字段与 Character Card V2/V3 的
// data.character_book.entries 对齐；关键词匹配、预算与插入顺序由本地服务负责。
export const characterLorebookEntrySchema = z.object({
  index: z.number().int().nonnegative(),
  name: z.string().min(1),
  keys: z.array(z.string()),
  secondaryKeys: z.array(z.string()),
  content: z.string(),
  // 当前产品的导入策略；不是 SillyTavern 的默认启用行为。
  enabled: z.boolean().default(false),
  constant: z.boolean().default(false),
  caseSensitive: z.boolean().default(false),
  // 启用时主关键词命中后，还必须通过次关键词的选择逻辑。
  selective: z.boolean().default(false),
  insertionOrder: z.number(),
  worldInfo: z.record(z.string(), z.unknown()).optional(),
  // 卡片自带的 enabled 值，仅供展示（与运行时启用状态分离）。
  sourceEnabled: z.boolean().default(false),
});

export type CharacterLorebookEntry = z.infer<typeof characterLorebookEntrySchema>;

export const characterCardPreviewResponseSchema = z.object({
  duplicates: z.array(z.object({ id: z.uuid(), name: z.string(), updatedAt: z.iso.datetime(),
    match: z.enum(["exact", "same-name"]) })).optional(),
  format: characterCardFormatSchema,
  specVersion: z.string().min(1),
  name: z.string(),
  descriptionPreview: z.string(),
  firstMessagePreview: z.string(),
  creator: z.string(),
  characterVersion: z.string(),
  tags: z.array(z.string()),
  alternateGreetingsCount: z.number().int().nonnegative(),
  groupOnlyGreetingsCount: z.number().int().nonnegative(),
  lorebookEntryCount: z.number().int().nonnegative(),
  regexScriptCount: z.number().int().nonnegative(),
  lorebookEntries: z.array(lorebookEntryPreviewSchema),
  regexScripts: z.array(regexScriptPreviewSchema),
  assetCount: z.number().int().nonnegative(),
  importedAssetCount: z.number().int().nonnegative().optional(),
  importedScenarioCount: z.number().int().nonnegative().optional(),
  extensionKeys: z.array(z.string()),
  unknownFieldPaths: z.array(z.string()),
  compatibilityDefaultPaths: z.array(z.string()).default([]),
  warningCodes: z.array(characterCardPreviewWarningCodeSchema),
});

export type CharacterCardPreviewResponse = z.infer<
  typeof characterCardPreviewResponseSchema
>;

export const characterImportCommitQuerySchema = z.object({
  mode: z.enum(["copy", "replace"]).default("copy"),
  targetId: z.uuid().optional(), expectedUpdatedAt: z.iso.datetime().optional(),
}).strict().superRefine((value, context) => {
  if (value.mode === "replace" && (!value.targetId || !value.expectedUpdatedAt))
    context.addIssue({ code: "custom", message: "替换角色需要目标 ID 和预览版本。" });
  if (value.mode === "copy" && (value.targetId || value.expectedUpdatedAt))
    context.addIssue({ code: "custom", message: "复制角色不能指定替换目标。" });
});

// 原生角色更新请求（PUT /api/characters/:id）：完整的角色卡 JSON 文档。
export const characterUpdateRequestSchema = z
  .object({
    card: z.unknown(),
  })
  .strict();

export type CharacterUpdateRequest = z.infer<typeof characterUpdateRequestSchema>;

export const characterSummarySchema = z.object({
  avatar: z.string().optional(),
  id: z.uuid(),
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  sourceFormat: characterCardFormatSchema,
  sourceVersion: z.string(),
  alternateGreetingsCount: z.number().int().nonnegative(),
  lorebookEntryCount: z.number().int().nonnegative(),
  regexScriptCount: z.number().int().nonnegative(),
  // 软删除时间（FR-DATA-004）：非空表示角色已被软删除（可恢复）。
  deletedAt: z.iso.datetime().nullable().default(null),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type CharacterSummary = z.infer<typeof characterSummarySchema>;

export const characterDetailSchema = characterSummarySchema.extend({
  personality: z.string(),
  scenario: z.string(),
  firstMessage: z.string(),
  alternateGreetings: z.array(z.string()),
  exampleDialogue: z.string(),
  systemPrompt: z.string(),
  postHistoryInstructions: z.string(),
  creatorNotes: z.string(),
  creator: z.string(),
  characterVersion: z.string(),
  rawExtensions: z.record(z.string(), z.unknown()),
  unknownFieldPaths: z.array(z.string()),
  lorebookEntries: z.array(lorebookEntryPreviewSchema),
  regexScripts: z.array(regexScriptPreviewSchema),
  // 卡内正则规则的运行时启用状态（与导入时的 disabled 分离；默认全部停用）。
  regexEnabled: z.array(characterRegexRuleSchema),
  // 卡内世界书条目的运行时启用状态（FR-LORE-001/002；默认全部停用）。
  lorebookEnabled: z.array(characterLorebookEntrySchema),
});

export type CharacterDetail = z.infer<typeof characterDetailSchema>;

export const characterListResponseSchema = z.object({
  items: z.array(characterSummarySchema),
  total: z.number().int().nonnegative(),
});

export type CharacterListResponse = z.infer<
  typeof characterListResponseSchema
>;

export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.array(z.string()).optional(),
  }),
});

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
