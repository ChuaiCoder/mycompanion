import { describe, expect, it } from "vitest";

import type { CharacterLorebookEntry } from "@mycompanion/shared";

import { estimateTokens, matchLorebookEntries } from "./worldbook-engine.js";
import { tavernTimeValue } from "../prompt/tavern-time-core.js";
import { MacroEvaluationSession } from "../prompt/prompt-macros.js";

const CHARACTER_ID = "00000000-0000-4000-8000-000000000001";
const CHARACTER_NAME = "阿斯特";

function entry(overrides: Partial<CharacterLorebookEntry> = {}): CharacterLorebookEntry {
  return {
    index: 0,
    name: "工作室",
    keys: ["工作室"],
    secondaryKeys: [],
    content: "工作室建在一座废弃天文台内部。",
    enabled: true,
    constant: false,
    caseSensitive: false,
    selective: false,
    insertionOrder: 100,
    sourceEnabled: true,
    ...overrides,
  };
}

describe("estimateTokens", () => {
  it("uses the same model-specific BPE tables as the extension token endpoint", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("ab中文cd", "gpt-4")).toBe(4);
    expect(estimateTokens("ab中文cd", "gpt-4o")).toBe(3);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("matchLorebookEntries", () => {
  it("re-evaluates variable keywords on recursion while expanding accepted content once", () => {
    const macroSession = new MacroEvaluationSession();
    const report = matchLorebookEntries(CHARACTER_ID, [
      entry({ index: 0, constant: true, content: "{{setvar::trigger::unlock}}unlock {{incvar::contentRuns}}" }),
      entry({ index: 1, keys: ["{{getvar::trigger}}"], content: "PRIMARY" }),
      entry({ index: 2, keys: ["start"], selective: true, secondaryKeys: ["{{getvar::trigger}}"], content: "SECONDARY" }),
    ], CHARACTER_NAME, "start", 500, { experimentalMacroEngine: true, recursive: true, macroSession });
    expect(report.results.map(result => result.status)).toEqual(["injected", "injected", "injected"]);
    expect(macroSession.local).toEqual({ trigger: "unlock", contentRuns: 1 });
  });

  it("evaluates distinct keyword occurrences and short-circuits secondary matching like Tavern", () => {
    const macroSession = new MacroEvaluationSession();
    const report = matchLorebookEntries(CHARACTER_ID, [
      entry({ keys: ["{{incvar::keyRuns}}"], selective: true,
        secondaryKeys: ["{{incvar::keyRuns}}", "{{incvar::mustNotRun}}"], content: "MATCHED" }),
    ], CHARACTER_NAME, "1 2", 500, { experimentalMacroEngine: true, macroSession });
    expect(report.results[0]?.status).toBe("injected");
    expect(macroSession.local).toEqual({ keyRuns: 2 });
  });

  it("injects an enabled entry when its primary key matches", () => {
    const report = matchLorebookEntries(
      CHARACTER_ID,
      [entry()],
      CHARACTER_NAME,
      "我们现在在哪里？工作室里吗？",
    );
    expect(report.characterId).toBe(CHARACTER_ID);
    expect(report.position).toBe("after_character_core");
    expect(report.results).toHaveLength(1);
    expect(report.results[0]?.status).toBe("injected");
    expect(report.results[0]?.matchedKey).toBe("工作室");
    expect(report.block).toContain("废弃天文台");
    expect(report.injectedCount).toBe(1);
  });

  it("expands saved variables in trigger keys and budgeted entry content", () => {
    const report = matchLorebookEntries(CHARACTER_ID,
      [entry({ keys: ["{{getvar::place}}"], content: "前方是{{getglobalvar::weather}}。" })],
      CHARACTER_NAME, "我们到了工作室。", 500,
      { localVariables: { place: "工作室" }, globalVariables: { weather: "雨" } });
    expect(report.results[0]?.status).toBe("injected");
    expect(report.results[0]?.matchedKey).toBe("{{getvar::place}}");
    expect(report.results[0]?.content).toBe("前方是雨。");
    expect(report.results[0]?.tokens).toBe(estimateTokens("前方是雨。"));
  });

  it("matches and counts worldbook text using the current request's token limits", () => {
    const content = "提示词预算 1920，上下文 2048，回复 128。";
    const report = matchLorebookEntries(CHARACTER_ID,
      [entry({ keys: ["预算{{maxPrompt}}"],
        content: "提示词预算 {{maxPrompt}}，上下文 {{maxContext}}，回复 {{maxResponse}}。" })],
      CHARACTER_NAME, "请按预算1920继续。", 500,
      { contextLimitTokens: 2048, maxResponseTokens: 128 });
    expect(report.results[0]?.status).toBe("injected");
    expect(report.block).toBe(content);
    expect(report.results[0]?.tokens).toBe(estimateTokens(content));
  });

  it("does not inject disabled entries and reports the reason", () => {
    const report = matchLorebookEntries(
      CHARACTER_ID,
      [entry({ enabled: false })],
      CHARACTER_NAME,
      "工作室",
    );
    expect(report.results[0]?.status).toBe("disabled");
    expect(report.block).toBe("");
    expect(report.injectedCount).toBe(0);
    expect(report.results[0]?.diagnostics.join("")).toContain("未启用");
  });

  it("requires a primary key and applies secondary keys only in selective mode", () => {
    const withSecondary = entry({ keys: ["主词"], secondaryKeys: ["可选词"] });
    const selective = entry({ keys: ["主词"], secondaryKeys: ["可选词"], selective: true });

    const open = matchLorebookEntries(CHARACTER_ID, [withSecondary], CHARACTER_NAME, "提到了可选词。");
    expect(open.results[0]?.status).toBe("no_match");

    const closed = matchLorebookEntries(CHARACTER_ID, [selective], CHARACTER_NAME, "提到了可选词。");
    expect(closed.results[0]?.status).toBe("no_match");
    expect(matchLorebookEntries(CHARACTER_ID, [withSecondary], CHARACTER_NAME, "主词").injectedCount).toBe(1);
    expect(matchLorebookEntries(CHARACTER_ID, [selective], CHARACTER_NAME, "主词").injectedCount).toBe(0);
    expect(matchLorebookEntries(CHARACTER_ID, [selective], CHARACTER_NAME, "主词 可选词").injectedCount).toBe(1);
  });

  it("respects the case-sensitive flag", () => {
    const sensitive = entry({ keys: ["Paris"], caseSensitive: true });
    const insensitive = entry({ keys: ["Paris"], caseSensitive: false });

    expect(matchLorebookEntries(CHARACTER_ID, [sensitive], CHARACTER_NAME, "we are in paris").results[0]?.status).toBe("no_match");
    expect(matchLorebookEntries(CHARACTER_ID, [insensitive], CHARACTER_NAME, "we are in paris").results[0]?.status).toBe("injected");
  });

  it("injects constant entries every round without needing a key", () => {
    const report = matchLorebookEntries(
      CHARACTER_ID,
      [entry({ keys: [], constant: true, content: "固定背景设定。" })],
      CHARACTER_NAME,
      "毫无关系的一句话。",
    );
    expect(report.results[0]?.status).toBe("injected");
    expect(report.results[0]?.matchedKey).toBeNull();
    expect(report.block).toBe("固定背景设定。");
  });

  it("follows recursive triggers but stops at the round limit", () => {
    const first = entry({ index: 0, name: "第一", keys: ["天文台"], content: "里面提到 工作室。", insertionOrder: 10 });
    const second = entry({ index: 1, name: "第二", keys: ["工作室"], content: "里面提到 第三地点。", insertionOrder: 20 });
    const third = entry({ index: 2, name: "第三", keys: ["第三地点"], content: "里面提到 第四地点。", insertionOrder: 30 });

    const report = matchLorebookEntries(
      CHARACTER_ID,
      [first, second, third],
      CHARACTER_NAME,
      "我们在天文台。",
      500,
      { recursive: true, maxRecursionSteps: 3 },
    );
    // 第 0 轮命中第一；第 1 轮（第一的内容并入扫描文本）命中第二；
    // 第 2 轮命中第三；超过最大轮数后第四地点不会再触发。
    expect(report.results[0]?.status).toBe("injected");
    expect(report.results[1]?.status).toBe("injected");
    expect(report.results[2]?.status).toBe("injected");
    expect(report.injectedCount).toBe(3);
  });

  it("selects high order first but places low order earlier in the prompt", () => {
    const low = entry({ index: 0, name: "低", keys: ["低词"], content: "LOW", insertionOrder: 1 });
    const high = entry({ index: 1, name: "高", keys: ["高词"], content: "HIGH", insertionOrder: 500 });
    const report = matchLorebookEntries(
      CHARACTER_ID,
      [low, high],
      CHARACTER_NAME,
      "低词 高词",
    );
    expect(report.block).toBe("LOW\n\nHIGH");
  });

  it("resolves char/user/date macros and keeps unknown macros verbatim", () => {
    const report = matchLorebookEntries(
      CHARACTER_ID,
      [entry({ content: "你是{{char}}，玩家是{{user}}，{{date}}，{{unknown}}。" })],
      CHARACTER_NAME,
      "工作室",
    );
    const expectedDate = tavernTimeValue("date", new Date());
    expect(report.block).toBe(`你是${CHARACTER_NAME}，玩家是User，${expectedDate}，{{unknown}}。`);
  });

  it("drops non-constant entries that exceed the token budget and records diagnostics", () => {
    const heavy = entry({ index: 0, name: "重", keys: ["重词"], content: "字".repeat(400), insertionOrder: 10 });
    const light = entry({ index: 1, name: "轻", keys: ["轻词"], content: "轻。", insertionOrder: 20 });

    const report = matchLorebookEntries(
      CHARACTER_ID,
      [heavy, light],
      CHARACTER_NAME,
      "重词 轻词",
      10,
    );
    const heavyResult = report.results.find((result) => result.index === 0);
    const lightResult = report.results.find((result) => result.index === 1);
    expect(heavyResult?.status).toBe("budget_dropped");
    expect(heavyResult?.diagnostics.join("")).toContain("预算");
    expect(lightResult?.status).toBe("injected");
    expect(report.block).toBe("轻。");
  });

  it("applies the world-info budget to constants unless ignoreBudget is set", () => {
    const constant = entry({ index: 0, name: "常驻", keys: [], constant: true, content: "字".repeat(400) });
    const report = matchLorebookEntries(CHARACTER_ID, [constant], CHARACTER_NAME, "无关", 10);
    expect(report.results[0]?.status).toBe("budget_dropped");
    expect(report.results[0]?.diagnostics.join("")).toContain("预算");
    expect(matchLorebookEntries(CHARACTER_ID, [{ ...constant, worldInfo: { ignoreBudget: true } }], CHARACTER_NAME, "无关", 10).injectedCount).toBe(1);
  });

  it("diagnoses enabled keyword entries that have no keys at all", () => {
    const report = matchLorebookEntries(
      CHARACTER_ID,
      [entry({ keys: [], constant: false })],
      CHARACTER_NAME,
      "任意文本",
    );
    expect(report.results[0]?.status).toBe("no_match");
    expect(report.results[0]?.diagnostics.join("")).toContain("没有主关键词");
  });

  it("reports no injection for an entry with a non-matching key", () => {
    const report = matchLorebookEntries(CHARACTER_ID, [entry()], CHARACTER_NAME, "完全没有关键词。");
    expect(report.results[0]?.status).toBe("no_match");
    expect(report.block).toBe("");
  });

  it.each([
    [0, "主 一", true], [0, "主", false],
    [1, "主 一", true], [1, "主 一 二", false],
    [2, "主", true], [2, "主 二", false],
    [3, "主 一 二", true], [3, "主 一", false],
  ])("evaluates secondary logic %s on %s", (logic, text, expected) => {
    const item = entry({ keys: ["主"], secondaryKeys: ["一", "二"], selective: true, worldInfo: { selectiveLogic: logic } });
    expect(matchLorebookEntries(CHARACTER_ID, [item], CHARACTER_NAME, text).injectedCount).toBe(expected ? 1 : 0);
    expect(matchLorebookEntries(CHARACTER_ID, [item], CHARACTER_NAME, "一 二").injectedCount).toBe(0);
  });

  it("matches regex keys with explicit flags, whole words and expanded keyword macros", () => {
    const scan = (item: CharacterLorebookEntry, text: string) => matchLorebookEntries(CHARACTER_ID, [item], CHARACTER_NAME, text).injectedCount;
    expect(scan(entry({ keys: ["/paris/i"], caseSensitive: true }), "PARIS")).toBe(1);
    expect(scan(entry({ keys: ["/paris/"], caseSensitive: false }), "PARIS")).toBe(0);
    expect(scan(entry({ keys: ["cat"], worldInfo: { matchWholeWords: true } }), "category")).toBe(0);
    expect(scan(entry({ keys: ["cat"], worldInfo: { matchWholeWords: true } }), "a cat!")).toBe(1);
    expect(scan(entry({ keys: ["{{char}}"] }), CHARACTER_NAME)).toBe(1);
  });

  it("scans prepared character fields literally while expanding selected content variables", () => {
    const item = entry({ keys: ["北方"], worldInfo: { matchCharacterDescription: true }, content: "前往{{getvar::route}}" });
    const options = { messages: ["无关键词"], localVariables: { route: "北方" },
      globalScanData: { characterDescription: "路线：北方" } };
    const report = matchLorebookEntries(CHARACTER_ID, [item], CHARACTER_NAME, "", 500, options);
    expect(report.results[0]?.status).toBe("injected");
    expect(report.block).toBe("前往北方");
    expect(matchLorebookEntries(CHARACTER_ID, [item], CHARACTER_NAME, "", 500,
      { ...options, localVariables: { route: "南方" } }).block).toBe("前往南方");
    expect(matchLorebookEntries(CHARACTER_ID, [item], CHARACTER_NAME, "", 500,
      { ...options, globalScanData: { characterDescription: "路线：{{getvar::route}}" } }).injectedCount).toBe(0);
  });

  it("uses message depth, entry overrides and constant recursion without leaking dropped content", () => {
    const items = [entry({ index: 0, keys: [], constant: true, content: "工作室", insertionOrder: 300 }), entry({ index: 1, content: "触发成功" })];
    const scan = { messages: ["当前", "上一条", "工作室"], scanDepth: 2 };
    expect(matchLorebookEntries(CHARACTER_ID, [items[1]!], CHARACTER_NAME, "", 500, scan).injectedCount).toBe(0);
    expect(matchLorebookEntries(CHARACTER_ID, [{ ...items[1]!, worldInfo: { scanDepth: 3 } }], CHARACTER_NAME, "", 500, scan).injectedCount).toBe(1);
    expect(matchLorebookEntries(CHARACTER_ID, items, CHARACTER_NAME, "", 500, scan).injectedCount).toBe(1);
    expect(matchLorebookEntries(CHARACTER_ID, items, CHARACTER_NAME, "", 500, { ...scan, recursive: true }).injectedCount).toBe(2);
    expect(matchLorebookEntries(CHARACTER_ID, items, CHARACTER_NAME, "", 1, { ...scan, recursive: true }).block).toBe("");
    items[0]!.worldInfo = { preventRecursion: true };
    expect(matchLorebookEntries(CHARACTER_ID, items, CHARACTER_NAME, "", 500, { ...scan, recursive: true }).injectedCount).toBe(1);
  });

  it("stops budget admission at overflow and does not lose explicit ignoreBudget entries", () => {
    const items = [entry({ index: 0, constant: true, content: "字".repeat(100), insertionOrder: 300 }),
      entry({ index: 1, constant: true, content: "小", insertionOrder: 200 }),
      entry({ index: 2, constant: true, content: "豁免", insertionOrder: 100, worldInfo: { ignoreBudget: true } })];
    const report = matchLorebookEntries(CHARACTER_ID, items, CHARACTER_NAME, "", 20);
    expect(report.results.map(result => result.status)).toEqual(["budget_dropped", "budget_dropped", "injected"]);
    expect(report.block).toBe("豁免");
  });
});
