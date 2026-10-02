import { describe, expect, it } from "vitest";

import type { ChatMessage, CharacterDetail, LorebookReport } from "@mycompanion/shared";

import { applyPromptBudget, selectRecentMessages } from "./prompt-budget.js";
import { countTextTokens } from "./tokenizer-service.js";

const NOW = "2026-09-20T00:00:00.000Z";

function character(overrides: Partial<CharacterDetail> = {}): CharacterDetail {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    name: "阿斯特",
    description: "制图师。",
    personality: "好奇。",
    scenario: "工作室。",
    firstMessage: "欢迎。",
    alternateGreetings: [],
    alternateGreetingsCount: 0,
    exampleDialogue: "",
    systemPrompt: "Stay in character.",
    postHistoryInstructions: "Keep replies short.",
    creatorNotes: "",
    tags: [],
    creator: "Test",
    characterVersion: "1.0",
    sourceFormat: "ccv2-json",
    sourceVersion: "2.0",
    rawExtensions: {},
    unknownFieldPaths: [],
    regexEnabled: [],
    lorebookEnabled: [],
    lorebookEntryCount: 0,
    regexScriptCount: 0,
    lorebookEntries: [],
    regexScripts: [],
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function lorebookReport(overrides: Partial<LorebookReport> = {}): LorebookReport {
  return {
    characterId: "00000000-0000-4000-8000-000000000001",
    results: [],
    block: "",
    constantBlock: "",
    position: "after_character_core",
    budgetTokens: 500,
    injectedCount: 0,
    durationMs: 1,
    ...overrides,
  };
}

function message(role: ChatMessage["role"], content: string, index: number): ChatMessage {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    conversationId: "00000000-0000-4000-8000-000000000009",
    branchId: "00000000-0000-4000-8000-000000000009",
    parentMessageId: null,
    role,
    content,
    status: "complete",
    createdAt: NOW,
  };
}

const SETTINGS = { contextLimitTokens: 2_000, maxTokens: 256 };

describe("selectRecentMessages", () => {
  it("always keeps the current user input even when it exceeds the budget", () => {
    const history = [message("user", "A".repeat(1000), 1), message("assistant", "回复", 2)];
    const kept = selectRecentMessages(history, 1);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.role).toBe("user");
  });

  it("drops the oldest messages first when the budget is tight", () => {
    const history = [
      message("user", "第一条旧消息", 1),
      message("assistant", "第一条回复", 2),
      message("user", "第二条旧消息", 3),
      message("assistant", "第二条回复", 4),
      message("user", "当前问题", 5),
    ];
    const kept = selectRecentMessages(history, 12);
    expect(kept.at(-1)?.content).toBe("当前问题");
    expect(kept).not.toContainEqual(history[0]);
    // 较新的消息按原顺序保留。
    expect(kept.map((item) => item.content)).toEqual(
      kept.map((item) => item.content).slice().reverse().reverse(),
    );
  });

  it("skips failed and empty messages", () => {
    const failed = message("assistant", "崩溃了", 2);
    failed.status = "failed";
    const empty = message("user", "  ", 3);
    const history = [message("user", "问题", 1), failed, empty];
    expect(selectRecentMessages(history, 100)).toHaveLength(1);
  });
});

describe("applyPromptBudget", () => {
  it("preserves the higher relevance fact when only one retrieved fact fits", () => {
    const high = "The important map identifies the secret entrance.";
    const low = "An unrelated map shows another entrance on a distant planet.";
    const base = { settings: SETTINGS, character: character(), pluginBlocks: [], lorebook: lorebookReport(),
      memoryItems: [], history: [message("user", "你好", 1)] };
    const fixed = applyPromptBudget(base).regions.reduce((sum, region) => sum + region.tokens, 0);
    const budget = applyPromptBudget({ ...base,
      settings: { contextLimitTokens: 768 + fixed + countTextTokens(`Retrieved memories:\n${high}`) + countTextTokens("你好"), maxTokens: 256 },
      memoryItems: [{ id: "low", content: low, tokens: countTextTokens(low), score: 0.1 },
        { id: "high", content: high, tokens: countTextTokens(high), score: 0.9 }],
    });
    expect(budget.retainedMemoryIds).toEqual(["high"]);
    expect(budget.regions.find(region => region.key === "memory")?.content).toContain(high);
    expect(budget.regions.find(region => region.key === "memory")?.content).not.toContain(low);
  });

  it("keeps fixed memory separate when the ordinary memory region is discarded", () => {
    const pinned = "The protagonist must not eat peanuts.";
    const base = { settings: SETTINGS, character: character(), pluginBlocks: [], lorebook: lorebookReport(),
      memoryItems: [], history: [message("user", "你好", 1)] };
    const fixed = applyPromptBudget(base).regions.reduce((sum, region) => sum + region.tokens, 0);
    const budget = applyPromptBudget({ ...base,
      settings: { contextLimitTokens: 768 + fixed + countTextTokens(`Pinned memories:\n${pinned}`) + countTextTokens("你好"), maxTokens: 256 },
      memoryItems: [{ id: "ordinary", content: "Another unimportant detail.", tokens: 5, score: 1 },
        { id: "fixed", content: pinned, tokens: countTextTokens(pinned), score: 0.1, pinned: true }],
    });
    expect(budget.retainedMemoryIds).toEqual(["fixed"]);
    expect(budget.regions.find(region => region.key === "memory_pinned")?.content).toContain(pinned);
    expect(budget.regions.some(region => region.key === "memory")).toBe(false);
  });
  it("keeps fixed regions in FR-PROMPT-002 order when everything fits", () => {
    const budget = applyPromptBudget({
      settings: SETTINGS,
      character: character(),
      pluginBlocks: [{ name: "demo", content: "Plugin line." }],
      lorebook: lorebookReport({
        constantBlock: "常驻背景。",
        results: [
          {
            index: 0,
            name: "工作室",
            status: "injected",
            matchedKey: "工作室",
            tokens: 5,
            content: "工作室建在废弃天文台内部。",
            diagnostics: [],
          },
        ],
        block: "工作室建在废弃天文台内部。",
      }),
      memoryItems: [],
      history: [message("user", "你好", 1)],
    });
    expect(budget.diagnostics).toHaveLength(0);
    expect(budget.regions.map((region) => region.key)).toEqual(
      ["character_core", "worldbook_constant", "worldbook", "plugins", "post_history"],
    );
    expect(budget.recentMessages).toHaveLength(1);
    expect(budget.totalTokens).toBeLessThan(SETTINGS.contextLimitTokens);
  });

  it("drops the lowest insertion_order worldbook entry first with diagnostics", () => {
    const characterWithEntries = character({
      lorebookEnabled: [
        {
          index: 0,
          name: "低序",
          keys: ["低序"],
          secondaryKeys: [],
          content: "低".repeat(200),
          enabled: true,
          constant: false,
          caseSensitive: false,
          selective: false,
          insertionOrder: 10,
          sourceEnabled: true,
        },
        {
          index: 1,
          name: "高序",
          keys: ["高序"],
          secondaryKeys: [],
          content: "高。",
          enabled: true,
          constant: false,
          caseSensitive: false,
          selective: false,
          insertionOrder: 100,
          sourceEnabled: true,
        },
      ],
    });
    const results = [
      {
        index: 0,
        name: "低序",
        status: "injected" as const,
        matchedKey: "低序",
        tokens: 200,
        content: "低".repeat(200),
        diagnostics: [],
      },
      {
        index: 1,
        name: "高序",
        status: "injected" as const,
        matchedKey: "高序",
        tokens: 2,
        content: "高。",
        diagnostics: [],
      },
    ];
    const budget = applyPromptBudget({
      settings: { contextLimitTokens: 900, maxTokens: 256 },
      character: characterWithEntries,
      pluginBlocks: [],
      lorebook: lorebookReport({ results, block: "高。\n\n" + "低".repeat(200) }),
      memoryItems: [],
      history: [message("user", "你好", 1)],
    });
    const worldbookRegion = budget.regions.find((region) => region.key === "worldbook");
    expect(worldbookRegion?.content).toBe("World book:\n高。");
    expect(budget.diagnostics.join("")).toContain("低序");
  });

  it("keeps constant worldbook content even when keyword entries are trimmed", () => {
    const budget = applyPromptBudget({
      settings: { contextLimitTokens: 600, maxTokens: 256 },
      character: character(),
      pluginBlocks: [],
      lorebook: lorebookReport({
        constantBlock: "C".repeat(120),
        results: [
          {
            index: 0,
            name: "重条目",
            status: "injected",
            matchedKey: "重",
            tokens: 150,
            content: "重".repeat(150),
            diagnostics: [],
          },
        ],
        block: "重".repeat(150),
      }),
      memoryItems: [],
      history: [message("user", "你好", 1)],
    });
    const constantRegion = budget.regions.find((region) => region.key === "worldbook_constant");
    expect(constantRegion?.content).toContain("C".repeat(120));
    expect(budget.regions.some((region) => region.key === "worldbook")).toBe(false);
    expect(budget.diagnostics.join("")).toContain("重条目");
  });

  it("trims older history but keeps the current user input with diagnostics", () => {
    const history = [
      message("user", "旧问题一 " + "A".repeat(60), 1),
      message("assistant", "旧回复一 " + "B".repeat(60), 2),
      message("user", "旧问题二 " + "C".repeat(60), 3),
      message("assistant", "旧回复二 " + "D".repeat(60), 4),
      message("user", "当前问题", 5),
    ];
    const budget = applyPromptBudget({
      settings: { contextLimitTokens: 700, maxTokens: 256 },
      character: character({ description: "X".repeat(200) }),
      pluginBlocks: [],
      lorebook: lorebookReport(),
      memoryItems: [],
      history,
    });
    expect(budget.recentMessages.at(-1)?.content).toBe("当前问题");
    expect(budget.recentMessages.length).toBeLessThan(history.length);
    expect(budget.diagnostics.join("")).toContain("较早消息");
  });

  it("keeps the final prompt within the context limit when the reserve fits", () => {
    // 预留（回复上限 + 余量）= 768 ≤ 上下文上限 1200 时，
    // 区域 + 近期消息 ≤ 可用预算，因此总估算不超出上限。
    const history = Array.from({ length: 20 }, (_, index) =>
      message(index % 2 === 0 ? "user" : "assistant", `消息 ${index} ` + "E".repeat(40), index + 1),
    );
    const budget = applyPromptBudget({
      settings: { contextLimitTokens: 1_200, maxTokens: 256 },
      character: character(),
      pluginBlocks: [],
      lorebook: lorebookReport(),
      memoryItems: [],
      history,
    });
    expect(budget.totalTokens).toBeLessThanOrEqual(1_200);
    expect(budget.recentMessages.at(-1)?.content).toBe(history.at(-1)?.content);
  });

  it("drops retrieved memories (lowest score first) before worldbook entries (FR-PROMPT-003)", () => {
    const budget = applyPromptBudget({
      settings: { contextLimitTokens: 900, maxTokens: 256 },
      character: character(),
      pluginBlocks: [],
      lorebook: lorebookReport({
        results: [
          {
            index: 0,
            name: "词条",
            status: "injected",
            matchedKey: "词",
            tokens: 200,
            content: "W".repeat(400),
            diagnostics: [],
          },
        ],
        block: "W".repeat(400),
      }),
      memoryItems: [
        { id: "00000000-0000-4000-8000-000000000001", content: "低分记忆内容。", tokens: 50, score: 0.1 },
        { id: "00000000-0000-4000-8000-000000000002", content: "高分记忆内容。", tokens: 50, score: 0.9 },
      ],
      history: [message("user", "你好", 1)],
    });
    // 两条普通记忆先被裁剪；若仍无法容纳世界书，继续裁剪世界书。
    const memoryRegion = budget.regions.find((region) => region.key === "memory");
    expect(memoryRegion).toBeUndefined();
    expect(budget.regions.some((region) => region.key === "worldbook")).toBe(false);
    expect(budget.diagnostics.join("")).toContain("词条");
    expect(budget.retainedMemoryIds).toEqual([]);
  });
});
