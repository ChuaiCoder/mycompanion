import {
  type MemoryRecord,
  type MemoryRetrievalReport,
  type MemoryRetrievalResult,
} from "@mycompanion/shared";

import { estimateTokens } from "./worldbook-engine.js";

/**
 * 长期记忆检索引擎（FR-MEM-005/008）。
 *
 * - 无 Embedding 模型，采用关键词检索降级方案：
 *   得分 = 关键词命中（记忆内容在扫描文本中出现，按记忆字符权重归一）
 *         + 重要度 + 近期使用加成；
 *   固定（pinned）记忆拥有独立预算，不要求关键词命中。
 * - 状态过滤：只有 active 参与自动注入；pending（低置信度冲突）、superseded、
 *   disabled、orphaned 不注入但在报告中给出原因（FR-MEM-004/008）。
 * - 检索结果保存本轮得分与最终是否注入，供诊断查看（FR-MEM-005）。
 */

/** 记忆块的 Token 预算（与 FR-PROMPT-003 的全局预算叠加；全局预算会进一步裁剪）。 */
export const MEMORY_TOKEN_BUDGET = 300;
export const PINNED_MEMORY_TOKEN_BUDGET = 300;
/** 单轮注入的记忆条数上限。 */
export const MEMORY_MAX_INJECTED = 12;
/** 命中判定：记忆内容中出现的最短连续片段（用于粗匹配）。 */
const MATCH_GRANULARITY = 2;

function normalize(text: string): string {
  return text.toLocaleLowerCase();
}

/** 记忆内容的关键词片段：按 2 字滑动窗口切分（覆盖 CJK 与英文混合内容）。 */
function fragments(content: string): string[] {
  const lowered = normalize(content);
  const parts: string[] = [];
  // 连续字母/数字串整体作为一个片段，避免把英文单词切碎。
  const words = lowered.match(/[a-z0-9_]{3,}/g) ?? [];
  parts.push(...words);
  // CJK 片段：2 字窗口。
  const cjk = lowered.match(/\p{Script=Han}+/gu) ?? [];
  for (const run of cjk) {
    if (run.length === 1) parts.push(run);
    for (let index = 0; index + MATCH_GRANULARITY <= run.length; index += 1) {
      parts.push(run.slice(index, index + MATCH_GRANULARITY));
    }
  }
  return [...new Set(parts)];
}

/** Shared by SQLite and the native Tavern adapter when replacing older memories. */
export function memorySimilarity(a: string, b: string): number {
  const setA = new Set(fragments(a));
  const setB = new Set(fragments(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let common = 0;
  for (const fragment of setA) if (setB.has(fragment)) common++;
  return common / Math.max(setA.size, setB.size);
}

/** 单条记忆的关键词得分（0..1）：命中片段数 / 片段总数。 */
interface KeywordQuery {
  text: string;
  words: Set<string>;
}

function keywordScore(memory: MemoryRecord, query: KeywordQuery): { score: number; matched: string[] } {
  const parts = fragments(memory.content);
  if (parts.length === 0) return { score: 0, matched: [] };
  const matched = parts.filter(part => /^[a-z0-9_]+$/.test(part) ? query.words.has(part) : query.text.includes(part));
  return { score: matched.length / parts.length, matched };
}

export interface MemoryRetrievalInput {
  conversationId: string;
  memories: MemoryRecord[];
  scanText: string;
  model?: string;
  now?: Date;
}

/**
 * 对本轮上下文检索记忆（FR-MEM-005）。
 * 纯函数：不修改记忆，调用方决定把 block 放进提示词的哪个位置。
 */
export function retrieveMemories(input: MemoryRetrievalInput): MemoryRetrievalReport {
  const start = Date.now();
  const results: MemoryRetrievalResult[] = [];
  const text = normalize(input.scanText);
  const query: KeywordQuery = { text, words: new Set(text.match(/[a-z0-9_]+/g) ?? []) };
  const now = (input.now ?? new Date()).getTime();

  for (const memory of input.memories) {
    const base: MemoryRetrievalResult = {
      memoryId: memory.id,
      type: memory.type,
      scope: memory.scope,
      score: 0,
      injected: false,
      pinned: memory.pinned,
      content: "",
      tokens: 0,
      diagnostics: [],
    };
    // FR-MEM-008：来源全部不可达的记忆不自动注入。
    if (memory.status === "orphaned") {
      base.diagnostics.push("来源消息不再可达（分支回滚），暂停注入；回到原分支可恢复。");
      results.push(base);
      continue;
    }
    if (memory.status === "superseded") {
      base.diagnostics.push("已被新记忆取代，保留历史不再注入。");
      results.push(base);
      continue;
    }
    if (memory.status === "disabled") {
      base.diagnostics.push("已停用。");
      results.push(base);
      continue;
    }
    if (memory.status === "pending") {
      base.diagnostics.push("待确认记录，不自动注入（FR-MEM-004）。");
      if (memory.reconciliation?.reason) base.diagnostics.push(memory.reconciliation.reason);
      results.push(base);
      continue;
    }

    const { score, matched } = keywordScore(memory, query);
    base.score = Math.round(score * 100) / 100;
    if (score <= 0 && !memory.pinned) {
      base.diagnostics.push("本轮上下文未命中记忆内容。");
      results.push(base);
      continue;
    }
    // 得分 + 重要度加成：重要度 5 的记忆更容易进入预算。
    const recent = memory.lastUsedAt ? 0.08 * Math.exp(-Math.max(0, now - Date.parse(memory.lastUsedAt)) / (7 * 86_400_000)) : 0;
    base.score = Math.round((score + memory.importance * 0.02 + recent) * 100) / 100;
    if (matched.length) base.diagnostics.push(`关键词命中：${matched.slice(0, 8).join("、")}；相关度 ${Math.round(score * 100)}%。`);
    else base.diagnostics.push("用户固定记忆：无需关键词命中，使用独立预算。");
    base.content = memory.content;
    base.tokens = estimateTokens(memory.content, input.model);
    results.push(base);
  }

  const matched = results.filter((result) => result.content && result.score > 0);
  // 固定记忆独立预算：优先按重要度保留（FR-MEM-005）。
  const pinned = matched
    .filter((result) => result.pinned)
    .sort((a, b) => b.score - a.score);
  const rest = matched
    .filter((result) => !result.pinned)
    .sort((a, b) => b.score - a.score);

  const kept = [...pinned, ...rest];
  let injectedCount = 0;
  for (const group of [pinned, rest]) {
    const allowance = group === pinned ? PINNED_MEMORY_TOKEN_BUDGET : MEMORY_TOKEN_BUDGET;
    let remaining = allowance;
    let groupCount = 0;
    for (const result of group) {
      if (groupCount >= MEMORY_MAX_INJECTED) {
        result.diagnostics.push("超过单轮注入条数上限。");
        continue;
      }
      if (remaining - result.tokens >= 0) {
        result.injected = true;
        remaining -= result.tokens;
        injectedCount += 1;
        groupCount += 1;
        if (result.pinned) result.diagnostics.push("固定记忆独立预算注入。");
      } else {
        result.diagnostics.push(`超出 ${allowance} token ${group === pinned ? "固定" : "检索"}记忆预算被舍弃（约 ${result.tokens} token）。`);
      }
    }
  }

  const block = kept
    .filter((result) => result.injected)
    .map((result) => result.content)
    .join("\n\n");

  return {
    conversationId: input.conversationId,
    results,
    block,
    position: "before_recent_messages",
    budgetTokens: MEMORY_TOKEN_BUDGET + PINNED_MEMORY_TOKEN_BUDGET,
    pinnedBudgetTokens: PINNED_MEMORY_TOKEN_BUDGET,
    injectedCount,
    durationMs: Date.now() - start,
  };
}

/** Keep diagnostics, last-used bookkeeping and the bytes sent in agreement. */
export function reconcileMemoryReport(report: MemoryRetrievalReport, retainedIds: string[]): void {
  const kept = new Set(retainedIds);
  for (const result of report.results) {
    if (result.injected && !kept.has(result.memoryId)) {
      result.injected = false;
      result.diagnostics.push("最终提示词预算裁剪，未发送到模型。");
    }
  }
  report.injectedCount = report.results.filter(result => result.injected).length;
  report.block = report.results.filter(result => result.injected).sort((a,b) => Number(b.pinned ?? false) - Number(a.pinned ?? false) || b.score - a.score)
    .map(result => result.content).join("\n\n");
}
