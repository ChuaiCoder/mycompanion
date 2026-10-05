import {
  memoryRecordSchema,
  memoryClaimSchema,
  type CharacterDetail,
  type ChatMessage,
  type MemoryRecord,
  type ProviderSettings,
} from "@mycompanion/shared";
import { isCompleteSourceQuote, quoteDirectlyNamesClaim, quoteProvesTransition } from "./memory-conflict-core.js";

import { completeText } from "./model-client.js";

/**
 * 长期记忆的自动提取与阶段摘要（FR-MEM-002/006）。
 *
 * 提取只从“完成且仍位于当前分支”的消息中取最近一轮（用户 + 助手）做增量提取；
 * 模型输出按 JSON 数组结构校验（zod），无法解析时整批丢弃，不保存半成品。
 * 摘要失败不得阻止正常聊天——所有调用都在主生成流程之外，错误由调用方吞掉。
 */

interface ExtractedMemory {
  type?: unknown;
  content?: unknown;
  importance?: unknown;
  claim?: unknown;
}

const EXTRACT_SYSTEM = [
  "你是角色扮演的记忆助手。阅读最近一轮对话，提取值得长期记住的信息。",
  "只输出 JSON 数组，元素为 {\"type\":\"fact|state|goal|relationship\",\"content\":\"一句话中文摘要\",\"importance\":1-5 整数}。",
  "每条只描述一个事实。原文能够明确确认主体、属性和值时，可加 claim:{subject,predicate,value,temporality}；temporality 为 stable（稳定事实）、current（当前状态）或 event（某次事件）。不能确定时省略 claim，不要猜测同义词或因果。",
  "只有原文明确说同一属性从旧值变成新值时，claim 可加 transition:{from,sourceRole:\"user|assistant\",quote}。quote 必须完整复制原句，包含主体、属性、旧值、新值及变化词；假设、否定、传闻和计划不算已经变化。不得生成不存在的引文。",
  "没有值得记忆的信息时输出 []。不要输出 JSON 以外的任何文字。",
].join("\n");

const SUMMARY_SYSTEM = [
  "你是角色扮演的剧情摘要助手。阅读较早的对话，写一段简短中文摘要（不超过 300 字），",
  "保留地点、时间线、关系、物品与进行中目标。不要输出摘要以外的任何文字。",
].join("\n");

/**
 * 从最近一轮已完成对话中提取记忆（FR-MEM-002）。
 * 返回结构校验后的新记忆（尚未写库）；提取失败返回空数组。
 */
export async function extractMemories(options: {
  complete?: typeof completeText;
  settings: ProviderSettings;
  apiKey?: string;
  character: CharacterDetail;
  conversationId: string;
  /** 最近一轮：用户消息 + 助手消息，均须 complete。 */
  pair: [user: ChatMessage, assistant: ChatMessage];
  /** 已提取过的来源消息 ID：用于去重，避免同一轮重复提取。 */
  alreadyExtractedSourceIds: Set<string>;
}): Promise<MemoryRecord[]> {
  if (options.alreadyExtractedSourceIds.has(options.pair[0].id)) return [];
  const transcript = [
    `玩家（user）：${options.pair[0].content}`,
    `${options.character.name}（assistant）：${options.pair[1].content}`,
  ].join("\n");

  let raw: string;
  try {
    raw = await (options.complete ?? completeText)({
      settings: options.settings,
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      messages: [
        { role: "system", content: EXTRACT_SYSTEM },
        { role: "user", content: `最近对话：\n${transcript}` },
      ],
    });
  } catch {
    // 提取失败不影响聊天主流程。
    return [];
  }

  const parsed = parseJsonArray(raw);
  if (!parsed) return [];
  const records: MemoryRecord[] = [];
  const now = new Date().toISOString();
  for (const item of parsed.slice(0, 8)) {
    const claim = validatedClaim(item.claim, options.pair);
    const record = memoryRecordSchema.safeParse({
      id: crypto.randomUUID(),
      conversationId: options.conversationId,
      characterId: options.character.id,
      type: item.type,
      content: item.content,
      scope: "story",
      importance: item.importance,
      status: "active",
      pinned: false,
      manuallyEdited: false,
      ...(claim ? { claim } : {}),
      sourceMessageIds: [options.pair[0].id, options.pair[1].id],
      supersededBy: null,
      previousContent: null,
      createdAt: now,
      lastUsedAt: null,
    });
    if (record.success) records.push(record.data);
  }
  return records;
}

/** Claims can inform pending classification; only a checked source quote carries transition authority. */
function validatedClaim(raw: unknown, pair: [ChatMessage, ChatMessage]) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const item = raw as Record<string, unknown>;
  const parsed = memoryClaimSchema.safeParse({ ...item, transition: undefined });
  if (!parsed.success) return undefined;
  const claim = parsed.data;
  const transition = item.transition;
  if (typeof transition !== "object" || transition === null || Array.isArray(transition)) return claim;
  const change = transition as Record<string, unknown>;
  const source = pair.find(message => message.role === change.sourceRole);
  if (!source || typeof change.quote !== "string" || typeof change.from !== "string"
    || !isCompleteSourceQuote(source.content, change.quote) || !quoteDirectlyNamesClaim(change.quote, claim, source.role)
    || !quoteProvesTransition(change.quote, change.from, claim.value)) return claim;
  const checked = memoryClaimSchema.safeParse({ ...claim, transition: {
    from: change.from, sourceMessageId: source.id, quote: change.quote,
  } });
  return checked.success ? checked.data : claim;
}

/**
 * 生成增量阶段摘要（FR-MEM-006）：压缩即将退出近期窗口的较早剧情。
 * 摘要失败返回 undefined，调用方保留旧摘要并继续聊天。
 */
export async function summarizeMessages(options: {
  complete?: typeof completeText;
  settings: ProviderSettings;
  apiKey?: string;
  character: CharacterDetail;
  /** 要摘要的较早消息（按时间正序）。 */
  messages: ChatMessage[];
  existingSummary?: string;
}): Promise<{ content: string; coveredMessageCount: number } | undefined> {
  if (options.messages.length < 2) return undefined;
  const transcript = options.messages
    .map((message) => `${message.role === "user" ? "玩家" : options.character.name}：${message.content}`)
    .join("\n");
  let content: string;
  try {
    content = await (options.complete ?? completeText)({
      settings: options.settings,
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      messages: [
        { role: "system", content: SUMMARY_SYSTEM },
        {
          role: "user",
          content: options.existingSummary
            ? `已有摘要：${options.existingSummary}\n\n新增对话：\n${transcript}`
            : `较早对话：\n${transcript}`,
        },
      ],
    });
  } catch {
    return undefined;
  }
  if (!content.trim()) return undefined;
  return { content: content.trim().slice(0, 2_000), coveredMessageCount: options.messages.length };
}

/** 提取模型输出里的 JSON 数组（容忍 ```json 围栏与前后杂文）。 */
function parseJsonArray(raw: string): Array<ExtractedMemory> | undefined {
  const text = raw.trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return Array.isArray(parsed) ? (parsed as Array<ExtractedMemory>) : undefined;
  } catch {
    return undefined;
  }
}
