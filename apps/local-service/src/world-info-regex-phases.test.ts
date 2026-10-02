import { expect, it } from "vitest";
import { buildApp } from "./app.js";
import { apps } from "./test-helpers.js";
import { MacroEvaluationSession } from "./prompt-macros.js";
import { TavernRegexExecutor } from "./tavern-regex-service.js";

it.each([false, true])("escapes macro values without escaping authored regex syntax (experimental=%s)", async experimental => {
  const session = new MacroEvaluationSession({ variables: { token: "A+B" } }, { __mycompanion_power_user: { experimental_macro_engine: experimental } });
  const context = { characterName: "C(D)", userName: "User", experimentalMacroEngine: experimental };
  const executor = new TavernRegexExecutor();
  try {
    const result = await executor.run("A+B C(D) AAB", 1, [{ placement: [1], findRegex: "/(?:{{getvar::token}}|{{char}})/g",
      substituteRegex: 2, replaceString: "MATCH={{incvar::matched}}" }], context.characterName, {
      substitute: (text, escape) => session.evaluate(text, { ...context, ...(escape ? { postProcessFn: escape } : {}) }),
    });
    expect(result).toBe("MATCH=1 MATCH=2 AAB"); expect(session.local.matched).toBe(2);
  } finally { executor.close(); }
});

async function fixture(experimental: boolean, entries: Record<string, unknown>, regex: unknown[]) {
  const app = buildApp(); apps.push(app);
  const avatar = (await app.inject({ method: "POST", url: "/api/characters/create", payload: { ch_name: "WI regex", first_mes: "Hello" } })).body;
  const character = (await app.inject({ method: "POST", url: "/api/characters/get", payload: { avatar_url: avatar } })).json();
  const story = (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } })).json();
  await app.inject({ method: "PUT", url: "/api/extensions/settings", payload: { extensionSettings: { regex,
    __mycompanion_power_user: { experimental_macro_engine: experimental } } } });
  await app.inject({ method: "POST", url: "/api/worldinfo/edit", payload: { name: "regex-phases", data: { entries } } });
  const settings = (await app.inject({ method: "GET", url: "/api/worldinfo/settings" })).json();
  await app.inject({ method: "PUT", url: "/api/worldinfo/settings", payload: { ...settings, world_info_recursive: true,
    world_info_budget_cap: 50, world_info: { globalSelect: ["regex-phases"], charLore: [] } } });
  const response = await app.inject({ method: "POST", url: "/api/worldinfo/prompt", payload: { characterId: character.id,
    conversationId: story.id, chat: [], maxContext: 4096, commitVariables: true } });
  expect(response.statusCode, response.body).toBe(200);
  return { result: response.json(), variables: (await app.inject({ method: "GET", url: `/api/conversations/${story.id}` })).json().chatMetadata.variables ?? {} };
}

it.each([false, true])("runs WI regex after recursion and admission, preserving its expanded output (experimental=%s)", async experimental => {
  const expanded = "EXPANDED ".repeat(200);
  const { result, variables } = await fixture(experimental, {
    1: { uid: 1, constant: true, key: [], content: "seed", order: 200, position: 1 },
    2: { uid: 2, key: ["EXPANDED"], content: "MUST_NOT_RECURSE", order: 100, position: 1 },
  }, [{ placement: [5], promptOnly: true, findRegex: "/seed/g", replaceString: expanded + "{{incvar::regexRuns}}" }]);
  expect(result.report.results.find((entry: { uid: number }) => entry.uid === 1).content).toBe(expanded + "1");
  expect(result.report.results.find((entry: { uid: number }) => entry.uid === 1).tokens).toBeGreaterThan(50);
  expect(result.report.results.find((entry: { uid: number }) => entry.uid === 2).status).toBe("no_match");
  expect(variables).toEqual({ regexRuns: 1 });
});

it("executes placement 5 by descending entry order and applies depth gates only to at-depth entries", async () => {
  const { result, variables } = await fixture(true, {
    1: { uid: 1, constant: true, key: [], content: "seed", order: 100, position: 1 },
    2: { uid: 2, constant: true, key: [], content: "seed", order: 300, position: 0 },
    3: { uid: 3, constant: true, key: [], content: "seed", order: 200, position: 4, depth: 4 },
  }, [{ placement: [5], promptOnly: true, maxDepth: 0, findRegex: "/seed/g", replaceString: "RUN={{incvar::regexRuns}}" }]);
  expect(result.report.results.map((entry: { uid: number; content: string }) => [entry.uid, entry.content])).toEqual([[2, "RUN=1"], [3, "seed"], [1, "RUN=2"]]);
  expect(variables).toEqual({ regexRuns: 2 });
});

it("retains activation diagnostics when placement 5 removes all prompt content", async () => {
  const { result } = await fixture(true, { 1: { uid: 1, constant: true, key: [], content: "seed", position: 1 } },
    [{ placement: [5], promptOnly: true, findRegex: "/seed/g", replaceString: "" }]);
  expect(result.report.results[0].status).toBe("injected"); expect(result.report.results[0].content).toBe("");
  expect(result.activated).toHaveLength(1); expect(result.report.block).toBe("");
});
