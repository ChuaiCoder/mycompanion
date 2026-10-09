import type { TokenAccounting } from "@mycompanion/shared";

import { zhKeyedMessages } from "./i18n-zh-messages";

const tokenReasons: Record<TokenAccounting["reasons"][number], readonly [string, string]> = {
  "message-framing": ["消息框架和角色标记为估算，提供商可能采用不同的计算方式。", "Message framing and role markers are estimated; your provider may count them differently."],
  "unknown-model": ["模型的分词规则未知，文本使用兼容估算。", "This model's tokenizer is unknown; text uses a compatibility estimate."],
  "unsupported-text-encoding": ["此文本分词方式尚未支持，使用兼容估算。", "This text encoding is not supported; a compatibility estimate is used."],
  "image-rule-estimate": ["图片按兼容规则估算，实际值由提供商决定。", "Images use a compatibility estimate; the provider determines the actual count."],
  "unknown-image-size": ["部分图片尺寸未知，图片计数不完整。", "Some image dimensions are unknown; image counts are incomplete."],
  "unknown-image-model": ["此模型的图片计数规则未知。", "This model's image counting rules are unknown."],
  "audio-not-counted": ["音频尚未计入本地估算。", "Audio is not included in the local estimate."],
  "unsupported-content-part": ["部分内容类型尚未计入本地估算。", "Some content types are not included in the local estimate."],
  "tool-schema-estimate": ["工具定义按兼容规则估算。", "Tool definitions use a compatibility estimate."],
  "response-format-estimate": ["响应格式定义按兼容规则估算。", "Response format definitions use a compatibility estimate."],
};
export const tokenReasonText = (reason: TokenAccounting["reasons"][number], language: string) => tokenReasons[reason][language.startsWith("en") ? 1 : 0];

/**
 * 记忆中心的界面文案。静态文案已并入 i18n 的 messages 表
 * （i18n-zh-messages.ts，中文原文即 key）；本函数只剩 en 侧的动态诊断模板。
 * Translate only known application diagnostics; preserve user/model prose.
 */
export function memoryText(language: string, value: string): string {
  if (!language.startsWith("en")) return value;
  const translated = zhKeyedMessages[value]?.[1];
  if (translated !== undefined) return translated;
  let match = /^关键词与语义联合检索；(\d+)\/(\d+) 条普通记忆已索引(；语义查询使用末尾 8,000 字符)?。$/.exec(value);
  if (match) return `Keywords and semantic retrieval; ${match[1]}/${match[2]} ordinary memories indexed${match[3] ? "; the semantic query uses the last 8,000 characters" : ""}.`;
  match = /^关键词命中：(.+)；相关度 (\d+)%。$/.exec(value);
  if (match) return `Matched keywords: ${match[1]}; relevance ${match[2]}%.`;
  match = /^语义匹配：余弦相似度 ([\d.-]+)；关键词未命中。$/.exec(value);
  if (match) return `Semantic match: cosine similarity ${match[1]}; no keyword match.`;
  match = /^超出 (\d+) token (固定|检索)记忆预算被舍弃（约 (\d+) token）。$/.exec(value);
  if (match) return `Excluded from the ${match[2] === "固定" ? "pinned" : "retrieved"} memory budget of ${match[1]} tokens (approximately ${match[3]} tokens).`;
  return value;
}
