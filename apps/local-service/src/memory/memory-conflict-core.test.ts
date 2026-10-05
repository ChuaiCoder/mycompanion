import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "@mycompanion/shared";
import { classifyMemoryRelation, isCompleteSourceQuote, quoteProvesTransition } from "./memory-conflict-core.js";

const story = randomUUID(), character = randomUUID();
function memory(content: string, value = "北京", patch: Partial<MemoryRecord> = {}): MemoryRecord {
  return { id: randomUUID(), conversationId: story, characterId: character, type: "state", content, scope: "story", importance: 3,
    status: "active", pinned: false, manuallyEdited: false, sourceMessageIds: [randomUUID()], supersededBy: null,
    previousContent: null, createdAt: "2026-10-02T00:00:00.000Z", lastUsedAt: null,
    claim: { subject: "玩家", predicate: "位置", value, temporality: "current" }, ...patch };
}

describe("conservative memory conflict classification", () => {
  it("recognizes exact text and structured paraphrases as duplicates without replacing the old source", () => {
    const old = memory("玩家在北京。");
    expect(classifyMemoryRelation(old, memory("玩家在北京。")).kind).toBe("duplicate");
    expect(classifyMemoryRelation(old, memory("玩家的位置是北京。"))).toMatchObject({ kind: "duplicate", action: "pending" });
  });
  it("does not equate shared wording, negations or multiple facts with semantic duplicates", () => {
    const old = memory("玩家是图书馆管理员。", "管理员", { claim: undefined });
    expect(classifyMemoryRelation(old, memory("玩家不是图书馆管理员。", "其他", { claim: undefined })))
      .toMatchObject({ kind: "uncertain", action: "pending" });
  });
  it("separates different entities and properties even when every other word matches", () => {
    const old = memory("玩家在北京。");
    for (const claim of [{ subject: "小王", predicate: "位置", value: "北京", temporality: "current" as const },
      { subject: "玩家", predicate: "出生地", value: "北京", temporality: "stable" as const }]) {
      expect(classifyMemoryRelation(old, memory("玩家在北京。", "北京", { content: "玩家在北京。新记录", claim })).kind).toBe("unrelated");
    }
  });
  it("keeps recurrent events separate without an occurrence identity", () => {
    const claim = { subject: "玩家", predicate: "到访", value: "北京", temporality: "event" as const };
    expect(classifyMemoryRelation(memory("玩家抵达北京。", "北京", { claim }), memory("玩家抵达北京。", "北京", { claim })))
      .toMatchObject({ kind: "unrelated", action: "keep" });
  });
  it.each([{}, { laterSources: true }, { verifiedTransition: true }])("requires both chronological and explicit transition evidence: %j", evidence => {
    expect(classifyMemoryRelation(memory("北京"), memory("上海", "上海"), evidence)).toMatchObject({ kind: "conflict", action: "pending" });
  });
  it("recognizes verified current-state changes without turning stable contradictions into temporal updates", () => {
    const evidence = { laterSources: true, verifiedTransition: true };
    expect(classifyMemoryRelation(memory("北京"), memory("上海", "上海"), evidence)).toMatchObject({ kind: "temporal_update", action: "supersede" });
    expect(classifyMemoryRelation(memory("北京", "北京", { claim: { subject: "玩家", predicate: "出生地", value: "北京", temporality: "stable" } }),
      memory("上海", "上海", { claim: { subject: "玩家", predicate: "出生地", value: "上海", temporality: "stable" } }), evidence))
      .toMatchObject({ kind: "conflict", action: "pending" });
  });
  it.each([{ pinned: true }, { manuallyEdited: true }, { previousContent: "人工更正前" }, { sourceMessageIds: [] }, { scope: "character" as const }])
    ("protects user authority and other scopes: %j", patch => {
      expect(classifyMemoryRelation(memory("北京", "北京", patch), memory("上海", "上海"), { laterSources: true, verifiedTransition: true }))
        .toMatchObject({ kind: "manuallyEdited" in patch ? "uncertain" : "temporal_update", action: "pending" });
    });
  it.each(["如果玩家的位置从北京搬到上海。", "玩家的位置没有从北京搬到上海。", "I might move from Beijing to Shanghai.", "玩家希望位置从北京变成上海。"])
    ("rejects non-asserted transitions: %s", quote => expect(quoteProvesTransition(quote, "北京", "上海")).toBe(false));
  it("verifies complete sentences and escapes literal values in the transition grammar", () => {
    expect(quoteProvesTransition("玩家的等级从A+B改成C.D。", "A+B", "C.D")).toBe(true);
    expect(quoteProvesTransition("玩家的等级从AB改成CxD。", "A+B", "C.D")).toBe(false);
    expect(isCompleteSourceQuote("假如玩家的位置从北京搬到上海。", "玩家的位置从北京搬到上海。")).toBe(false);
    expect(isCompleteSourceQuote("前文。玩家的位置从北京搬到上海。后文。", "玩家的位置从北京搬到上海。")).toBe(true);
  });
});
