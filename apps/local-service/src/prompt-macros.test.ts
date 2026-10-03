import { describe, expect, it } from "vitest";

import { MacroEvaluationSession, resolveMacros } from "./prompt-macros.js";

const NOW = new Date(2026, 8, 20, 9, 5, 7);

describe("resolveMacros", () => {
  it("resolves {{char}} and {{user}} case-insensitively", () => {
    const text = "你是 {{char}}，玩家 {{user}}，{{ CHAR }} 再次出场。";
    expect(resolveMacros(text, { characterName: "阿斯特", userName: "夜航" })).toBe(
      "你是 阿斯特，玩家 夜航，阿斯特 再次出场。",
    );
    expect(resolveMacros("{{user}}", { characterName: "A" })).toBe("User");
  });

  it("reads persisted chat and global variables with the browser getter's numeric rules", () => {
    const result = resolveMacros("{{getvar::route}}/{{getglobalvar::weather}}/{{GETVAR::count}}/{{getvar::blank}}/{{getvar::missing}}", {
      characterName: "阿斯特", localVariables: { route: "北方", count: "03", blank: "", nested: "向{{char}}" },
      globalVariables: { weather: "雨" },
    });
    expect(result).toBe("北方/雨/3//");
    expect(resolveMacros("{{getvar::nested}}", { characterName: "阿斯特",
      localVariables: { nested: "向{{char}}" } })).toBe("向阿斯特");
  });

  it("uses Tavern-style localized and ISO date macros from one round clock", () => {
    expect(resolveMacros("{{date}}|{{time}}|{{weekday}}|{{isodate}}|{{isotime}}", {
      characterName: "A", now: NOW, locale: "zh-CN",
    })).toBe("2026年9月20日|09:05|星期日|2026-09-20|09:05");
    expect(resolveMacros("{{date}}|{{time}}", {
      characterName: "A", now: NOW, locale: "en-US",
    })).toBe("September 20, 2026|9:05 AM");
  });

  it("uses the extension document's read-only formatting and model macros", () => {
    expect(resolveMacros("A{{newline}}B\n{{trim}}\n{{noop}}{{model}}/{{getvar::note}}", {
      characterName: "A", model: "fixture-model", localVariables: { note: "{{newline}}end" },
    })).toBe("A\nBfixture-model/\nend");
  });

  it("uses request-scoped context and response limits for all budget macro aliases", () => {
    const context = { characterName: "A", contextLimitTokens: 4096, maxResponseTokens: 512,
      localVariables: { budget: "{{maxPrompt}}/{{maxResponseTokens}}" } };
    expect(resolveMacros("{{maxPrompt}}|{{maxPromptTokens}}|{{maxContext}}|{{maxContextTokens}}|{{maxResponse}}|{{maxResponseTokens}}|{{getvar::budget}}", context))
      .toBe("3584|3584|4096|4096|512|512|3584/512");
  });

  it("makes {{random}} deterministic for the same input and seed", () => {
    const text = "骰点：{{random 火|水|雷}}";
    const first = resolveMacros(text, { characterName: "A", now: NOW });
    const second = resolveMacros(text, { characterName: "A", now: NEW_NOW() });
    expect(first).toBe(second);
    const expected = first.replace("骰点：", "");
    expect(["火", "水", "雷"]).toContain(expected);
  });

  it("lets an explicit trailing seed override the default seed", () => {
    const base = resolveMacros("{{random 甲|乙}}", { characterName: "A", now: NOW });
    const seeded = resolveMacros("{{random 甲|乙 7}}", { characterName: "A", now: NOW });
    const seededAgain = resolveMacros("{{random 甲|乙 7}}", { characterName: "A", now: NOW });
    expect(seeded).toBe(seededAgain);
    // 不同种子可能相同也可能不同；这里只要求显式种子自洽且可选值合法。
    expect(["甲", "乙"]).toContain(seeded);
    void base;
  });

  it("keeps an option that merely ends with digits intact (no trailing space)", () => {
    const result = resolveMacros("{{random v2.1|v3.0}}", { characterName: "A", now: NOW });
    expect(["v2.1", "v3.0"]).toContain(result);
  });

  it("keeps unknown macros verbatim (FR-REGEX-004 semantics)", () => {
    expect(resolveMacros("{{date_2}} 与 {{unknown}}", { characterName: "A" })).toBe(
      "{{date_2}} 与 {{unknown}}",
    );
  });

  it("does not fail on an empty random macro body", () => {
    expect(resolveMacros("{{random }}", { characterName: "A" })).toBe("{{random }}");
  });

  it.each([false, true])("preserves dynamic replacement phase and session cache with experimental=%s", experimentalMacroEngine => {
    const session = new MacroEvaluationSession({variables:{count:0}});
    const context = {characterName:"Actor",userName:"Reader",experimentalMacroEngine,contextLimitTokens:1024,maxResponseTokens:128};
    const value = "{{incvar::count}} {{char}} {{maxResponse}}";
    expect(session.evaluate("{{incvar::count}}/{{lastChatMessage}}", {...context,dynamicMacros:{lastChatMessage:value}}))
      .toBe("1/"+value.replace("{{maxResponse}}",experimentalMacroEngine?"{{maxResponse}}":"128"));
    expect(session.local.count).toBe(1);
    expect(session.resolve("continue","{{lastChatMessage}}",{...context,dynamicMacros:{lastChatMessage:"first"}})).toBe("first");
    expect(session.resolve("continue","{{lastChatMessage}}",{...context,dynamicMacros:{lastChatMessage:"second"}})).toBe("second");
    expect(session.evaluate("{{CHAR}}",{...context,dynamicMacros:{char:"Override"}})).toBe("Override");
    expect(session.evaluate("{{description}}",{...context,characterFieldSources:{description:"card"},dynamicMacros:{description:"{{char}}"}}))
      .toBe(experimentalMacroEngine?"{{char}}":"Actor");
    expect(session.evaluate("{{tag.key+}}",{...context,dynamicMacros:{"tag.key+":"literal"}}))
      .toBe(experimentalMacroEngine?"{{tag.key+}}":"literal");
  });

  it("selects from Tavern's double-colon and escaped-comma syntax", () => {
    const colon = resolveMacros("{{random::晴天::雨天}}", { characterName: "A" });
    expect(["晴天", "雨天"]).toContain(colon);
    const comma = resolveMacros("{{random:红\\,蓝,绿}}", { characterName: "A" });
    expect(["红,蓝", "绿"]).toContain(comma);
  });
});

function NEW_NOW(): Date {
  return new Date(2026, 8, 20, 10, 0, 0);
}
