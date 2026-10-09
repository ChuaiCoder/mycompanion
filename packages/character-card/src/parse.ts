import { z, type ZodError } from "zod";

import type {
  CharacterCardPreviewResponse,
  CharacterCardPreviewWarningCode,
  CharacterLorebookEntry,
  LorebookEntryPreview,
  RegexScriptPreview,
} from "@mycompanion/shared";

import {
  characterCardV2Schema,
  characterCardV3Schema,
  type CharacterCard,
} from "./schema.js";
import { convertLegacyCharacterCard } from "./legacy.js";

const envelopeSchema = z.object({ spec: z.string() }).passthrough();
const rootFields = new Set(["spec", "spec_version", "data"]);
const commonDataFields = new Set([
  "name",
  "description",
  "personality",
  "scenario",
  "first_mes",
  "mes_example",
  "creator_notes",
  "system_prompt",
  "post_history_instructions",
  "alternate_greetings",
  "character_book",
  "tags",
  "creator",
  "character_version",
  "extensions",
]);
const v3DataFields = new Set([
  ...commonDataFields,
  "assets",
  "creator_notes_multilingual",
  "source",
  "group_only_greetings",
  "creation_date",
  "modification_date",
]);

export class CharacterCardParseError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = "CharacterCardParseError";
    this.issues = issues;
  }
}

export interface ParsedCharacterCard {
  card: CharacterCard;
  preview: CharacterCardPreviewResponse;
  assets?: Map<string, Uint8Array>;
}

function formatIssues(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "card";
    return `${path}: ${issue.message}`;
  });
}

function previewText(value: string, maximumCharacters = 500): string {
  const characters = Array.from(value);
  if (characters.length <= maximumCharacters) {
    return value;
  }
  return `${characters.slice(0, maximumCharacters).join("")}…`;
}

function unknownFields(card: CharacterCard): string[] {
  const paths = Object.keys(card)
    .filter((key) => !rootFields.has(key))
    .map((key) => key);
  const knownDataFields =
    card.spec === "chara_card_v3" ? v3DataFields : commonDataFields;

  for (const key of Object.keys(card.data)) {
    if (!knownDataFields.has(key)) {
      paths.push(`data.${key}`);
    }
  }

  return paths.sort();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const placementNames = new Map<number, string>([
  [0, "markdown_display"],
  [1, "user_input"],
  [2, "ai_output"],
  [3, "slash_command"],
  [5, "world_info"],
  [6, "reasoning"],
]);

function regexPlacement(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return placementNames.get(value) ?? `unknown:${value}`;
  }
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}

function regexScriptPreviews(
  extensions: Record<string, unknown>,
): RegexScriptPreview[] {
  const scripts = extensions.regex_scripts;
  if (!Array.isArray(scripts)) {
    return [];
  }

  return scripts.map((value, index) => {
    const script = asRecord(value) ?? {};
    const placements = Array.isArray(script.placement)
      ? script.placement.map(regexPlacement)
      : [];
    return {
      index,
      name: stringValue(script.scriptName) || `Regex ${index + 1}`,
      findRegexPreview: previewText(stringValue(script.findRegex), 240),
      replaceStringPreview: previewText(stringValue(script.replaceString), 160),
      placements,
      sourceDisabled: booleanValue(script.disabled),
      markdownOnly: booleanValue(script.markdownOnly),
      promptOnly: booleanValue(script.promptOnly),
      runOnEdit: booleanValue(script.runOnEdit),
      minDepth: nullableNumber(script.minDepth),
      maxDepth: nullableNumber(script.maxDepth),
      runtimeState: "stored_disabled" as const,
    };
  });
}

function lorebookEntryPreviews(card: CharacterCard): LorebookEntryPreview[] {
  const entries = card.data.character_book?.entries ?? [];
  return entries.map((entry, index) => ({
    index,
    name:
      entry.name?.trim() ||
      entry.comment?.trim() ||
      (entry.id === undefined ? `Entry ${index + 1}` : String(entry.id)),
    keys: [...entry.keys],
    secondaryKeys: [...(entry.secondary_keys ?? [])],
    contentPreview: previewText(entry.content, 240),
    sourceEnabled: entry.enabled,
    constant: entry.constant ?? false,
    selective: entry.selective ?? false,
    useRegex:
      card.spec === "chara_card_v3"
        ? booleanValue(
            (entry as { use_regex?: unknown }).use_regex,
          )
        : false,
    insertionOrder: entry.insertion_order,
    runtimeState: "stored_inactive" as const,
  }));
}

/**
 * 从已校验的卡中解析完整世界书条目（FR-LORE-002）。
 * 卡内条目保留在 rawExtensions/rawCard 中；这里把运行时需要的字段
 * 规范化成 CharacterLorebookEntry，默认全部停用（与 SillyTavern 一致，
 * 需要用户逐条授权后才注入提示词）。
 */
export function parseCharacterLorebookEntries(
  card: CharacterCard,
): CharacterLorebookEntry[] {
  const entries = card.data.character_book?.entries ?? [];
  return entries.map((entry, index) => {
    const name =
      entry.name?.trim() ||
      entry.comment?.trim() ||
      (entry.id === undefined ? `条目 ${index + 1}` : String(entry.id));
    return {
      index,
      name,
      keys: [...entry.keys],
      secondaryKeys: [...(entry.secondary_keys ?? [])],
      content: entry.content,
      // 导入默认停用：运行时启用状态与卡片自带的 enabled 分离。
      enabled: false,
      constant: entry.constant ?? false,
      caseSensitive: entry.case_sensitive ?? false,
      selective: entry.selective ?? false,
      insertionOrder: entry.insertion_order,
      sourceEnabled: entry.enabled,
      worldInfo: {
        ...entry.extensions,
        uid: entry.id ?? index,
        position: entry.extensions.position ?? (entry.position === "before_char" ? 0 : 1),
        caseSensitive: entry.extensions.case_sensitive ?? entry.case_sensitive ?? null,
        matchWholeWords: entry.extensions.match_whole_words ?? null,
        scanDepth: entry.extensions.scan_depth ?? null,
        ignoreBudget: entry.extensions.ignore_budget ?? false,
        excludeRecursion: entry.extensions.exclude_recursion ?? false,
        preventRecursion: entry.extensions.prevent_recursion ?? false,
        delayUntilRecursion: entry.extensions.delay_until_recursion ?? 0,
        outletName: entry.extensions.outlet_name ?? "",
      },
    };
  });
}

function compatibilityDefaultPaths(card: CharacterCard): string[] {
  const paths: string[] = [];
  if (card.spec === "chara_card_v3" && card.data.group_only_greetings === undefined) {
    paths.push("data.group_only_greetings");
  }
  const book = card.data.character_book;
  if (book && book.extensions === undefined) {
    paths.push("data.character_book.extensions");
  }
  if (card.spec === "chara_card_v3" && book) {
    book.entries.forEach((entry, index) => {
      if (entry.use_regex === undefined) {
        paths.push(`data.character_book.entries.${index}.use_regex`);
      }
    });
  }
  return paths;
}

// 前端卡识别约定与渲染层 frontend-card.ts 保持一致：整条消息是代码围栏、且内容具备
// HTML 文档特征时视为卡片界面；其中出现 <script> 即视为携带可执行脚本。
const CARD_DOCUMENT_MARKERS = ["html>", "<head>", "<body"] as const;
const WHOLE_MESSAGE_FENCE = /^\s*```[^\n]*\r?\n([\s\S]*?)\r?\n?```\s*$/;

/** 一条开场白是否是一份带脚本的前端卡文档。 */
function greetingCarriesScript(content: string): boolean {
  const fenced = WHOLE_MESSAGE_FENCE.exec(content);
  const body = (fenced ? fenced[1]! : content).trim();
  if (!body) return false;
  const markers = CARD_DOCUMENT_MARKERS.filter(marker => body.includes(marker)).length;
  if (fenced ? markers === 0 : markers < 2) return false;
  return /<script[\s>]/i.test(body);
}

/**
 * 卡片是否携带可执行脚本：前端卡开场白里的 <script>，或 tavern_helper 脚本库
 * （数据形态的脚本条目，由宿主作为 ES module 执行）。预览响应携带该标记，
 * 导入界面据此要求用户显式确认信任卡片来源（spec §5.10：卡脚本是可信的高权限代码）。
 */
function cardCarriesScripts(data: {
  first_mes: string;
  alternate_greetings: string[];
  extensions: Record<string, unknown>;
}): boolean {
  if (greetingCarriesScript(data.first_mes)) return true;
  if (data.alternate_greetings.some(greetingCarriesScript)) return true;
  const helper = data.extensions.tavern_helper;
  if (helper === null || typeof helper !== "object" || Array.isArray(helper)) return false;
  const scripts = (helper as Record<string, unknown>).scripts;
  if (!Array.isArray(scripts)) return false;
  return scripts.some(entry => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
    const content = (entry as Record<string, unknown>).content;
    return typeof content === "string" && content.trim().length > 0;
  });
}

export function parseCharacterCardDocument(input: unknown): ParsedCharacterCard {
  const legacy = convertLegacyCharacterCard(input);
  if (legacy) {
    const result = parseCharacterCardDocument(legacy.card);
    result.preview.format = legacy.format;
    result.preview.warningCodes.push("legacy_format_converted");
    return result;
  }
  const envelope = envelopeSchema.safeParse(input);
  if (!envelope.success) {
    throw new CharacterCardParseError(
      "The file is not a Character Card V2 or V3 object.",
      formatIssues(envelope.error),
    );
  }

  const parsed =
    envelope.data.spec === "chara_card_v2"
      ? characterCardV2Schema.safeParse(input)
      : envelope.data.spec === "chara_card_v3"
        ? characterCardV3Schema.safeParse(input)
        : null;

  if (!parsed) {
    throw new CharacterCardParseError(
      `Unsupported character card spec: ${envelope.data.spec}`,
      ["spec: expected chara_card_v2 or chara_card_v3"],
    );
  }

  if (!parsed.success) {
    throw new CharacterCardParseError(
      "The character card does not match its declared specification.",
      formatIssues(parsed.error),
    );
  }

  const card = parsed.data;
  const paths = unknownFields(card);
  const extensionKeys = Object.keys(card.data.extensions).sort();
  const lorebookEntries = lorebookEntryPreviews(card);
  const regexScripts = regexScriptPreviews(card.data.extensions);
  const warnings = new Set<CharacterCardPreviewWarningCode>();
  const defaultedPaths = compatibilityDefaultPaths(card);

  if (paths.length > 0) {
    warnings.add("unknown_fields_preserved");
  }
  if (extensionKeys.length > 0) {
    warnings.add("extensions_present");
  }
  if (lorebookEntries.length > 0) {
    warnings.add("lorebook_stored_inactive");
  }
  if (regexScripts.length > 0) {
    warnings.add("regex_scripts_stored_disabled");
  }
  if (defaultedPaths.length > 0) {
    warnings.add("compatibility_defaults_applied");
  }

  const isV3 = card.spec === "chara_card_v3";
  const assets = isV3 ? (card.data.assets ?? []) : [];
  const groupOnlyGreetings = isV3
    ? (card.data.group_only_greetings ?? [])
    : [];

  if (assets.length > 0) {
    warnings.add("v3_assets_not_imported");
  }
  if (groupOnlyGreetings.length > 0) {
    warnings.add("group_greetings_not_supported");
  }

  return {
    card,
    preview: {
      format: isV3 ? "ccv3-json" : "ccv2-json",
      specVersion: card.spec_version,
      name: card.data.name,
      descriptionPreview: previewText(card.data.description),
      firstMessagePreview: previewText(card.data.first_mes),
      creator: card.data.creator,
      characterVersion: card.data.character_version,
      tags: [...card.data.tags],
      alternateGreetingsCount: card.data.alternate_greetings.length,
      groupOnlyGreetingsCount: groupOnlyGreetings.length,
      lorebookEntryCount: lorebookEntries.length,
      regexScriptCount: regexScripts.length,
      lorebookEntries,
      regexScripts,
      assetCount: assets.length,
      extensionKeys,
      unknownFieldPaths: paths,
      compatibilityDefaultPaths: defaultedPaths,
      warningCodes: [...warnings],
      containsScripts: cardCarriesScripts(card.data),
    },
  };
}

export function parseCharacterCard(input: unknown): CharacterCardPreviewResponse {
  return parseCharacterCardDocument(input).preview;
}
