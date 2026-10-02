import { afterEach, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { countCompatibilityMessages, tokenizerFor } from "./tokenizer-service.js";
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });

it("matches known BPE vectors for English, Japanese and literal special-token text", async () => {
  const cl = await tokenizerFor("gpt-4"), modern = await tokenizerFor("gpt-4o");
  expect(cl.estimated).toBe(false); expect(modern.estimated).toBe(false);
  expect(cl.count("antidisestablishmentarianism")).toBe(6);
  expect(cl.count("お誕生日おめでとう")).toBe(9);
  expect(modern.count("お誕生日おめでとう")).toBe(8);
  expect(cl.count("<|endoftext|>")).toBeGreaterThan(1);
  expect(cl.count("")).toBe(0);
});
it("counts Tavern message framing and names and exposes unknown-model estimation", async () => {
  expect((await countCompatibilityMessages([{ content: "hello" }], "gpt-4", true)).token_count).toBe(7);
  expect((await countCompatibilityMessages([{ role: "user", content: "hello" }], "gpt-4")).token_count).toBe(6);
  expect((await countCompatibilityMessages([{ role: "user", content: "hello", name: "Alice" }], "gpt-4")).token_count).toBe(8);
  const fallback = await tokenizerFor("__proto__");
  expect(fallback.encoding).toBe("cl100k_base"); expect(fallback.estimated).toBe(true);
  expect((await countCompatibilityMessages([{ role: "user", content: "hello" }], "local-model")).estimated).toBe(true);
});
it("uses the current provider model on every request and validates count inputs", async () => {
  const app = buildApp(); apps.push(app);
  const post = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/extensions/token-count", payload });
  const configure = (model: string) => app.inject({ method: "PUT", url: "/api/settings/provider", payload: { kind: "ollama", baseUrl: "http://localhost:9999/v1", model } });
  await configure("gpt-4"); expect((await post({ text: "お誕生日おめでとう" })).json().token_count).toBe(9);
  await configure("gpt-4o"); expect((await post({ text: "お誕生日おめでとう" })).json().token_count).toBe(8);
  await configure("local-model"); expect((await post({ text: "hello" })).json().estimated).toBe(true);
  expect((await post({ messages: [{ content: "hello" }], full: true })).json().token_count).toBe(7);
  for (const payload of [{}, {text: "hello", messages: []}, {messages: [null]}]) expect((await post(payload)).statusCode).toBe(400);
});
