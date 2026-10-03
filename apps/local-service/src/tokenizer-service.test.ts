import { expect, it } from "vitest";
import { countCompatibilityMessages, countTextTokens, tokenizerFor } from "./tokenizer-service.js";

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
it("uses the requested provider model for text counts and honors unknown-model estimation", async () => {
  expect(countTextTokens("お誕生日おめでとう", "gpt-4")).toBe(9);
  expect(countTextTokens("お誕生日おめでとう", "gpt-4o")).toBe(8);
  expect((await tokenizerFor("local-model")).estimated).toBe(true);
  expect(countTextTokens("", "gpt-4")).toBe(0);
});
