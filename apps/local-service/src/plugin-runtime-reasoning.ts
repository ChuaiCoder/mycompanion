import { extractReasoningFromData } from "@mycompanion/shared";

// The helper supplies mainApi/source explicitly. Defaults use this application's
// OpenAI-compatible connection (including Ollama's /v1) with thoughts available;
// ST's provider settings and streaming reasoning UI remain separate work.
export const reasoningRuntimeSource = `export const extractReasoningFromData = ${extractReasoningFromData.toString()};`;
