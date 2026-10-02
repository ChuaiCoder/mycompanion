import type { ChatMessage, CharacterDetail, LorebookReport, LorebookEntryResult, ProviderSettings } from "@mycompanion/shared";

import { estimateTokens } from "./worldbook-engine.js";

/**
 * 全局 Token 预算（FR-PROMPT-003）。
 *
 * 系统提示词区域按 FR-PROMPT-002 的逻辑顺序组装：
 * 1 产品安全约束（调用方固定附加，不裁剪）→ 2 角色核心 → 3 世界书（常驻优先）
 * → 插件注入 → Post-History Instructions；消息区固定保留当前用户输入与
 * 若干条最近的原始对话，更早的历史不发送（数据库与 UI 中完整保留）。
 *
 * 超限时按 FR-PROMPT-003 的顺序裁剪：
 *   非固定世界书条目（insertion_order 从低到高）→ 较旧的近期消息。
 * 被裁剪的内容必须出现在 PromptBudgetReport.diagnostics 中，
 * 并随 SSE prompt_budget 事件下发供高级模式查看。
 */

/** 回复上限之外再预留的 token 数（安全余量）。 */
export const CONTEXT_RESERVE_TOKENS = 512;
/** 预算允许保留的最近原始对话条数上限（与模型上下文的 80 条窗口一致）。 */
export const MAX_RECENT_MESSAGES = 80;

export interface PromptBudgetRegion {
  key:
    | "character_core"
    | "example_dialogue"
    | "worldbook_constant"
    | "worldbook"
    | "memory"
    | "memory_pinned"
    | "stage_summary"
    | "plugins"
    | "extension_prompts"
    | "post_history";
  label: string;
  content: string;
  tokens: number;
}

/** 参与预算裁剪的检索记忆（FR-MEM-005 / FR-PROMPT-003：低相关度先被丢弃）。 */
export interface BudgetMemoryItem {
  id: string;
  content: string;
  tokens: number;
  score: number;
  pinned?: boolean;
}

export interface PromptBudgetReport {
  contextLimitTokens: number;
  /** 回复上限 + 安全余量。 */
  reserveTokens: number;
  /** 可用于系统提示词区域与近期消息的预算。 */
  availableTokens: number;
  regions: PromptBudgetRegion[];
  recentMessages: ChatMessage[];
  /** 被裁剪内容的诊断（FR-PROMPT-003 要求可见）。 */
  diagnostics: string[];
  /** 最终估算总 token（区域 + 近期消息 + 预留）。 */
  totalTokens: number;
  worldbookEntries: LorebookEntryResult[];
  retainedMemoryIds?: string[];
  memoryItems?: BudgetMemoryItem[];
}

export interface PromptBudgetInput {
  extensionPromptText?: string;
  settings: Pick<ProviderSettings, "contextLimitTokens" | "maxTokens"> & Partial<Pick<ProviderSettings, "model">>;
  character: CharacterDetail;
  /** 插件系统提示词贡献（权限与注入规则由调用方保证，与 model-client 一致）。 */
  pluginBlocks: Array<{ name: string; content: string }>;
  lorebook: LorebookReport;
  /** 本轮检索命中的记忆（含得分），按 FR-PROMPT-003 优先于世界书与旧消息被裁剪。 */
  memoryItems: BudgetMemoryItem[];
  /** 阶段摘要文本（FR-MEM-006），为空则不插入该区域。 */
  stageSummary?: string;
  /** 按时间正序的历史（已应用 prompt 阶段改写）。 */
  history: ChatMessage[];
}

interface TrimmableEntry {
  index: number;
  name: string;
  insertionOrder: number;
  content: string;
  tokens: number;
}

/**
 * 从历史中选出预算内可发送的近期对话：
 * 最近一条用户消息（当前输入）无条件保留，其余按从新到旧纳入，
 * 直到超出预算或达到条数上限。
 */
export function selectRecentMessages(history: ChatMessage[], budgetTokens: number, model = ""): ChatMessage[] {
  const eligible = history.filter(
    (message) => (message.status === "complete" || message.status === "stopped")
      && message.content.trim().length > 0 && message.extensionData?.is_system !== true,
  );
  // 当前用户输入 = 最后一条用户消息，必须保留，不参与预算裁剪。
  let lastUserIndex = -1;
  for (let index = eligible.length - 1; index >= 0; index -= 1) {
    if (eligible[index]?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  if (lastUserIndex < 0) return [];
  const current = eligible[lastUserIndex];
  if (!current) return [];
  const kept: ChatMessage[] = [current];
  let used = estimateTokens(current.content, model);
  // 当前用户输入之后的消息（如重新生成场景中的旧回复）按预算顺序纳入。
  for (let index = lastUserIndex + 1; index < eligible.length; index += 1) {
    const message = eligible[index];
    if (!message) continue;
    if (kept.length >= MAX_RECENT_MESSAGES) break;
    const tokens = estimateTokens(message.content, model);
    if (used + tokens > budgetTokens) break;
    kept.push(message);
    used += tokens;
  }
  // 更早的消息从新到旧纳入，直到超出预算或达到条数上限。
  for (let index = lastUserIndex - 1; index >= 0; index -= 1) {
    const message = eligible[index];
    if (!message) continue;
    if (kept.length >= MAX_RECENT_MESSAGES) break;
    const tokens = estimateTokens(message.content, model);
    if (used + tokens > budgetTokens) break;
    kept.unshift(message);
    used += tokens;
  }
  return kept;
}

function makeRegion(
  key: PromptBudgetRegion["key"],
  label: string,
  content: string,
  model = "",
): PromptBudgetRegion | undefined {
  if (!content.trim()) return undefined;
  return { key, label, content, tokens: estimateTokens(content, model) };
}

/**
 * 计算一次生成的提示词预算（FR-PROMPT-003）。
 * 纯函数：输入各区域文本与历史，输出区域内容、可发送的近期消息和被裁剪诊断。
 */
export function applyPromptBudget(input: PromptBudgetInput): PromptBudgetReport {
  const count = (text: string): number => estimateTokens(text, input.settings.model);
  const make = (key: PromptBudgetRegion["key"], label: string, content: string) => makeRegion(key, label, content, input.settings.model);
  const contextLimit = input.settings.contextLimitTokens;
  const reserveTokens = Math.min(input.settings.maxTokens, contextLimit) + CONTEXT_RESERVE_TOKENS;
  const availableTokens = Math.max(contextLimit - reserveTokens, 0);
  const diagnostics: string[] = [];

  const characterCore = [
    `Character name: ${input.character.name}`,
    input.character.description ? `Description:\n${input.character.description}` : "",
    input.character.personality ? `Personality:\n${input.character.personality}` : "",
    input.character.scenario ? `Scenario:\n${input.character.scenario}` : "",
  ].filter(Boolean).join("\n\n");

  const regions: PromptBudgetRegion[] = [];
  const push = (candidate: PromptBudgetRegion | undefined): void => {
    if (candidate) regions.push(candidate);
  };

  // 2) 角色核心：必须保留，不参与裁剪。
  push(make("character_core", "角色核心", characterCore));
  push(make("example_dialogue", "示例对话", input.character.exampleDialogue ? `Example dialogue:\n${input.character.exampleDialogue}` : ""));
  // Already admitted by the world-info budget; protect constants in the outer budget.
  push(make("worldbook_constant", "世界书·常驻", input.lorebook.constantBlock
    ? `World book (constant):\n${input.lorebook.constantBlock}`
    : ""));
  // 3') 世界书关键词触发条目的插入点（在常驻之后、记忆之前，FR-PROMPT-002）。
  const worldbookInsertAt = regions.length;
  // 4) 检索记忆的插入点。
  const memoryInsertAt = regions.length;
  // 5) 阶段摘要：压缩较早剧情，固定保留（内容上限由摘要约束）。
  push(make("stage_summary", "阶段摘要", input.stageSummary
    ? `Stage summary:\n${input.stageSummary}`
    : ""));
  // 插件注入：声明式贡献，固定保留（内容上限由插件 manifest 约束）。
  if (input.pluginBlocks.length > 0) {
    push(make(
      "plugins",
      "插件注入",
      input.pluginBlocks.map((block) => `[Extension: ${block.name}]\n${block.content}`).join("\n\n"),
    ));
  }
  // Post-History Instructions：固定保留（FR-PROMPT-002 第 8 区，始终最后）。
  push(make("post_history", "Post-History Instructions",
    input.character.postHistoryInstructions
      ? `Post-history instructions:\n${input.character.postHistoryInstructions}`
      : ""));

  push(make("extension_prompts", "扩展临时注入", input.extensionPromptText ?? ""));
  const pinnedMemory = input.memoryItems.filter(item => item.pinned);
  if (pinnedMemory.length) regions.splice(memoryInsertAt, 0, make("memory_pinned", "固定记忆",
    `Pinned memories:\n${pinnedMemory.map(item => item.content).join("\n\n")}`)!);
  const fixedTokens = regions.reduce((sum, item) => sum + item.tokens, 0);
  const keptMemory = input.memoryItems.filter(item => !item.pinned)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  // (b) 关键词触发的世界书条目：insertion_order 从低到高的条目先被丢弃。
  const orderByIdx = new Map(
    input.character.lorebookEnabled.map((entry) => [entry.index, entry.insertionOrder]),
  );
  const worldbookEntries: TrimmableEntry[] = input.lorebook.results
    .filter((result) => result.status === "injected" && result.content.trim().length > 0)
    // 常驻条目已由 constantBlock 区域承载，不重复计入。
    .filter((result) => !(result.constant ?? input.lorebook.constantBlock.split("\n\n").includes(result.content)))
    .map((result) => ({
      index: result.index,
      name: result.name,
      insertionOrder: result.insertionOrder ?? orderByIdx.get(result.index) ?? 0,
      content: result.content,
      tokens: result.tokens,
    }));
  const keptWorldbook = [...worldbookEntries].sort((a, b) => b.insertionOrder - a.insertionOrder || a.index - b.index);
  const memoryContent = () => keptMemory.length ? `Retrieved memories:\n${keptMemory.map(item => item.content).join("\n\n")}` : "";
  const worldContent = () => keptWorldbook.length ? `World book:\n${[...keptWorldbook].sort((a,b) => a.insertionOrder - b.insertionOrder).map(item => item.content).join("\n\n")}` : "";
  const currentUser = [...input.history].reverse().find(message => message.role === "user"
    && message.status === "complete" && message.extensionData?.is_system !== true && message.content.trim());
  const currentTokens = currentUser ? count(currentUser.content) : 0;
  // Charge complete wrapped blocks, not just individual bodies. Protect the
  // current input and fixed memories; trim the least relevant ordinary memory first.
  const fits = () => fixedTokens + count(memoryContent()) + count(worldContent()) + currentTokens <= availableTokens;
  while (!fits() && keptMemory.length) {
    const item = keptMemory.pop()!;
    diagnostics.push(`超出上下文预算，检索记忆（${item.id.slice(0, 8)}…）被裁剪（约 ${item.tokens} token）。`);
  }
  while (!fits() && keptWorldbook.length) {
    const item = keptWorldbook.pop()!;
    diagnostics.push(`超出上下文预算，世界书条目「${item.name}」被裁剪（约 ${item.tokens} token）。`);
  }
  if (keptMemory.length) regions.splice(memoryInsertAt + (pinnedMemory.length ? 1 : 0), 0,
    make("memory", "检索记忆", memoryContent())!);
  if (keptWorldbook.length > 0) {
    regions.splice(worldbookInsertAt, 0, make(
      "worldbook",
      "世界书·关键词触发",
      worldContent(),
    )!);
  }

  // (c) 近期原始对话：较旧的消息先被丢弃；当前用户输入无条件保留。
  const regionTokens = regions.reduce((sum, item) => sum + item.tokens, 0);
  const historyBudget = Math.max(availableTokens - regionTokens, 0);
  const recentMessages = selectRecentMessages(input.history, historyBudget, input.settings.model);
  const allEligible = input.history.filter(
    (message) => (message.status === "complete" || message.status === "stopped")
      && message.content.trim().length > 0,
  );
  if (recentMessages.length < allEligible.length) {
    diagnostics.push(
      `超出上下文预算，丢弃了 ${allEligible.length - recentMessages.length} 条较早消息（数据库与界面中仍完整保留）。`,
    );
  }

  const totalTokens = reserveTokens
    + regionTokens
    + recentMessages.reduce((sum, message) => sum + count(message.content), 0);

  return {
    contextLimitTokens: contextLimit,
    reserveTokens,
    availableTokens,
    regions,
    recentMessages,
    diagnostics,
    totalTokens,
    retainedMemoryIds: [...pinnedMemory, ...keptMemory].map(item => item.id),
    memoryItems: [...pinnedMemory, ...keptMemory],
    worldbookEntries: input.lorebook.results.filter(result => result.status === "injected" &&
      (result.constant === true || keptWorldbook.some(kept => kept.index === result.index)))
      .sort((a, b) => (a.insertionOrder ?? 0) - (b.insertionOrder ?? 0)),
  };
}
