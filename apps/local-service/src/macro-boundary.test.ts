import { expect, it, vi } from "vitest";
import { MacroEvaluationSession } from "./prompt-macros.js";
import { runMacroBoundary, type BrowserMacroCall, type BrowserEffectCall } from "./macro-boundary.js";
import { assembleModelPrompt } from "./model-client.js";
import type { PromptAssemblyOptions } from "./model-client.js";
import { productCardForTests } from "./macro-boundary-test-helper.js";
import { matchLorebookEntries } from "./worldbook-engine.js";
import { browserMacroHarness } from "./browser-macro-test-helper.js";

const context = { characterName: "Actor", userName: "User", model: "gpt-4o" };
it.each([false, true])("sends dynamic continue macros through the actual served browser responder with experimental=%s",async experimentalMacroEngine=>{
  const harness=browserMacroHarness(),session=new MacroEvaluationSession({variables:{count:0}});
  session.bindCharacterEnvironment({characterFieldSources:{description:"card"}});
  const dynamicMacros={lastChatMessage:"{{incvar::count}} {{char}} {{maxResponse}}",description:"{{char}}",char:"Override"};
  const options={...context,experimentalMacroEngine,dynamicMacros,contextLimitTokens:1024,maxResponseTokens:128};
  const calls:BrowserMacroCall[]=[];
  const result=await runMacroBoundary(session,new AbortController().signal,async call=>{
    calls.push(call);
    expect(call.context.dynamicMacros).toEqual(dynamicMacros);
    expect(call.context.dynamicMacros).not.toBe(dynamicMacros);
    return harness.evaluateBrowserMacro({conversationId:null,branchId:null,evaluation:call});
  },()=>[session.evaluate("{{incvar::count}}/{{lastChatMessage}}",options),session.evaluate("{{description}}",options)]);
  expect(result).toEqual(["1/{{incvar::count}} {{char}} "+(experimentalMacroEngine?"{{maxResponse}}":"128"),experimentalMacroEngine?"{{char}}":"Override"]);
  expect(calls).toHaveLength(2);expect(session.local.count).toBe(1);
  expect(harness.context.chatMetadata.variables).toBeUndefined();expect(harness.localSave).not.toHaveBeenCalled();
});
it("rejects changed dynamic input during boundary replay",async()=>{
  const session=new MacroEvaluationSession(),dynamicMacros={lastChatMessage:"before"};
  await expect(runMacroBoundary(session,new AbortController().signal,async call=>{
    dynamicMacros.lastChatMessage="after";return {content:"before",local:call.local,global:call.global};
  },()=>session.evaluate("{{lastChatMessage}}",{...context,dynamicMacros}))).rejects.toThrow("宏求值阶段在等待期间发生变化");
});
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
it("awaits invocation effects once per ordinal across later macro replay, preserving the same variable draft", async () => {
  const session = new MacroEvaluationSession({ variables: { count: 0 } });
  const effects = vi.fn(async (call: BrowserEffectCall) => ({ payload: { step: call.ordinal }, local: { count: Number(call.local.count) + 1 }, global: call.global }));
  const macros = vi.fn(async (call: BrowserMacroCall) => ({ content: String(call.local.count), local: call.local, global: call.global }));
  const value = await runMacroBoundary(session, new AbortController().signal, macros, () => {
    const first = session.invokeEffect("world-info-scan", { loop: 1 });
    const middle = session.evaluate("macro after listener", context);
    const second = session.invokeEffect("world-info-scan", { loop: 2 });
    const last = session.evaluate("macro after next listener", context);
    return { first, middle, second, last };
  }, effects);
  expect(value).toEqual({ first: { step: 0 }, middle: "1", second: { step: 1 }, last: "2" });
  expect(effects).toHaveBeenCalledTimes(2); expect(macros).toHaveBeenCalledTimes(2);
  expect(session.local).toEqual({ count: 2 }); expect(session.invokeEffect("after phase", {})).toBeUndefined();
});
it("discards native invocation drafts when an awaited effect is cancelled and observes its late rejection", async () => {
  const session = new MacroEvaluationSession({ variables: { count: 1 } }), controller = new AbortController();
  let rejectLate!:(reason: Error)=>void;
  const running = runMacroBoundary(session, controller.signal, async call => ({ content: call.content, local: call.local, global: call.global }),
    () => session.invokeEffect("world-info-scan", { loop: 1 }), () => new Promise((_resolve, reject) => { rejectLate = reject; }));
  controller.abort(new Error("effect cancelled"));
  await expect(running).rejects.toThrow("effect cancelled"); rejectLate(new Error("late resolver failure"));
  await Promise.resolve(); expect(session.local).toEqual({ count: 1 }); expect(session.changes()).toEqual([]);
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
