import { expect, it, vi } from "vitest";
import { MacroEvaluationSession } from "./prompt-macros.js";
import { runMacroBoundary, type BrowserMacroCall } from "./macro-boundary.js";
import { assembleModelPrompt } from "./model-client.js";
import type { PromptAssemblyOptions } from "./model-client.js";
import { productCardForTests } from "./macro-boundary-test-helper.js";
import { matchLorebookEntries } from "./worldbook-engine.js";

const context = { characterName: "Actor", userName: "User", model: "gpt-4o" };
it("cancels a resolver that ignores its signal and observes its late rejection", async () => {
  const session = new MacroEvaluationSession({variables:{count:1}}), controller = new AbortController();
  let reject!: (error:Error)=>void;
  const resolver=vi.fn(()=>new Promise<never>((_resolve,fail)=>{reject=fail;}));
  const running=runMacroBoundary(session,controller.signal,resolver,()=>session.evaluate("wait",context));
  const failed=expect(running).rejects.toThrow("cancel ignored resolver");
  controller.abort(new Error("cancel ignored resolver"));await failed;
  expect(session.local).toEqual({count:1});expect(session.changes()).toEqual([]);
  reject(new Error("late resolver rejection"));await Promise.resolve();
  expect(session.evaluate("{{char}}",context)).toBe("Actor");
});

it("draws WI probability once across suspension replays and never draws for unselected entries",async()=>{
  const session=new MacroEvaluationSession(), random=vi.fn().mockReturnValueOnce(.1).mockReturnValue(.99);
  const card=productCardForTests("Actor");
  const entries=[{index:0,name:"selected",keys:["trigger"],secondaryKeys:[],content:"{{selectedBrowser}}",enabled:true,
    constant:false,selective:false,caseSensitive:false,insertionOrder:100,sourceEnabled:true,worldInfo:{probability:50}},
    {index:1,name:"unvisited",keys:["missing"],secondaryKeys:[],content:"{{mustNotRun}}",enabled:true,
    constant:false,selective:false,caseSensitive:false,insertionOrder:90,sourceEnabled:true,worldInfo:{probability:50}}];
  const resolver=vi.fn(async(call:BrowserMacroCall)=>({content:call.content==="{{selectedBrowser}}"?"selected":call.content,local:call.local,global:call.global}));
  const result=await runMacroBoundary(session,new AbortController().signal,resolver,()=>matchLorebookEntries(card.id,entries,"Actor","trigger",500,{macroSession:session,random}));
  expect(result.results.map(entry=>entry.status)).toEqual(["injected","no_match"]);
  expect(random).toHaveBeenCalledTimes(1);expect(result.block).toBe("selected");
  expect(resolver.mock.calls.some(([call])=>call.content==="{{mustNotRun}}")).toBe(false);
  session.drawRandom(random);expect(random).toHaveBeenCalledTimes(2);
});
it("executes identical raw text separately by ordinal without replaying callbacks or variable effects", async () => {
  const session = new MacroEvaluationSession({ variables: { count: 0 } });
  const resolver = vi.fn(async (call: BrowserMacroCall) => ({ content: `value-${Number(call.local.count) + 1}`,
    local: { ...call.local, count: Number(call.local.count) + 1 }, global: call.global }));
  const result = await runMacroBoundary(session, new AbortController().signal, resolver, () => [
    session.evaluate("{{browserClosure}}", context), session.evaluate("{{browserClosure}}", context),
  ]);
  expect(result).toEqual(["value-1", "value-2"]); expect(resolver).toHaveBeenCalledTimes(2);
  expect(resolver.mock.calls.map(([call]) => call.ordinal)).toEqual([0, 1]);
  expect(session.local).toEqual({ count: 2 });
});

it.each(["error", "cancel"])("discards an uncommitted browser draft when the phase ends with %s", async mode => {
  const session = new MacroEvaluationSession({ variables: { count: 1 } }), controller = new AbortController();
  const resolver = vi.fn(async (call: BrowserMacroCall) => {
    if (call.ordinal === 1) { if (mode === "cancel") controller.abort(new Error("cancelled")); throw new Error("rejected"); }
    return { content: "done", local: { count: 2 }, global: call.global };
  });
  await expect(runMacroBoundary(session, controller.signal, resolver, () => {
    session.evaluate("first", context); return session.evaluate("second", context);
  })).rejects.toThrow();
  expect(session.local).toEqual({ count: 1 }); expect(session.changes()).toEqual([]);
});

it("uses browser expansion before history admission and never invokes a callback for older unvisited messages", async () => {
  const character = productCardForTests("Actor"), session = new MacroEvaluationSession();
  const options: PromptAssemblyOptions = { character, settings: { kind: "ollama", baseUrl: "http://provider.test/v1", model: "gpt-4o",
    maxTokens: 128, contextLimitTokens: 1024, temperature: 0.7, hasApiKey: false }, plugins: [], macroSession: session,
    prepareNativeCharacterFields: false, extensionSettings: { __mycompanion_power_user: { experimental_macro_engine: true } },
    memory: { conversationId: character.id, results: [], block: "", position: "before_recent_messages", budgetTokens: 500, injectedCount: 0, durationMs: 0 },
    lorebook: { characterId: character.id, results: [], block: "", constantBlock: "", position: "after_character_core", budgetTokens: 500, injectedCount: 0, durationMs: 0 },
    history: ["{{mustNotRun}}", "{{largeBrowserClosure}}", "latest"].map((content, index) => ({ id: crypto.randomUUID(), conversationId: character.id,
      branchId: character.id, parentMessageId: null, role: index === 1 ? "assistant" : "user", content, status: "complete", createdAt: new Date().toISOString() })) };
  const resolver = vi.fn(async (call: BrowserMacroCall) => ({ content: call.content === "{{largeBrowserClosure}}" ? "long ".repeat(5000) : call.content,
    local: call.local, global: call.global }));
  const actual = await runMacroBoundary(session, new AbortController().signal, resolver, () => assembleModelPrompt(options));
  expect(actual.messages.some(message => message.content === "latest")).toBe(true);
  expect(actual.messages.some(message => message.content.includes("long long"))).toBe(false);
  expect(resolver.mock.calls.some(([call]) => call.content === "{{mustNotRun}}")).toBe(false);
  expect(resolver.mock.calls.filter(([call]) => call.content === "{{largeBrowserClosure}}")).toHaveLength(1);
});
