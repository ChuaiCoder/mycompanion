import { describe, expect, it } from "vitest";

import type { MemoryRecord } from "@mycompanion/shared";

import { MEMORY_TOKEN_BUDGET, PINNED_MEMORY_TOKEN_BUDGET, reconcileMemoryReport, retrieveMemories } from "./memory-engine.js";

const CONVERSATION_ID = "00000000-0000-4000-8000-000000000009";
const CHARACTER_ID = "00000000-0000-4000-8000-000000000001";

function memory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    conversationId: CONVERSATION_ID,
    characterId: CHARACTER_ID,
    type: "fact",
    content: "角色住在废弃天文台。",
    scope: "story",
    importance: 3,
    status: "active",
    pinned: false,
    sourceMessageIds: [],
    supersededBy: null,
    previousContent: null,
    createdAt: "2026-09-20T00:00:00.000Z",
    lastUsedAt: null,
    ...overrides,
  };
}

describe("retrieveMemories", () => {
  it("keeps an unmatched fixed fact without allowing disabled or stale fixed facts", () => {
    const report = retrieveMemories({ conversationId: CONVERSATION_ID, scanText: "天气如何？", memories: [
      memory({ pinned: true, content: "主角对花生过敏。" }),
      memory({ id: "00000000-0000-4000-8000-000000000003", pinned: true, status: "orphaned" }),
      memory({ id: "00000000-0000-4000-8000-000000000004", pinned: true, status: "disabled" }),
    ] });
    expect(report.injectedCount).toBe(1);
    expect(report.block).toBe("主角对花生过敏。");
    expect(report.results[0]?.pinned).toBe(true);
    expect(report.results[0]?.diagnostics.join("")).toContain("无需关键词");
  });

  it("gives fixed and retrieved facts separate token allowances", () => {
    const report = retrieveMemories({ conversationId: CONVERSATION_ID, scanText: "乙乙", memories: [
      memory({ pinned: true, content: "甲".repeat(90) }),
      memory({ id: "00000000-0000-4000-8000-000000000003", content: "乙".repeat(90) }),
    ] });
    expect(report.injectedCount).toBe(2);
    expect(report.results.reduce((sum, item) => sum + item.tokens, 0)).toBeGreaterThan(MEMORY_TOKEN_BUDGET);
    expect(report.pinnedBudgetTokens).toBe(PINNED_MEMORY_TOKEN_BUDGET);
  });

  it("does not match an English keyword inside a different word", () => {
    const report = retrieveMemories({ conversationId: CONVERSATION_ID, scanText: "starshipyard", memories: [memory({ content: "starship" })] });
    expect(report.injectedCount).toBe(0);
  });

  it("updates diagnostics when the final request drops a previously selected fact", () => {
    const report = retrieveMemories({ conversationId: CONVERSATION_ID, scanText: "天文台", memories: [memory()] });
    expect(report.injectedCount).toBe(1);
    reconcileMemoryReport(report, []);
    expect(report.injectedCount).toBe(0);
    expect(report.block).toBe("");
    expect(report.results[0]?.diagnostics.join("")).toContain("未发送");
  });
  it("injects matching active memories and reports non-matching ones (FR-MEM-005)", () => {
    const report = retrieveMemories({
      conversationId: CONVERSATION_ID,
      memories: [
        memory({ id: "00000000-0000-4000-8000-000000000002", content: "角色住在废弃天文台。" }),
        memory({ id: "00000000-0000-4000-8000-000000000003", content: "飞船名为曙光号。" }),
      ],
      scanText: "我们回到废弃天文台吧。",
    });
    expect(report.position).toBe("before_recent_messages");
    expect(report.block).toContain("废弃天文台");
    expect(report.block).not.toContain("曙光号");
    const matched = report.results.find((item) => item.memoryId === "00000000-0000-4000-8000-000000000002");
    const missed = report.results.find((item) => item.memoryId === "00000000-0000-4000-8000-000000000003");
    expect(matched?.injected).toBe(true);
    expect(matched?.score).toBeGreaterThan(0);
    expect(missed?.injected).toBe(false);
    expect(missed?.diagnostics.join("")).toContain("未命中");
  });

  it("reports non-active memories with reasons and never injects them (FR-MEM-004/008)", () => {
    const report = retrieveMemories({
      conversationId: CONVERSATION_ID,
      memories: [
        memory({ id: "00000000-0000-4000-8000-000000000002", status: "orphaned" }),
        memory({ id: "00000000-0000-4000-8000-000000000003", status: "superseded", supersededBy: "00000000-0000-4000-8000-000000000004" }),
        memory({ id: "00000000-0000-4000-8000-000000000004", status: "disabled" }),
        memory({ id: "00000000-0000-4000-8000-000000000005", status: "pending" }),
      ],
      scanText: "废弃天文台",
    });
    expect(report.injectedCount).toBe(0);
    expect(report.block).toBe("");
    const texts = report.results.map((item) => item.diagnostics.join(""));
    expect(texts[0]).toContain("分支回滚");
    expect(texts[1]).toContain("取代");
    expect(texts[2]).toContain("停用");
    expect(texts[3]).toContain("待确认");
  });

  it("keeps pinned matches under an independent budget while trimming unpinned (FR-MEM-005)", () => {
    // 非固定记忆内容足够长以耗尽预算；固定记忆短小，必须仍然注入。
    const big = "旧".repeat(400);
    const report = retrieveMemories({
      conversationId: CONVERSATION_ID,
      memories: [
        memory({ id: "00000000-0000-4000-8000-000000000002", content: big, pinned: false, importance: 5 }),
        memory({ id: "00000000-0000-4000-8000-000000000003", content: "固定的小记忆。", pinned: true }),
      ],
      // 关键词按 2 字窗口命中，故扫描文本需包含「旧旧」以命中长记忆。
      scanText: "旧旧 固定的小记忆。",
    });
    const bigResult = report.results.find((item) => item.memoryId === "00000000-0000-4000-8000-000000000002");
    const pinnedResult = report.results.find((item) => item.memoryId === "00000000-0000-4000-8000-000000000003");
    expect(pinnedResult?.injected).toBe(true);
    expect(pinnedResult?.diagnostics.join("")).toContain("固定记忆");
    expect(bigResult?.diagnostics.join("")).toContain("预算");
    expect(report.block).toContain("固定的小记忆。");
  });

  it("caps injected memories at the token budget with diagnostics", () => {
    const content = "段".repeat(200);
    const memories = Array.from({ length: 4 }, (_, index) =>
      memory({
        id: `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
        content,
      }),
    );
    const report = retrieveMemories({
      conversationId: CONVERSATION_ID,
      memories,
      scanText: "段段",
    });
    expect(MEMORY_TOKEN_BUDGET).toBe(300);
    const injected = report.results.filter((item) => item.injected);
    const dropped = report.results.filter((item) => !item.injected);
    expect(injected.length).toBeGreaterThan(0);
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped.every((item) => item.diagnostics.join("").includes("预算"))).toBe(true);
  });

  it("matches English words as whole fragments, not substrings (FR-MEM-005 降级关键词检索)", () => {
    const report = retrieveMemories({
      conversationId: CONVERSATION_ID,
      memories: [
        memory({ id: "00000000-0000-4000-8000-000000000002", content: "主角驾驶 starship 离开。" }),
      ],
      scanText: "starship 再次起航。",
    });
    expect(report.results[0]?.injected).toBe(true);
  });
});
