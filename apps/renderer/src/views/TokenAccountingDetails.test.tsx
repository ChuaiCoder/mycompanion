import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import i18n from "../i18n";
import type { TokenAccounting } from "@mycompanion/shared";
import { MessageTokenUsage } from "./TokenAccountingDetails";
afterEach(cleanup);
beforeEach(async () => { await i18n.changeLanguage("zh"); });
const accounting: TokenAccounting = { method: "tavern-compatibility", model: "unknown-model", encoding: "fallback",
  estimated: true, textEstimated: true, framingEstimated: true, mediaEstimated: false, complete: false,
  promptTokens: 20, mediaTokens: 0, reasons: ["unknown-model", "audio-not-counted"] };
it("compares reported input with local prompt input and exposes uncounted content without using the output reserve", () => {
  render(<MessageTokenUsage metadata={{ model: "unknown-model", temperature: 0, maxTokens: 500, tokenAccounting: accounting,
    usage: { source: "provider-reported", inputTokens: 23, outputTokens: 7, totalTokens: 30 } }} />);
  expect(screen.getByText("提供商输入与本地输入估算的差额：+3 token。")).toBeInTheDocument();
  expect(screen.getByText("音频尚未计入本地估算。")).toBeInTheDocument();
  expect(screen.getByText("部分请求内容未计入，当前估算不完整。")).toBeInTheDocument();
  expect(document.body.textContent).not.toContain("500");
  expect(document.querySelector('.message-token-usage[open]')).toBeNull();
});
it("keeps a zero reported count visible and omits comparison when the provider omits input usage", () => {
  const { rerender } = render(<MessageTokenUsage metadata={{ model: "fixture", temperature: 0, maxTokens: 100,
    tokenAccounting: accounting, usage: { source: "provider-reported", inputTokens: 0, outputTokens: 0 } }} />);
  expect(screen.getAllByText("0 token")).toHaveLength(2);
  expect(screen.getByText("提供商输入与本地输入估算的差额：-20 token。")).toBeInTheDocument();
  rerender(<MessageTokenUsage metadata={{ model: "fixture", temperature: 0, maxTokens: 100,
    tokenAccounting: accounting, usage: { source: "provider-reported", outputTokens: 7 } }} />);
  expect(screen.queryByText(/差额/)).not.toBeInTheDocument();
});
it("shows provider cache and thought subdivisions without inventing a second total", () => {
  render(<MessageTokenUsage metadata={{ model: "fixture", temperature: 0, maxTokens: 100, usage: {
    source: "provider-reported", protocol: "gemini", inputTokens: 30, outputTokens: 12, totalTokens: 42,
    nonCachedInputTokens: 25, cachedInputTokens: 5, cacheCreationInputTokens: 0,
    candidatesOutputTokens: 8, reasoningTokens: 4, toolInputTokens: 0,
  } }} />);
  expect(screen.getByText("42 token")).toBeInTheDocument();
  expect(screen.getByText("推理输出包含在提供商输出中，不再加到总用量。")).toBeInTheDocument();
  expect(screen.getAllByText("0 token")).toHaveLength(2);
  for (const label of ["非缓存输入", "写入缓存", "候选输出", "工具结果输入"]) expect(screen.getByText(label)).toBeInTheDocument();
  expect(screen.queryByText("46 token")).not.toBeInTheDocument();
});

it("switches the existing usage and local estimate to English while preserving zero and reported totals", async () => {
  render(<MessageTokenUsage metadata={{ model: "fixture", temperature: 0, maxTokens: 500, tokenAccounting: accounting,
    usage: { source: "provider-reported", inputTokens: 0, outputTokens: 12, totalTokens: 12, reasoningTokens: 4, cachedInputTokens: 0 } }} />);
  await act(() => i18n.changeLanguage("en"));
  expect(await screen.findByText("Provider-reported usage")).toBeInTheDocument();
  expect(screen.getByText("Provider input minus the local input estimate: -20 token.")).toBeInTheDocument();
  expect(screen.getByText("Audio is not included in the local estimate.")).toBeInTheDocument();
  expect(screen.getByText("Some request content is not counted; this estimate is incomplete.")).toBeInTheDocument();
  expect(screen.getAllByText("12 token")).toHaveLength(2); expect(screen.getAllByText("0 token")).toHaveLength(2);
  expect(document.body.textContent).not.toContain("500"); expect(document.body.textContent).not.toContain("16 token");
});
