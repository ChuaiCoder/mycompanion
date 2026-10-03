import { afterEach, expect, it, vi } from "vitest";
import { MacroRegistry } from "@mycompanion/macro-engine";
import { matchLorebookEntries } from "./worldbook-engine.js";
import { getWorldInfoActivatedEntries, getWorldInfoOutletEntries, getWorldInfoOutlets, worldInfoOutletsFromPrompts } from "./world-info-activation.js";
import { finalizeWorldInfoRegex } from "./world-info-service.js";
import { TavernRegexExecutor } from "./tavern-regex-service.js";
import { MacroEvaluationSession, resolveMacros } from "./prompt-macros.js";
import { browserMacroHarness } from "./browser-macro-test-helper.js";
import type { CharacterLorebookEntry } from "@mycompanion/shared";

afterEach(() => { MacroRegistry.unregisterMacro("readLiveOutlet"); vi.restoreAllMocks(); });
const characterId = "00000000-0000-4000-8000-000000000001";
const entry = (index: number, content: string, order: number, constant: boolean, key: string): CharacterLorebookEntry => ({
  index, content, name: String(index), insertionOrder: order, keys: [key], secondaryKeys: [], enabled: true,
  constant, caseSensitive: false, selective: true, sourceEnabled: true, worldInfo: { world: "outlet", uid: index, position: 7, outletName: "story" },
});
it("joins descending outlet order with stable activation ties, including late recursive activations", async () => {
  const entries = [entry(0, "LATE", 100, false, "second"), entry(1, "second", 100, true, ""), entry(2, "HIGH", 101, true, "")];
  const report = matchLorebookEntries(characterId, entries, "Actor", "", 1000, { recursive: true });
  expect(getWorldInfoOutletEntries(report)).toEqual({ story: ["HIGH", "second", "LATE"] });
  expect(getWorldInfoOutlets(report)).toEqual({ story: "HIGH\nsecond\nLATE" });
  expect(getWorldInfoActivatedEntries(report).map(entry => entry.uid)).toEqual([2, 1, 0]);
  const executor = new TavernRegexExecutor();
  try {
    const final = await finalizeWorldInfoRegex(report, executor, undefined, {}, { regex: [{
      id: "outlet-regex", scriptName: "outlet-regex", findRegex: "HIGH", replaceString: "FINAL", trimStrings: [],
      placement: [5], disabled: false, markdownOnly: false, promptOnly: true, runOnEdit: false, substituteRegex: 0,
    }] }, new MacroEvaluationSession());
    expect(getWorldInfoOutlets(final)).toEqual({ story: "FINAL\nsecond\nLATE" });
    expect(getWorldInfoActivatedEntries(final)[0]!.content).toBe("HIGH");
  } finally { await executor.close(); }
});
it.each([false, true])("reads one invocation's outlets and preserves raw returned macro text (experimental=%s)", experimental => {
  const session = new MacroEvaluationSession();
  session.bindWorldInfoOutlets({ story: "OLD", constructor: "OWN", raw: "{{char}}" });
  session.bindCharacterEnvironment({ collapseNewlines: false });
  const context = { characterName: "Actor", experimentalMacroEngine: experimental };
  expect(session.resolve("field", "{{outlet::story}}", context)).toBe("OLD");
  session.bindWorldInfoOutlets({ story: "NEW", raw: "{{char}}" });
  expect(session.resolve("field", "{{outlet::story}}", context)).toBe("NEW");
  expect(session.evaluate("{{outlet::missing}}/{{outlet::raw}}", context)).toBe("/{{char}}");
  expect(resolveMacros("{{outlet::constructor}}", context)).toBe("");
});
it.each([false, true])("mounts outlets in the real browser map for core and third-party macro providers and restores descriptors (experimental=%s)", experimental => {
  const h = browserMacroHarness(); h.powerUser.experimental_macro_engine = experimental;
  h.context.extensionPrompts.customWIOutlet_story = { value: "OLD", position: -1, depth: 0, scan: false, role: 0 };
  h.context.extensionPrompts.unrelated = { value: "UNCHANGED" };
  const prompts = h.context.extensionPrompts, old = prompts.customWIOutlet_story;
  h.MacrosParser.registerMacro("readLiveOutlet", () => h.context.extensionPrompts.customWIOutlet_story?.value);
  const result = h.evaluateBrowserMacro({ conversationId: null, branchId: null, evaluation: {
    content: "{{outlet::story}}/{{readLiveOutlet}}", context: { experimentalMacroEngine: experimental, replaceCharacterCard: false },
    environment: { worldInfoOutlets: { story: "NEW" } }, local: {}, global: {},
  } });
  expect(result.content).toBe("NEW/NEW");
  expect(h.context.extensionPrompts).toBe(prompts); expect(prompts.customWIOutlet_story).toBe(old);
  expect(prompts.unrelated.value).toBe("UNCHANGED");
  expect(h.withWorldInfoOutlets({}, () => h.substituteParams("{{outlet::story}}", { replaceCharacterCard: false }))).toBe("");
  expect(() => h.withWorldInfoOutlets({ story: "TEMP" }, () => { throw new Error("fixture abort"); })).toThrow("fixture abort");
  expect(prompts.customWIOutlet_story).toBe(old);
});
it("reads prior NONE snapshots without treating normal injection keys as outlets", () => {
  expect(worldInfoOutletsFromPrompts([{ key: "customWIOutlet_story", value: "OLD", position: -1, depth: 0, role: 0, scan: false },
    { key: "regular", value: "OTHER", position: 1, depth: 0, role: 0, scan: false }])).toEqual({ story: "OLD" });
});
