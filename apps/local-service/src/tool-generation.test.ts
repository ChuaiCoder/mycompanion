import { describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { type ModelResponseState } from "@mycompanion/shared";
import { createToolContinuation } from "./tool-generation.js";
import { providerRequestBody } from "./provider-transport.js";
import { toolCallingRuntimeSource } from "./tool-calling-upstream.js";
import { toolRuntimeAdapterSource } from "./plugin-runtime-tools.js";

const state = (protocol: ModelResponseState["protocol"] = "openai"): ModelResponseState => ({protocol, reasoning: "", signature: "", media: [], providerContent: [],
  toolCalls: [{id: "call_a", type: "function", function: {name: "weather", arguments: '{"city":"北京"}'}}]});
const success = () => ({invocations: [{id: "call_a", name: "weather", parameters: '{"city":"北京"}', result: '{"temperature":20}', error: false}], errors: [], stealthCalls: []});
function harness() {
  const context: Record<string, unknown> = {}, console = {log: vi.fn(), warn: vi.fn(), error: vi.fn()}, toastr = {info: vi.fn(), clear: vi.fn()};
  const settings = {function_calling: true, custom_prompt_post_processing: "", chat_completion_source: "custom"};
  const bindings = {console, toastr, Error, Promise, AbortController, structuredClone, Set, Map,
    main_api: "openai", oai_settings: settings, model_list: [], chat_completion_sources: {CUSTOM: "custom", OPENAI: "openai", AZURE_OPENAI: "azure_openai"},
    custom_prompt_post_processing_types: {NONE: "", MERGE_TOOLS: "merge_tools", SEMI_TOOLS: "semi_tools", STRICT_TOOLS: "strict_tools"},
    getChatCompletionModel: () => "fixture", getContext: () => context};
  const ToolManager = runInNewContext(toolCallingRuntimeSource.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "") + "\nToolManager", bindings);
  const adapter = runInNewContext(toolRuntimeAdapterSource.replace(/^import .*;\r?\n/gm, "").replace(/^export \{.*\};\r?\n/gm, "").replace(/^export /gm, "")
    + "\n({runToolEffect,registerNativeTools})", {...bindings, ToolManager});
  return {ToolManager, adapter, settings};
}

describe("actual fixed ToolManager and native continuation data", () => {
  it("registers async eligibility and executes JSON callbacks with real result and error conversion", async () => {
    const {ToolManager} = harness();
    ToolManager.registerFunctionTool({name: "weather", description: "weather", parameters: {type: "object"}, action: ({city}: {city: string}) => ({city, temperature: 20}), shouldRegister: async () => true});
    ToolManager.registerFunctionTool({name: "disabled", description: "skip", parameters: {}, action: () => "unexpected", shouldRegister: async () => false});
    const request: Record<string, unknown> = {}; await ToolManager.registerFunctionToolsOpenAI(request);
    expect(request).toMatchObject({tool_choice: "auto", tools: [{type: "function", function: {name: "weather"}}]});
    expect(request.tools).toHaveLength(1);
    const result = await ToolManager.invokeFunctionTools([[state().toolCalls[0]]]);
    expect(result.invocations[0]).toMatchObject({id: "call_a", result: '{"city":"北京","temperature":20}', error: false});
    ToolManager.unregisterFunctionTool("weather");
    expect((await ToolManager.invokeFunctionTools([[state().toolCalls[0]]])).invocations[0]).toMatchObject({error: true});
    expect(ToolManager.RECURSE_LIMIT).toBe(5);
    for (const type of ["quiet", "continue", "impersonate"]) expect(ToolManager.canPerformToolCalls(type)).toBe(false);
  });
  it("keeps identical tool names at different IDs as two actual sequential actions", async () => {
    const {ToolManager, adapter} = harness(), seen: string[] = [];
    ToolManager.registerFunctionTool({name: "weather", parameters: {}, action: async ({city}: {city: string}) => {seen.push(city); return city;}});
    const response = state(); response.toolCalls.push({...response.toolCalls[0]!, id: "call_b"});
    const result = await adapter.runToolEffect({evaluation: {payload: {state: response}}}, new AbortController().signal);
    expect(seen).toEqual(["北京", "北京"]); expect(result.invocations.map((item: {id: string}) => item.id)).toEqual(["call_a", "call_b"]);
    expect(createToolContinuation(response, "", result).messages).toHaveLength(3);
  });
  it("stops a pending action from dispatching the next callback after cancellation", async () => {
    const {ToolManager, adapter} = harness(), invoked = vi.fn(); let release!: () => void;
    ToolManager.registerFunctionTool({name: "weather", parameters: {}, action: () => {invoked(); return new Promise<void>(resolve => {release = resolve;});}});
    const response = state(); response.toolCalls.push({...response.toolCalls[0]!, id: "call_b"});
    const controller = new AbortController();
    const running = adapter.runToolEffect({evaluation: {payload: {state: response}}}, controller.signal);
    await vi.waitFor(() => expect(invoked).toHaveBeenCalledTimes(1));
    const rejected = expect(running).rejects.toThrow("fixture cancelled"); controller.abort(new Error("fixture cancelled")); await rejected;
    release(); await Promise.resolve(); expect(invoked).toHaveBeenCalledTimes(1);
  });
  it("executes stealth tools but produces neither a result message nor follow-up generation", async () => {
    const {ToolManager, adapter} = harness(), action = vi.fn(() => "private result");
    ToolManager.registerFunctionTool({name: "weather", parameters: {}, action, stealth: true});
    const result = await adapter.runToolEffect({evaluation: {payload: {state: state()}}}, new AbortController().signal);
    expect(action).toHaveBeenCalledOnce();
    expect(createToolContinuation(state(), "", result)).toMatchObject({shouldContinue: false, invocations: [], messages: [], stealthCalls: ["weather"]});
  });
  it("validates round IDs, names and parameters before accepting returned tool data", () => {
    for (const patch of [{id: "other"}, {name: "other"}, {parameters: "{}"}]) {
      const result = success(); Object.assign(result.invocations[0]!, patch);
      expect(() => createToolContinuation(state(), "", result)).toThrow(/不一致/);
    }
    const duplicate = state(); duplicate.toolCalls.push(duplicate.toolCalls[0]!);
    expect(() => createToolContinuation(duplicate, "", success())).toThrow(/重复/);
    expect(() => createToolContinuation(state(), "", {invocations: [], errors: [], stealthCalls: []})).toThrow(/缺少/);
    const bad = success(); bad.invocations[0]!.result = {secret: "unexpected object"} as unknown as string;
    expect(() => createToolContinuation(state(), "", bad)).toThrow(/无效/);
  });
  it("writes a real OpenAI tool-result message, including failures, without mutating the reply", () => {
    const response = state(), before = structuredClone(response), result = success();
    result.invocations[0]!.error = true; result.invocations[0]!.result = "Error: callback failed";
    const continuation = createToolContinuation(response, "Checking…", result);
    expect(continuation.messages).toEqual([{role: "assistant", content: "Checking…", tool_calls: response.toolCalls}, {role: "tool", tool_call_id: "call_a", content: "Error: callback failed"}]);
    expect(response).toEqual(before); expect(continuation.shouldContinue).toBe(true);
  });
  it("replays exact Claude signed blocks and matched tool results through its real wire converter", () => {
    const response = state("claude"); response.providerContent = [{type: "thinking", thinking: "reasoning", signature: "signed-original"},
      {type: "text", text: "Checking…"}, {type: "tool_use", id: "call_a", name: "weather", input: {city: "北京"}}];
    const continuation = createToolContinuation(response, "Checking…", success());
    const wire = providerRequestBody("claude", {model: "claude-fixture", messages: [{role: "user", content: "weather?"}, ...continuation.messages],
      tools: [{type: "function", function: {name: "weather", parameters: {type: "object"}}}], max_tokens: 1024});
    expect((wire.messages as Array<{content: unknown}>)[1]!.content).toEqual(response.providerContent);
    expect((wire.messages as Array<{content: unknown}>)[2]!.content).toEqual([{type: "tool_result", tool_use_id: "call_a", content: '{"temperature":20}'}]);
  });
  it("replays Gemini thought signatures and named function responses without a fabricated tool-name map", () => {
    const response = state("gemini"); response.providerContent = [{functionCall: {id: "call_a", name: "weather", args: {city: "北京"}}, thoughtSignature: "signed-original"}];
    const continuation = createToolContinuation(response, "", success());
    const wire = providerRequestBody("gemini", {model: "gemini-2.5-flash", messages: [{role: "user", content: "weather?"}, ...continuation.messages], max_tokens: 1024});
    expect((wire.contents as Array<{parts: unknown}>)[1]!.parts).toEqual(response.providerContent);
    expect((wire.contents as Array<{parts: unknown}>)[2]!.parts).toEqual([{functionResponse: {id: "call_a", name: "weather", response: {result: '{"temperature":20}'}}}]);
  });
});
