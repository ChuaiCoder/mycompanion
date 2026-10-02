import { expect, it, vi } from "vitest";
import type { CharacterDetail, MemoryRetrievalResult } from "@mycompanion/shared";
import { buildApp } from "./app.js";
import { apps } from "./test-helpers.js";
import { assembleModelPrompt, streamReply, type PromptAssemblyOptions } from "./model-client.js";
import { countCompatibilityMessagesSync } from "./tokenizer-service.js";

async function fixture(managed: boolean): Promise<PromptAssemblyOptions> {
  const app = buildApp(); apps.push(app);
  const avatar = (await app.inject({ method: "POST", url: "/api/characters/create", payload: { ch_name: "Memory actor", first_mes: "Hello" } })).body;
  const wire = (await app.inject({ method: "POST", url: "/api/characters/get", payload: { avatar_url: avatar } })).json<{ id: string }>();
  const character = (await app.inject({ method: "GET", url: `/api/characters/${wire.id}` })).json<CharacterDetail>();
  return { character, settings: { kind: "ollama", baseUrl: "http://provider.test/v1", model: "gpt-4o", maxTokens: 128,
    contextLimitTokens: 4096, temperature: 0.7, hasApiKey: false }, plugins: [], history: [{ id: crypto.randomUUID(), conversationId: crypto.randomUUID(),
    branchId: crypto.randomUUID(), parentMessageId: null, role: "user", status: "complete", content: "CURRENT_INPUT", createdAt: new Date().toISOString() }],
    lorebook: { characterId: character.id, results: [], block: "", constantBlock: "", position: "after_character_core", budgetTokens: 500, injectedCount: 0, durationMs: 0 },
    memory: { conversationId: crypto.randomUUID(), results: [], block: "", position: "before_recent_messages", budgetTokens: 500, injectedCount: 0, durationMs: 0 },
    extensionSettings: managed ? { __mycompanion_openai: { settings: { prompts: [{ identifier: "main", content: "MAIN", role: "system", system_prompt: true },
      { identifier: "chatHistory", system_prompt: true, marker: true }], prompt_order: [{ character_id: 100001,
      order: [{ identifier: "main", enabled: true }, { identifier: "chatHistory", enabled: true }] }] } } } : {} };
}
const memory = (content: string, score: number, pinned = false): MemoryRetrievalResult => ({ memoryId: crypto.randomUUID(),
  type: "fact", scope: "story", score, pinned, injected: true, content, tokens: 0, diagnostics: [] });

it.each([false, true])("trims ordinary memories individually and reports only final retained IDs (managed=%s)", async managed => {
  const options = await fixture(managed), pinned = memory("PINNED_FACT", 0, true), high = memory("HIGH_RELEVANCE_FACT", 100), low = memory("low ".repeat(100), 1);
  options.memory.results = [pinned, high];
  const sufficient = assembleModelPrompt(options);
  options.settings.contextLimitTokens = sufficient.budget.totalTokens;
  options.memory.results = [pinned, high, low];
  const result = assembleModelPrompt(options), content = JSON.stringify(result.messages);
  expect(result.budget.retainedMemoryIds).toEqual([pinned.memoryId, high.memoryId]);
  expect(content).toContain("PINNED_FACT"); expect(content).toContain("HIGH_RELEVANCE_FACT"); expect(content).not.toContain(low.content);
  expect(result.budget.regions.find(region => region.key === "memory_pinned")?.content).toContain("PINNED_FACT");
  expect(result.budget.totalTokens).toBe(countCompatibilityMessagesSync(result.messages.map(message => ({ ...message })), "gpt-4o", true) + result.budget.reserveTokens);
});

it.each([false, true])("rejects an over-budget pinned memory before provider transport (managed=%s)", async managed => {
  const options = await fixture(managed), pinned = memory("fixed ".repeat(2000), 0, true);
  options.settings.contextLimitTokens = 1024; options.memory.results = [pinned];
  const result = assembleModelPrompt(options);
  expect(result.budget.retainedMemoryIds).toContain(pinned.memoryId);
  expect(result.budget.totalTokens).toBeGreaterThan(1024);
  expect(result.budget.diagnostics.some(text => text.includes("固定记忆"))).toBe(true);
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(streamReply({ ...options, dryRun: true, onDelta: () => {} })).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

it("does not claim memories were sent when a managed preset omits chat history", async () => {
  const options = await fixture(true);
  const settings = options.extensionSettings!.__mycompanion_openai as { settings: { prompt_order: Array<{ order: Array<{ identifier: string; enabled: boolean }> }> } };
  settings.settings.prompt_order[0]!.order[1]!.enabled = false;
  options.memory.results = [memory("UNSENT_MEMORY", 1, true)];
  const result = assembleModelPrompt(options);
  expect(result.budget.retainedMemoryIds).toEqual([]); expect(JSON.stringify(result.messages)).not.toContain("UNSENT_MEMORY");
});
