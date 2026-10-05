import { describe, expect, it } from "vitest";

import type { CharacterRegexRule } from "@mycompanion/shared";

import {
  parseCharacterRegexRules,
  runStage,
  stagesForRule,
  testRegexRules,
} from "./regex-engine.js";

function rule(overrides: Partial<CharacterRegexRule> = {}): CharacterRegexRule {
  return {
    scriptName: "测试规则",
    findRegex: "/世界/gi",
    replaceString: "星球",
    placement: [1, 2],
    disabled: false,
    markdownOnly: false,
    promptOnly: false,
    runOnEdit: false,
    minDepth: null,
    maxDepth: null,
    order: 0,
    sourceDisabled: false,
    ...overrides,
  };
}

describe("parseCharacterRegexRules", () => {
  it("maps SillyTavern regex_scripts entries and keeps unparseable rows out", () => {
    const rules = parseCharacterRegexRules({
      regex_scripts: [
        { scriptName: "方向", findRegex: "/北行/gi", replaceString: "向北" },
        "not-an-object",
        { findRegex: "/x/", replaceString: "y" },
      ],
    });
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ scriptName: "方向", disabled: true });
    // 导入的规则默认停用（与 SillyTavern 导入行为一致）。
  });

  it("preserves import order when rules carry no explicit order", () => {
    const rules = parseCharacterRegexRules({
      regex_scripts: [
        { scriptName: "乙", findRegex: "/b/g", replaceString: "B" },
        { scriptName: "甲", findRegex: "/a/g", replaceString: "A" },
      ],
    });
    expect(rules.map((rule) => rule.order)).toEqual([0, 1]);
  });

  it("returns an empty list when the extension key is absent", () => {
    expect(parseCharacterRegexRules({})).toEqual([]);
  });
});

describe("stagesForRule", () => {
  it("maps placement numbers to stages and treats promptOnly specially", () => {
    expect(stagesForRule(rule({ placement: [1, 2, 0] }))).toEqual(["input", "output"]);
    expect(stagesForRule(rule({ placement: [1], promptOnly: true }))).toEqual(["prompt"]);
    expect(stagesForRule(rule({ placement: [1, 5] }))).toEqual(["input"]);
  });

  it("does not invent placements for an empty placement list", () => {
    expect(stagesForRule(rule({ placement: [] }))).toEqual([]);
  });
});

describe("runStage", () => {
  it("replaces text using JS capture groups and resolves {{char}}/{{user}} macros", async () => {
    const { output } = await runStage(
      [rule({
        scriptName: "称呼",
        findRegex: "/(你好|hi)/gi",
        replaceString: "$1 → {{char}}/{{user}}",
      })],
      "阿斯特",
      "input",
      "你好，hi there",
    );
    expect(output).toBe("你好 → 阿斯特/User，hi → 阿斯特/User there");
  });

  it("keeps unknown macros verbatim and records a non-blocking warning", async () => {
    const { output, rules } = await runStage(
      [rule({ replaceString: "hi {{date}}" })],
      "阿斯特",
      "input",
      "世界",
    );
    expect(output).toBe("hi {{date}}");
    expect(rules[0]?.diagnostics).toEqual([
      "未知宏保持原文：{{date}}",
    ]);
    expect(rules[0]?.status).toBe("applied");
  });

  it("does not let one failing rule block the next one", async () => {
    const { output, rules } = await runStage(
      [
        rule({ scriptName: "坏规则", findRegex: "/^[", replaceString: "x", order: 0 }),
        rule({ scriptName: "好规则", findRegex: "/世界/g", replaceString: "星球", order: 1 }),
      ],
      "阿斯特",
      "input",
      "世界",
    );
    expect(rules[0]?.status).toBe("failed");
    expect(rules[1]?.status).toBe("applied");
    expect(output).toBe("星球");
  });

  it("skips disabled rules", async () => {
    const { output, rules } = await runStage(
      [rule({ disabled: true })],
      "阿斯特",
      "input",
      "世界",
    );
    expect(output).toBe("世界");
    expect(rules[0]?.status).toBe("skipped");
  });

  it("terminates a runaway regex at 250 ms and keeps the original input", async () => {
    const started = Date.now();
    const { output, rules } = await runStage(
      [rule({ scriptName: "死循环", findRegex: "^(a+)+$", replaceString: "x" })],
      "阿斯特",
      "input",
      "a".repeat(55) + "b",
    );
    const elapsed = Date.now() - started;
    expect(rules[0]?.status).toBe("failed");
    expect(rules[0]?.diagnostics[0]).toContain("250 ms");
    expect(output).toBe("a".repeat(55) + "b");
    // 预算是硬性的：worker 被终止，总耗时应在 250 ms 附近而不是分钟级。
    expect(elapsed).toBeLessThan(5_000);
  });

  it("rejects expressions longer than 4 KiB before executing", async () => {
    const { rules } = await runStage(
      [rule({ findRegex: "/" + "a".repeat(4 * 1024 + 10) + "/g" })],
      "阿斯特",
      "input",
      "aaa",
    );
    expect(rules[0]?.status).toBe("failed");
    expect(rules[0]?.diagnostics[0]).toContain("4 KiB");
  });

  it("caps a rule whose output exceeds 2 MiB by keeping the input", async () => {
    const { output, rules } = await runStage(
      [rule({ findRegex: "/^/g", replaceString: "二".repeat(1_000_000) })],
      "阿斯特",
      "input",
      "一",
    );
    expect(rules[0]?.status).toBe("failed");
    expect(rules[0]?.diagnostics).toContain("输出超过 2 MiB 上限，规则结果被丢弃。");
    expect(output).toBe("一");
  });

  it("rejects inputs over 1 MiB", async () => {
    const { rules } = await runStage(
      [rule({})],
      "阿斯特",
      "input",
      "a".repeat(1024 * 1024 + 1),
    );
    expect(rules[0]?.status).toBe("failed");
    expect(rules[0]?.diagnostics[0]).toContain("1 MiB");
  });
});

describe("testRegexRules", () => {
  it("runs all four stages in order on sample text", async () => {
    const report = await testRegexRules(
      [
        rule({ scriptName: "输入规则", findRegex: "/世界/g", replaceString: "星球", placement: [1] }),
        rule({
          scriptName: "输出规则",
          findRegex: "/旅行/g",
          replaceString: "远行",
          placement: [2],
        }),
        rule({
          scriptName: "显示规则",
          findRegex: "/北行/gi",
          replaceString: "向北",
          placement: [2], markdownOnly: true,
        }),
      ],
      "阿斯特",
      "世界旅行，北行",
    );
    expect(report.stages.map((stage) => stage.stage)).toEqual(["input", "prompt", "output", "display"]);
    expect(report.stages[0]).toMatchObject({ output: "星球旅行，北行" });
    expect(report.stages[1]).toMatchObject({ output: "星球旅行，北行" });
    expect(report.stages[2]).toMatchObject({ output: "星球远行，北行" });
    expect(report.stages[3]).toMatchObject({ output: "星球远行，向北" });
    expect(report.finalOutput).toBe("星球远行，向北");
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("runs zero rules when none are enabled", async () => {
    const report = await testRegexRules([rule({ disabled: true })], "阿斯特", "世界");
    expect(report.finalOutput).toBe("世界");
    expect(report.stages.every((stage) => stage.rules.every((r) => r.status === "skipped"))).toBe(true);
  });
});
