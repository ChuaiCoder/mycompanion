import { expect, it } from "vitest";
import { createTavernRegexEngine, type TavernRegexScript, type TavernRegexSubstitute } from "./tavern-regex-core.js";
import { TavernRegexExecutor } from "./tavern-regex-service.js";
import { MacroEvaluationSession } from "./prompt-macros.js";
const engine = () => createTavernRegexEngine((text, escape = value => value, override) => text.replace(/{{(char|user)}}/gi, (_match, key: string) => escape(key.toLowerCase() === "char" ? override ?? "A+B" : "User")));
const rule = (changes: TavernRegexScript = {}): TavernRegexScript => ({findRegex:"/a/g",replaceString:"b",placement:[1],...changes});
it("keeps placement separate from destination, including dual-only rules and empty placements", () => {
  const core = engine(), input = [rule({promptOnly:true})];
  expect(core.getRegexedString("a",1,input)).toBe("a");
  expect(core.getRegexedString("a",1,input,{isPrompt:true})).toBe("b");
  expect(core.getRegexedString("a",2,input,{isPrompt:true})).toBe("a");
  expect(core.getRegexedString("a",1,[rule()],{isMarkdown:true})).toBe("a");
  expect(core.getRegexedString("a",1,[rule({placement:[]})])).toBe("a");
  for (const options of [{isPrompt:true},{isMarkdown:true}]) expect(core.getRegexedString("a",1,[rule({promptOnly:true,markdownOnly:true})],options)).toBe("b");
  for (const placement of [3,5,6]) expect(core.getRegexedString("a",1,[rule({placement:[placement]})])).toBe("a");
});
it("honors editing and inclusive depth bounds without treating null as zero", () => {
  const core = engine(), scripts = [rule({minDepth:1,maxDepth:2})];
  expect([0,1,2,3].map(depth=>core.getRegexedString("a",1,scripts,{depth}))).toEqual(["a","b","b","a"]);
  expect(core.getRegexedString("a",1,scripts)).toBe("b");
  expect(core.getRegexedString("a",1,[rule()],{isEdit:true})).toBe("a");
  expect(core.getRegexedString("a",1,[rule({runOnEdit:true,minDepth:null,maxDepth:null})],{isEdit:true,depth:10})).toBe("b");
});
it("handles full, numbered and named captures, trim strings and replacement macros", () => {
  const core=engine();
  expect(core.runRegexScript(rule({findRegex:"/(?<word>a!)(b)?/g",replaceString:"{{match}}|$0|$1|$2|$<word>|$99|{{char}}",trimStrings:["!"]}),"a!")).toBe("a|a|a||a||A+B");
  expect(core.runRegexScript(rule({findRegex:"/(A\\+B)/",replaceString:"$1",trimStrings:["{{char}}"]}),"A+B",{characterOverride:"A"})).toBe("+B");
});
it("preserves literal replacement dollars and never exposes callback offsets as captures", () => {
  expect(engine().runRegexScript(rule({findRegex:"/(a)/",replaceString:"$0:$1:$2:$3:$$:$&"}),"za")).toBe("za:a:::$$:$&");
});
it("supports raw or escaped macros in find patterns and resets cached sticky/global state", () => {
  const core=engine();
  expect(core.runRegexScript(rule({findRegex:"/{{char}}/g",substituteRegex:2}),"A+B AAB")).toBe("b AAB");
  expect(core.runRegexScript(rule({findRegex:"/{{char}}/g",substituteRegex:1}),"A+B AAB")).toBe("A+B b");
  const regex=core.RegexProvider.instance.get('/a/gy')!;regex.lastIndex=9;
  expect(core.RegexProvider.instance.get('/a/gy')?.lastIndex).toBe(0);
  core.RegexProvider.instance.clear();expect(core.RegexProvider.instance.get('/a/gy')).not.toBe(regex);
});
it("bare patterns replace once, explicit flags control matching, and invalid patterns leave input intact", () => {
  const core=engine();
  expect(core.runRegexScript(rule({findRegex:"a"}),"aa")).toBe("ba");
  expect(core.runRegexScript(rule({findRegex:"/a/g"}),"aa")).toBe("bb");
  expect(core.runRegexScript(rule({findRegex:"/[/g"}),"aa")).toBe("aa");
  expect(core.runRegexScript(rule({findRegex:"/a/invalid"}),"aa")).toBe("aa");
  expect(core.getRegexedString(null,1,[rule()])).toBe("");
});
it("applies rules in supplied order, ignoring unrelated order metadata and skipping disabled rules", () => {
  expect(engine().getRegexedString("a",1,[rule({order:9}),rule({findRegex:"b",replaceString:"c",order:0}),rule({findRegex:"c",replaceString:"wrong",disabled:true})])).toBe("c");
});
it("native worker uses the same capture/flag/destination contract without legacy size caps", async () => {
  const executor=new TavernRegexExecutor();
  try {
    expect(await executor.run("aa",1,[rule({findRegex:"a",replaceString:"{{match}}/{{char}}",promptOnly:true})],"Agent",{isPrompt:true})).toBe("a/Agenta");
    const pattern="a".repeat(5000);
    expect(await executor.run(pattern,1,[rule({findRegex:pattern,replaceString:"long"})],"Agent")).toBe("long");
  } finally { executor.close(); }
});
it("cancellation terminates pathological matching while later calls still succeed", async () => {
  const executor=new TavernRegexExecutor(), controller=new AbortController();
  const job=executor.run("a".repeat(60)+"!",1,[rule({findRegex:"^(a+)+$"})],"Agent",{},controller.signal);
  const rejection=expect(job).rejects.toThrow("user stop");
  const timer=setTimeout(()=>controller.abort(new Error("user stop")),100);
  try { await rejection; expect(await executor.run("a",1,[rule()],"Agent")).toBe("b"); }
  finally {clearTimeout(timer);executor.close();}
});
it("service shutdown interrupts pending regex work", async () => {
  const executor=new TavernRegexExecutor();
  const job=executor.run("a".repeat(60)+"!",1,[rule({findRegex:"^(a+)+$"})],"Agent");
  const rejection=expect(job).rejects.toThrow("closed");executor.close();await rejection;
  await expect(executor.run("a",1,[],"Agent")).rejects.toThrow("closed");
});

it.each([false, true])("evaluates full native macro context per real match with one mutable session (experimental=%s)", async experimentalMacroEngine => {
  const executor = new TavernRegexExecutor(), session = new MacroEvaluationSession({ variables: { count: "0", needle: "a" } });
  session.bindCharacterEnvironment({ characterFieldSources: { description: "Card description" } });
  const context = { characterName: "Agent", userName: "Alice", model: "test-model", experimentalMacroEngine };
  try {
    const output = await executor.run("a a", 1, [rule({ findRegex: "/{{getvar::needle}}/g", substituteRegex: 1,
      replaceString: "{{incvar::count}}/{{user}}/{{char}}/{{model}}/{{description}}" })], "Agent",
    { substitute: text => session.evaluate(text, context) });
    expect(output).toBe("1/Alice/Agent/test-model/Card description 2/Alice/Agent/test-model/Card description");
    expect(String(session.local.count)).toBe("2");
  } finally { executor.close(); }
});

it("shares side effects across sequential scripts instead of preparing all patterns up front", async () => {
  const executor = new TavernRegexExecutor(), session = new MacroEvaluationSession({ variables: { needle: "a", count: "0" } });
  const context = { characterName: "Agent", userName: "Alice", experimentalMacroEngine: true };
  try {
    const output = await executor.run("aa", 1, [
      rule({ replaceString: "{{setvar::needle::b}}{{incvar::count}}b" }),
      rule({ findRegex: "/{{getvar::needle}}/g", substituteRegex: 1, replaceString: "{{getvar::count}}" }),
    ], "Agent", { substitute: text => session.evaluate(text, context) });
    expect(output).toBe("1222"); expect(String(session.local.count)).toBe("2");
  } finally { executor.close(); }
});

it("runs find once and trim/replacement only for actual referenced captures, with the trim override", async () => {
  const executor = new TavernRegexExecutor(), calls: Array<{ text: string; override?: string }> = [];
  const substitute: TavernRegexSubstitute = (text, _escape, override) => {
    calls.push({ text, ...(override ? { override } : {}) }); return text === "{{trim}}" ? "!" : text;
  };
  try {
    const script = rule({ findRegex: "/(?<word>a!)(b)?/g", substituteRegex: 1, replaceString: "$1|$1|$2|$<word>|$99", trimStrings: ["{{trim}}"] });
    expect(await executor.run("a! a!", 1, [script], "Agent", { substitute, characterOverride: "Speaker" })).toBe("a|a||a| a|a||a|");
    expect(calls).toEqual([
      { text: script.findRegex! },
      ...Array.from({ length: 2 }, () => [
        { text: "{{trim}}", override: "Speaker" }, { text: "{{trim}}", override: "Speaker" }, { text: "{{trim}}", override: "Speaker" },
        { text: "a|a||a|" },
      ]).flat(),
    ]);
  } finally { executor.close(); }
});

it("does not execute replacement/trim macros for nonmatching, invalid, disabled or unrelated rules", async () => {
  const executor = new TavernRegexExecutor(), calls: string[] = [];
  const substitute: TavernRegexSubstitute = text => { calls.push(text); return text; };
  try {
    const scripts = [rule({ findRegex: "/nomatch/g", substituteRegex: 1 }), rule({ findRegex: "/[/g", substituteRegex: 1 }),
      rule({ disabled: true, findRegex: "disabled", substituteRegex: 1 }), rule({ placement: [2], findRegex: "other", substituteRegex: 1 }),
      rule({ markdownOnly: true, findRegex: "display", substituteRegex: 1 })];
    for (const script of scripts) { script.replaceString = "{{incvar::count}}$0"; script.trimStrings = ["{{incvar::trim}}"];
    }
    expect(await executor.run("a", 1, scripts, "Agent", { substitute })).toBe("a");
    expect(calls).toEqual(["/nomatch/g", "/[/g"]);
  } finally { executor.close(); }
});

it("escapes macro values in a find pattern while retaining the pattern's own syntax", async () => {
  const executor = new TavernRegexExecutor();
  const substitute: TavernRegexSubstitute = (text, escape = value => value) => text.replace(/{{user}}/g, () => escape("A+B"));
  try {
    expect(await executor.run("A+B AAB", 1, [rule({ findRegex: "/^{{user}}|{{user}}$/g", substituteRegex: 2 })], "Agent", { substitute })).toBe("b AAB");
    expect(await executor.run("A+B AAB", 1, [rule({ findRegex: "/^{{user}}|{{user}}$/g", substituteRegex: 1 })], "Agent", { substitute })).toBe("A+B b");
  } finally { executor.close(); }
});

it.each([
  { text: "😀a", findRegex: "/(?:)/gu", replaceString: "|" },
  { text: "a! b", findRegex: "/(?<first>a!)(?<optional>b)?/g", replaceString: "$0|$<first>|$<optional>" },
  { text: "aaa", findRegex: "/a/gy", replaceString: "{{match}}!" },
  { text: "za", findRegex: "/(a)/", replaceString: "$0:$1:$2:$3:$$:$&" },
])("matches the synchronous browser engine for $findRegex captures and offsets", async ({ text, findRegex, replaceString }) => {
  const executor = new TavernRegexExecutor(), script = rule({ findRegex, replaceString });
  const substitute: TavernRegexSubstitute = text => text;
  try { expect(await executor.run(text, 1, [script], "Agent", { substitute })).toBe(createTavernRegexEngine(substitute).getRegexedString(text, 1, [script])); }
  finally { executor.close(); }
});

it("retains the caller's persona when the full-context callback is absent", async () => {
  const executor = new TavernRegexExecutor();
  try { expect(await executor.run("a", 1, [rule({ replaceString: "{{user}}/{{char}}" })], "Agent", {}, undefined, "Alice")).toBe("Alice/Agent"); }
  finally { executor.close(); }
});

it("cancels during a long match list without executing later replacement side effects", async () => {
  const executor = new TavernRegexExecutor(), controller = new AbortController(); let replacements = 0;
  try {
    await expect(executor.run("a".repeat(2000), 1, [rule({ replaceString: "{{increment}}" })], "Agent", {
      substitute: text => { if (++replacements === 10) controller.abort(new Error("replacement stop")); return String(replacements); },
    }, controller.signal)).rejects.toThrow("replacement stop");
    expect(replacements).toBe(10);
    expect(await executor.run("a", 1, [rule()], "Agent")).toBe("b");
  } finally { executor.close(); }
});

it("cancels inside find expansion and recovers from macro callback errors", async () => {
  const executor = new TavernRegexExecutor(), controller = new AbortController();
  try {
    await expect(executor.run("a", 1, [rule({ substituteRegex: 1 })], "Agent", {
      substitute: text => { controller.abort(new Error("find stop")); return text; },
    }, controller.signal)).rejects.toThrow("find stop");
    await expect(executor.run("a", 1, [rule()], "Agent", { substitute: () => { throw new Error("macro failed"); } })).rejects.toThrow("macro failed");
    expect(await executor.run("a", 1, [rule()], "Agent")).toBe("b");
  } finally { executor.close(); }
});

it("finishes every match without truncating large replacements or leaking state between concurrent calls", async () => {
  const executor = new TavernRegexExecutor(); let first = 0, second = 0;
  try {
    const [large, small] = await Promise.all([
      executor.run("a".repeat(2000), 1, [rule()], "Agent", { substitute: () => String(++first) + "," }),
      executor.run("aa", 1, [rule()], "Agent", { substitute: () => String(++second) + "/" }),
    ]);
    expect(first).toBe(2000); expect(large).toBe(Array.from({ length: 2000 }, (_, index) => String(index + 1) + ",").join(""));
    expect(second).toBe(2); expect(small).toBe("1/2/");
  } finally { executor.close(); }
});
