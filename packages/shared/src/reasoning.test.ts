import { describe, expect, it } from "vitest";
import { extractReasoningFromData } from "./reasoning.js";

describe("reasoning response extraction", () => {
  it("uses provider field precedence without mixing visible text or alternative choices", () => {
    const response = { choices: [{ message: { content: "Visible answer", reasoning: "Router", reasoning_content: "Compatible" } }, { message: { reasoning_content: "Other choice" } }] };
    expect(extractReasoningFromData(response)).toBe("Compatible");
    expect(extractReasoningFromData(response, { chatCompletionSource: "openrouter" })).toBe("Router");
    expect(extractReasoningFromData(response, { chatCompletionSource: "deepseek" })).toBe("Compatible");
    expect(extractReasoningFromData(response, { chatCompletionSource: "xai" })).toBe("Compatible");
    response.choices[0]!.message.reasoning = "";
    expect(extractReasoningFromData(response, { chatCompletionSource: "openrouter" })).toBe("");
  });
  it("extracts only declared thought blocks from Claude, Gemini and Mistral", () => {
    expect(extractReasoningFromData({ content: [null, { type: "text", text: "Answer" }, { type: "thinking", thinking: "First" }, { type: "redacted_thinking", data: "secret" }, { type: "thinking", thinking: "Second" }] }, { chatCompletionSource: "claude" })).toBe("First\n\nSecond");
    for (const source of ["makersuite", "vertexai"]) {
      expect(extractReasoningFromData({ responseContent: { parts: [{ thought: true, text: "Thought" }, { text: "Answer" }, { thoughtSignature: "opaque", inlineData: { data: "image" } }] } }, { chatCompletionSource: source })).toBe("Thought");
    }
    expect(extractReasoningFromData({ choices: [{ message: { content: [{ thinking: [{ text: "First" }, {}, { text: "Second" }] }, { type: "text", text: "Answer" }] } }] }, { chatCompletionSource: "mistralai" })).toBe("First\n\nSecond");
  });
  it("supports native text-generation shapes and explicit thought visibility", () => {
    const response = { thinking: "Ollama", choices: [{ reasoning: "Router", message: { reasoning: "Compatible" } }] };
    expect(extractReasoningFromData(response, { mainApi: "textgenerationwebui", textGenType: "ollama" })).toBe("Ollama");
    expect(extractReasoningFromData(response, { mainApi: "textgenerationwebui", textGenType: "openrouter" })).toBe("Router");
    expect(extractReasoningFromData(response, { showThoughts: false })).toBe("");
    expect(extractReasoningFromData(response, { showThoughts: false, ignoreShowThoughts: true })).toBe("Compatible");
  });
  it("returns no thought text for unknown or malformed response formats", () => {
    for (const value of [null, "text", {}, { choices: {} }, { choices: [{ message: { reasoning: {} } }] }]) {
      expect(extractReasoningFromData(value)).toBe("");
    }
    expect(extractReasoningFromData({ choices: [{ message: { reasoning: "Hidden" } }] }, { chatCompletionSource: "unknown" })).toBe("");
    expect(extractReasoningFromData({ content: { type: "thinking" } }, { chatCompletionSource: "claude" })).toBe("");
  });
});
