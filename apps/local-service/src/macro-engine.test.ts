import { afterEach, expect, it, vi } from "vitest";
import { MacroEngine, MacroRegistry, createMacroEnvironment, MacroEnvironmentBuilder, env_provider_order } from "@mycompanion/macro-engine";

it("builds live isolated environments with ordered providers, lazy card fields and one-shot originals",()=>{
  const read=vi.fn(()=>"description"),fields={get description(){return read();},alternateGreetings:["Hi"]};
  let name="Actor";
  const builder=new MacroEnvironmentBuilder(()=>({name1:"Reader",name2:name,getGeneratingModel:()=>"model",getCharacterCardFieldsLazy:()=>fields}));
  const order:string[]=[];
  builder.registerProvider(env=>{order.push("late");env.extra.marker="late";},env_provider_order.LATE);
  builder.registerProvider(()=>{order.push("error");throw Error("provider fixture");});
  builder.registerProvider(env=>{order.push("early");env.extra.marker="early";},env_provider_order.EARLY);
  const logged=vi.spyOn(console,"error").mockImplementation(()=>{});
  const built=builder.buildFromRawEnv({content:"context",replaceCharacterCard:true,original:"once",dynamicMacros:{MixedCase:"value"}});
  expect(order).toEqual(["early","error","late"]);expect(logged).toHaveBeenCalledOnce();
  expect(read).not.toHaveBeenCalled();expect(built.character.description).toBe("description");expect(read).toHaveBeenCalledOnce();
  expect(built.system.model).toBe("model");expect(built.extra.marker).toBe("late");expect(built.dynamicMacros.mixedcase).toBe("value");
  expect(built.functions.original?.()).toBe("once");expect(built.functions.original?.()).toBe("");
  name="Other";expect(builder.buildFromRawEnv({content:"other"}).names.char).toBe("Other");expect(built.names.char).toBe("Actor");
});

const names: string[] = [];
afterEach(() => { for (const name of names.splice(0)) MacroRegistry.unregisterMacro(name); vi.restoreAllMocks(); });
const env = () => createMacroEnvironment("", { names: { user: "Reader", char: "Actor" } });

it("executes typed nested arguments, lists and aliases through the reused parser", () => {
  names.push("testPair", "pairAlias");
  const handler = vi.fn(({ unnamedArgs, list }) => unnamedArgs.join("/") + ":" + list.join(","));
  expect(MacroRegistry.registerMacro("testPair", { unnamedArgs: [{ name: "name" }, { name: "count", type: "integer" }], list: { min: 1, max: 2 }, handler })).not.toBeNull();
  expect(MacroRegistry.registerMacroAlias("testPair", "pairAlias")).toBe(true);
  expect(MacroEngine.evaluate("{{pairAlias::{{char}}::2::x::{{reverse::yz}}}}", env())).toBe("Actor/2:x,zy");
  expect(handler).toHaveBeenCalledOnce();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(MacroEngine.evaluate("{{testPair::Actor::invalid::x}}", env())).toBe("{{testPair::Actor::invalid::x}}");
  expect(handler).toHaveBeenCalledOnce(); expect(warning).toHaveBeenCalled();
});

it("evaluates only the chosen nested conditional branch and preserves scoped whitespace on request", () => {
  names.push("testEffect"); const effect = vi.fn(() => "CHOSEN");
  MacroRegistry.registerMacro("testEffect", { handler: effect });
  expect(MacroEngine.evaluate("{{if false}}{{testEffect}}{{else}}{{if true}}{{testEffect}}{{else}}wrong{{/if}}{{/if}}", env())).toBe("CHOSEN");
  expect(effect).toHaveBeenCalledOnce();
  expect(MacroEngine.evaluate("{{#if true}}  keep\n {{/if}}", env())).toBe("  keep\n ");
});

it("retains unknown macros, reports invalid registration, and keeps alias lookup behavior", () => {
  names.push("testLookup", "lookupAlias");
  MacroRegistry.registerMacro("testLookup", { handler: () => "OK" });
  MacroRegistry.registerMacroAlias("testLookup", "lookupAlias", { visible: false });
  expect(MacroRegistry.getAllMacros({ excludeHiddenAliases: true }).some(def => def.name === "lookupAlias")).toBe(false);
  expect(MacroRegistry.getPrimaryMacro("lookupAlias")?.name).toBe("testLookup");
  expect(MacroEngine.evaluate("{{unknown::{{char}}}}", env())).toBe("{{unknown::Actor}}");
  expect(MacroEngine.evaluate(String.raw`\{\{char\}\}`, env())).toBe("{{char}}");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(MacroRegistry.registerMacro("invalid name", { handler: () => "unreachable" })).toBeNull();
  expect(error).toHaveBeenCalled();
});

it("uses request-local dynamic macro definitions without leaking to the next environment", () => {
  expect(createMacroEnvironment("A").contentHash).not.toBe(createMacroEnvironment("B").contentHash);
  expect(createMacroEnvironment("A").contentHash).toBe(createMacroEnvironment("A").contentHash);
  const dynamic = createMacroEnvironment("", { dynamicMacros: { Wrap: { unnamedArgs: 1, handler: ({ unnamedArgs }: { unnamedArgs: string[] }) => "[" + unnamedArgs[0] + "]" } }, names: { char: "First" } });
  expect(MacroEngine.evaluate("{{wrap::{{char}}}}", dynamic)).toBe("[First]");
  expect(MacroEngine.evaluate("{{wrap::{{char}}}}", env())).toBe("{{wrap::Actor}}");
});

it("reads only card fields used by the chosen macro branch and resolves upstream aliases", () => {
  const description = vi.fn(() => "description"), personality = vi.fn(() => "personality");
  const fields = { get description() { return description(); }, get personality() { return personality(); } };
  const builder = new MacroEnvironmentBuilder(() => ({ name1: "Reader", name2: "Actor",
    getGeneratingModel: () => "model", getCharacterCardFieldsLazy: () => fields }));
  const built = builder.buildFromRawEnv({ content: "context", replaceCharacterCard: true });
  expect(MacroEngine.evaluate("plain text", built)).toBe("plain text");
  expect(description).not.toHaveBeenCalled(); expect(personality).not.toHaveBeenCalled();
  expect(MacroEngine.evaluate("{{if false}}{{charPersonality}}{{else}}{{description}}{{/if}}", built)).toBe("description");
  expect(description).toHaveBeenCalledOnce(); expect(personality).not.toHaveBeenCalled();
  const card = createMacroEnvironment("", { character: { charPrompt: "system", charInstruction: "phi",
    description: "desc", personality: "personality", scenario: "scenario", persona: "persona",
    mesExamplesRaw: "examples", charDepthPrompt: "depth", creatorNotes: "notes", version: "v5" } });
  const text = "{{charPrompt}}|{{charInstruction}}|{{charDescription}}/{{description}}|{{charPersonality}}/{{personality}}|" +
    "{{charScenario}}/{{scenario}}|{{persona}}|{{mesExamplesRaw}}|{{charDepthPrompt}}|{{charCreatorNotes}}/{{creatorNotes}}|" +
    "{{charVersion}}/{{version}}/{{char_version}}";
  expect(MacroEngine.evaluate(text, card)).toBe("system|phi|desc/desc|personality/personality|scenario/scenario|persona|examples|depth|notes/notes|v5/v5/v5");
  expect(MacroRegistry.getPrimaryMacro("creatorNotes")?.name).toBe("charCreatorNotes");
  expect(MacroRegistry.getAllMacros({ excludeHiddenAliases: true }).some(def => def.name === "version")).toBe(false);
});

it("selects indexed greetings without reading unrelated greeting fields and rejects invalid indices", () => {
  const main = vi.fn(() => "main"), alternates = vi.fn(() => ["first", "second"]);
  const card = createMacroEnvironment("", { character: {
    get firstMessage() { return main(); }, get alternateGreetings() { return alternates(); },
  } });
  expect(MacroEngine.evaluate("{{greeting}}", card)).toBe("main");
  expect(main).toHaveBeenCalledOnce(); expect(alternates).not.toHaveBeenCalled();
  main.mockClear();
  expect(MacroEngine.evaluate("{{charFirstMessage::2}}", card)).toBe("second");
  expect(main).not.toHaveBeenCalled(); expect(alternates).toHaveBeenCalledOnce();
  expect(MacroEngine.evaluate("{{greeting::3}}/{{greeting::-1}}", card)).toBe("/");
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  main.mockClear(); alternates.mockClear();
  expect(MacroEngine.evaluate("{{greeting::invalid}}", card)).toBe("{{greeting::invalid}}");
  expect(main).not.toHaveBeenCalled(); expect(alternates).not.toHaveBeenCalled(); expect(warning).toHaveBeenCalled();
});

it("formats dialogue examples through request-local host functions for chat and instruct contexts", () => {
  const parse = vi.fn((raw: string, instruct: boolean) => [raw + (instruct ? "-instruct" : "-chat"), "\nsecond"]);
  const format = vi.fn((examples: string[], user: string, char: string) => [user + ":" + examples[0], char + ":" + examples[1]]);
  const card = createMacroEnvironment("", { names: { user: "Reader", char: "Actor" },
    character: { mesExamplesRaw: "raw" }, extra: { parseMesExamples: parse, formatInstructModeExamples: format } });
  expect(MacroEngine.evaluate("{{mesExamplesRaw}}", card)).toBe("raw"); expect(parse).not.toHaveBeenCalled();
  expect(MacroEngine.evaluate("{{mesExamples}}", card)).toBe("raw-chat\nsecond");
  expect(parse).toHaveBeenLastCalledWith("raw", false); expect(format).not.toHaveBeenCalled();
  const instruct = createMacroEnvironment("", { names: { user: "New Reader", char: "New Actor" }, character: card.character,
    extra: { parseMesExamples: parse, isInstruct: true, formatInstructModeExamples: format } });
  expect(MacroEngine.evaluate("{{mesExamples}}", instruct)).toBe("New Reader:raw-instructNew Actor:\nsecond");
  expect(parse).toHaveBeenLastCalledWith("raw", true);
  expect(format).toHaveBeenLastCalledWith(["raw-instruct", "\nsecond"], "New Reader", "New Actor");
  expect(MacroEngine.evaluate("{{mesExamples}}", card)).toBe("raw-chat\nsecond");
});

it("does not silently return unformatted examples when their host formatter is unavailable", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(MacroEngine.evaluate("{{mesExamples}}", createMacroEnvironment("", { character: { mesExamplesRaw: "raw" } }))).toBe("{{mesExamples}}");
  expect(error).toHaveBeenCalled();
  error.mockClear();
  expect(MacroEngine.evaluate("{{mesExamples}}", createMacroEnvironment("", { character: { mesExamplesRaw: "" } }))).toBe("");
  expect(error).not.toHaveBeenCalled();
  const emptyParser = vi.fn(() => []);
  expect(MacroEngine.evaluate("{{mesExamples}}", createMacroEnvironment("", {
    character: { mesExamplesRaw: "raw" }, extra: { parseMesExamples: emptyParser, isInstruct: true },
  }))).toBe("");
  expect(emptyParser).toHaveBeenCalledWith("raw", true);
  expect(error).not.toHaveBeenCalled();
  expect(MacroEngine.evaluate("{{mesExamples}}", createMacroEnvironment("", {
    character: { mesExamplesRaw: "raw" }, extra: { parseMesExamples: () => ["parsed"], isInstruct: true },
  }))).toBe("{{mesExamples}}");
  expect(error).toHaveBeenCalled();
});
