import { runInNewContext } from "node:vm";
import type { ToolInvocationResult } from "@mycompanion/shared";
import { toolCallingRuntimeSource } from "./tool-calling-upstream.js";
import { toolRuntimeAdapterSource } from "./plugin-runtime-tools.js";

/** Executes the fixed original class rather than fabricating invocation results.
 * The real desktop runner separately verifies its original ESM imports and DOM. */
export function createToolTestRuntime() {
  const context: Record<string, unknown> = {};
  const bindings = { console: {log() {}, warn() {}, error() {}}, toastr: {info() {}, clear() {}},
    Error, Promise, AbortController, structuredClone, Set, Map, main_api: "openai",
    oai_settings: {function_calling: true, custom_prompt_post_processing: "", chat_completion_source: "custom"},
    model_list: [], chat_completion_sources: {CUSTOM: "custom", OPENAI: "openai", AZURE_OPENAI: "azure_openai"},
    custom_prompt_post_processing_types: {NONE: "", MERGE_TOOLS: "merge_tools", SEMI_TOOLS: "semi_tools", STRICT_TOOLS: "strict_tools"},
    getChatCompletionModel: () => "fixture", getContext: () => context };
  const ToolManager = runInNewContext(toolCallingRuntimeSource.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "") + "\nToolManager", bindings);
  const adapter = runInNewContext(toolRuntimeAdapterSource.replace(/^import .*;\r?\n/gm, "").replace(/^export \{.*\};\r?\n/gm, "").replace(/^export /gm, "")
    + "\n({runToolEffect})", {...bindings, ToolManager});
  return { ToolManager, run: (evaluation: {payload: unknown}, signal: AbortSignal): Promise<ToolInvocationResult> => adapter.runToolEffect({evaluation}, signal) };
}
