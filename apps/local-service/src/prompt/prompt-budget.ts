import type { ChatMessage, LorebookEntryResult, TokenAccounting } from "@mycompanion/shared";

/**
 * 提示词预算的共享类型与常量。
 *
 * 实际的预算裁剪由 managed-prompt-assembly.ts 的逐候选准入实现（model-client.ts 是唯一
 * 调用方）；被裁剪内容的诊断随 SSE prompt_budget 事件下发，供高级模式查看。
 */

/** 回复上限之外再预留的 token 数（安全余量）。 */
export const CONTEXT_RESERVE_TOKENS = 512;

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
  tokenAccounting?: TokenAccounting;
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
