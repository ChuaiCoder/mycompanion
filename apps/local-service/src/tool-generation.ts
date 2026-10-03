import { toolInvocationResultSchema, type ModelResponseState, type ToolInvocationResult } from "@mycompanion/shared";
import { ModelRequestError } from "./model-request-error.js";

export interface ToolContinuation {
  messages: Array<Record<string, unknown>>;
  shouldContinue: boolean;
  invocations: ToolInvocationResult["invocations"];
  stealthCalls: string[];
}

/** Uses the completed response's call identities. Two identical tool names or
 * argument strings still represent distinct actions when their IDs differ. */
export function createToolContinuation(state: ModelResponseState, assistantText: string, rawResult: unknown): ToolContinuation {
  const parsed = toolInvocationResultSchema.safeParse(rawResult);
  if (!parsed.success) throw new ModelRequestError("扩展返回了无效的工具执行结果。", 502);
  const result = parsed.data, calls = state.toolCalls;
  if (calls.some(call => !call.id || !call.function.name) || new Set(calls.map(call => call.id)).size !== calls.length)
    throw new ModelRequestError("模型返回了无效或重复的工具调用标识。", 502);
  const seen = new Set<string>();
  for (const invocation of result.invocations) {
    const call = calls.find(item => item.id === invocation.id);
    if (!call || call.function.name !== invocation.name || call.function.arguments !== invocation.parameters || seen.has(invocation.id))
      throw new ModelRequestError("工具执行结果与当前模型调用不一致。", 502);
    seen.add(invocation.id);
  }
  const stealthRemaining = [...result.stealthCalls];
  for (const call of calls.filter(item => !seen.has(item.id))) {
    const index = stealthRemaining.indexOf(call.function.name);
    if (index < 0) throw new ModelRequestError("工具执行结果缺少当前调用。", 502);
    stealthRemaining.splice(index, 1);
  }
  if (stealthRemaining.length) throw new ModelRequestError("工具执行结果包含未知调用。", 502);
  // Fixed Tavern stops this turn when any stealth call ran. Its action still
  // executes, but there is no saved tool message or follow-up generation.
  if (!calls.length || result.stealthCalls.length) return { messages: [], shouldContinue: false, invocations: [], stealthCalls: result.stealthCalls };

  const clone = <T>(value: T): T => structuredClone(value);
  let assistant: Record<string, unknown>, responses: Array<Record<string, unknown>>;
  if (state.protocol === "claude") {
    const blocks = state.providerContent.length ? clone(state.providerContent) : [
      ...(assistantText ? [{type: "text", text: assistantText}] : []),
      ...calls.map(call => {
        let input: unknown;
        try { input = JSON.parse(call.function.arguments || "{}"); }
        catch { throw new ModelRequestError("Claude 返回了无效的工具参数。", 502); }
        return {type: "tool_use", id: call.id, name: call.function.name, input};
      }),
    ];
    assistant = {role: "assistant", content: blocks};
    responses = [{role: "user", content: result.invocations.map(invocation => ({
      type: "tool_result", tool_use_id: invocation.id, content: invocation.result,
      ...(invocation.error ? {is_error: true} : {}),
    }))}];
  } else if (state.protocol === "gemini") {
    const parts = state.providerContent.length ? clone(state.providerContent) : [
      ...(assistantText ? [{text: assistantText}] : []),
      ...calls.map(call => {
        let args: unknown;
        try { args = JSON.parse(call.function.arguments || "{}"); }
        catch { throw new ModelRequestError("Gemini 返回了无效的工具参数。", 502); }
        return {functionCall: {id: call.id, name: call.function.name, args}, ...(call.signature ? {thoughtSignature: call.signature} : {})};
      }),
    ];
    assistant = {role: "assistant", content: parts.map(part => ({type: "provider_native", part}))};
    responses = [{role: "user", content: result.invocations.map(invocation => ({type: "provider_native", part: {
      functionResponse: {id: invocation.id, name: invocation.name, response: {[invocation.error ? "error" : "result"]: invocation.result}},
    }}))}];
  } else {
    assistant = {role: "assistant", content: assistantText, tool_calls: clone(calls),
      ...(state.reasoning ? {reasoning_content: state.reasoning} : {}), ...(state.signature ? {signature: state.signature} : {})};
    responses = result.invocations.map(invocation => ({role: "tool", tool_call_id: invocation.id, content: invocation.result}));
  }
  return {messages: [assistant, ...responses], shouldContinue: true, invocations: result.invocations, stealthCalls: []};
}
