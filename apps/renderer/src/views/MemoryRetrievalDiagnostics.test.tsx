import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import i18n from "../i18n";
import { memoryText } from "../diagnostic-translations";
import { MemoryRetrievalDiagnostics } from "./MemoryRetrievalDiagnostics";

beforeEach(async () => { await i18n.changeLanguage("zh"); });
afterEach(cleanup);
it("localizes fallback reasons and live index numbers without changing model or user text", async () => {
  render(<MemoryRetrievalDiagnostics retrieval={{ mode: "keyword", embeddingModel: "用户自选模型", indexedCount: 0, pendingCount: 7, threshold: .25,
    diagnostics: ["Embedding 请求失败，本轮已降级为关键词检索。", "关键词与语义联合检索；0/7 条普通记忆已索引；语义查询使用末尾 8,000 字符。"] }} />);
  await act(() => i18n.changeLanguage("en"));
  expect(screen.getByText("Advanced retrieval diagnostics")).toBeInTheDocument();
  expect(screen.getByText("0 indexed, 7 pending")).toBeInTheDocument();
  expect(screen.getByText("用户自选模型")).toBeInTheDocument();
  expect(screen.getByText("The embedding request failed. This turn falls back to keywords.")).toBeInTheDocument();
  expect(screen.getByText("Keywords and semantic retrieval; 0/7 ordinary memories indexed; the semantic query uses the last 8,000 characters.")).toBeInTheDocument();
});
it("retains diagnostic quantities and user terms while explaining exclusions in English", () => {
  expect(memoryText("en", "关键词命中：星塔、北方；相关度 75%。")).toBe("Matched keywords: 星塔、北方; relevance 75%.");
  expect(memoryText("en", "超出 120 token 固定记忆预算被舍弃（约 42 token）。")).toBe("Excluded from the pinned memory budget of 120 tokens (approximately 42 tokens).");
  expect(memoryText("en", "最终提示词预算裁剪，未发送到模型。")).toBe("Removed to fit the final prompt budget; not sent to the model.");
  expect(memoryText("en", "模型返回的自由说明")).toBe("模型返回的自由说明");
  expect(memoryText("en", "constructor")).toBe("constructor");
});
