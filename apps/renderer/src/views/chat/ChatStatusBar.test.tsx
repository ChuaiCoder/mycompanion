import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ChatMessage, ConversationDetail, PromptBudgetReport } from "@mycompanion/shared";
import i18n from "../../i18n";
import { ChatStatusBar } from "./ChatStatusBar";

afterEach(async () => { cleanup(); await i18n.changeLanguage("zh"); });

const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "m1", conversationId: "story", branchId: "branch", parentMessageId: null,
  role: "assistant", content: "reply", status: "complete", createdAt: "2026-10-02",
  ...overrides,
});

const conversation = (messages: ChatMessage[]): ConversationDetail => ({
  id: "story", characterId: "character", characterName: "旅人", title: "Story",
  lastMessagePreview: "reply", messageCount: messages.length, activeBranchId: "branch",
  createdAt: "2026-10-02", updatedAt: "2026-10-02", messages,
});

const budget = (totalTokens: number, contextLimitTokens: number): PromptBudgetReport => ({
  contextLimitTokens, reserveTokens: 0, availableTokens: contextLimitTokens,
  regions: [], recentMessageCount: 0, diagnostics: [], totalTokens,
});

it("renders nothing without an active conversation", () => {
  const { container } = render(<ChatStatusBar activeConversation={null} lastPromptBudget={null} />);
  expect(container).toBeEmptyDOMElement();
});

it("counts assistant replies and sums only provider-reported usage", () => {
  const messages = [
    message({ role: "user", content: "hi" }),
    message({ generationMetadata: { model: "m", temperature: 0.7, maxTokens: 100, usage: { source: "provider-reported", inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cachedInputTokens: 800 } } }),
    // 没有 usage 的消息（如旧记录）不参与累计，也不该把缓存命中率算错。
    message({ generationMetadata: { model: "m", temperature: 0.7, maxTokens: 100 } }),
  ];
  render(<ChatStatusBar activeConversation={conversation(messages)} lastPromptBudget={budget(4000, 32768)} />);
  expect(screen.getByText("2 轮回复")).toBeInTheDocument();
  expect(screen.getByText("累计 1.5k tok")).toBeInTheDocument();
  expect(screen.getByText("缓存命中 80%")).toBeInTheDocument();
  expect(screen.getByText("上下文 12%")).toBeInTheDocument();
});

it("hides usage-derived items when no provider usage was ever reported", () => {
  render(<ChatStatusBar activeConversation={conversation([message()])} lastPromptBudget={null} />);
  expect(screen.getByText("1 轮回复")).toBeInTheDocument();
  expect(screen.queryByText(/累计/)).toBeNull();
  expect(screen.queryByText(/缓存命中/)).toBeNull();
  expect(screen.queryByText(/上下文/)).toBeNull();
});
