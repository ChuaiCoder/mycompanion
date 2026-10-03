import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { MemoryPanel } from "./MemoryPanel";
const storyId = "00000000-0000-4000-8000-000000000001", branchId = "00000000-0000-4000-8000-000000000002", messageId = "00000000-0000-4000-8000-000000000003";
const timestamp = "2026-10-02T00:00:00.000Z";
beforeEach(async () => { await i18n.changeLanguage("zh"); });
const memory = { id: "00000000-0000-4000-8000-000000000004", conversationId: storyId, characterId: branchId, type: "fact", content: "星塔在北方", scope: "story", importance: 3, status: "orphaned", pinned: false, sourceMessageIds: [messageId, "00000000-0000-4000-8000-000000000005"], supersededBy: null, previousContent: "旧内容", createdAt: timestamp, lastUsedAt: null };
const message = { id: messageId, branchId, parentMessageId: null, role: "assistant", content: "星塔就在北方。", status: "complete", createdAt: timestamp };
const story = { format: "mycompanion-story", formatVersion: 1, conversation: { id: storyId, characterId: branchId, characterName: "旅人", title: "来源故事", activeBranchId: branchId, createdAt: timestamp, updatedAt: timestamp }, messages: [message], stageSummary: null, memories: [] };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

it("shows the actual reconciliation reason and protected related content, then refreshes all records after explicit adoption and rollback", async () => {
  const old = { ...memory, id: "00000000-0000-4000-8000-000000000008", content: "Location is north", status: "active", pinned: true, manuallyEdited: true };
  const pending = { ...memory, content: "Location is south", status: "pending", previousContent: null, reconciliation: { kind: "conflict", relatedMemoryIds: [old.id], reason: "Same stable claim has two different values" } };
  let items = [old, pending];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PUT") { items = [{ ...old, status: "superseded" }, { ...pending, status: "active" }]; return response(items[1]); }
    if (url.endsWith("/restore")) { items = [old, pending]; return response(old); }
    return url.endsWith("memories") ? response({ items }) : response({ autoSummaryEnabled: false, summary: null });
  });
  vi.stubGlobal("fetch", fetch); render(<MemoryPanel conversationId={storyId} conversationTitle="Story" runtimeError={null} />);
  await screen.findByText("Same stable claim has two different values", { exact: false });
  expect(screen.getByText(/已固定 · 人工更正/)).toBeInTheDocument(); expect(fetch.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "采用并替代关联记忆" })); await screen.findByRole("button", { name: "恢复这条记忆" });
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining(pending.id), expect.objectContaining({ method: "PUT", body: JSON.stringify({ status: "active" }) }));
  await waitFor(() => expect(screen.getByRole("button", { name: "恢复这条记忆" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "恢复这条记忆" })); await screen.findByRole("button", { name: "采用并替代关联记忆" });
});

it("shows original text, previous content and unavailable sources, and opens the source story and branch", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("memories") ? response({ items: [memory] }) : url.includes("export") ? response(story) : response({ autoSummaryEnabled: false, summary: null })));
  const open = vi.fn(); render(<MemoryPanel conversationId={storyId} conversationTitle="Story" runtimeError={null} onOpenSource={open} />);
  await screen.findByText("星塔在北方"); fireEvent.click(screen.getByText("来源与变更（2 条）")); await screen.findByText("星塔就在北方。");
  expect(screen.getByText("上次内容：旧内容")).toBeInTheDocument(); expect(screen.getByText("来源消息已删除或不可访问。")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "跳到原始消息" })); expect(open).toHaveBeenCalledWith(storyId, message);
});

it("reports deleted source stories and marks invalid summaries without hiding their editable text", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("memories") ? response({ items: [memory] }) : url.includes("export") ? response({ error: { code: "CONVERSATION_NOT_FOUND", message: "故事不存在。" } }, 404) : response({ autoSummaryEnabled: false, summary: { content: "旧摘要", coveredMessageCount: 2, model: "test", valid: false } })));
  render(<MemoryPanel conversationId={storyId} conversationTitle="Story" runtimeError={null} />);
  await screen.findByText("星塔在北方"); fireEvent.click(screen.getByText("来源与变更（2 条）")); await screen.findByText("来源无法访问：故事不存在。");
  expect(screen.getByText("来源已改变，需重新生成或校正；这份摘要暂不用于对话。")).toBeInTheDocument(); expect(screen.getByRole("textbox", { name: "阶段摘要内容" })).toHaveValue("旧摘要");
});

it("provides a localized readable load error and an actual retry without clearing user's retrieval draft on language switch", async () => {
  let failed = true;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("memories") ? (failed ? response({}, 500) : response({ items: [memory] })) : response({ autoSummaryEnabled: false, summary: null })));
  render(<MemoryPanel conversationId={storyId} conversationTitle="Story" runtimeError={null} />);
  await screen.findByRole("alert");
  fireEvent.change(screen.getByRole("textbox", { name: "检索测试文本" }), { target: { value: "我的中文草稿" } });
  await act(() => i18n.changeLanguage("en"));
  await screen.findByRole("button", { name: "Retry loading memories" });
  expect(screen.getByRole("alert")).toHaveTextContent("Could not load memories. Please retry.");
  expect(screen.getByRole("textbox", { name: "Retrieval test text" })).toHaveValue("我的中文草稿");
  failed = false; fireEvent.click(screen.getByRole("button", { name: "Retry loading memories" }));
  await screen.findByText("星塔在北方");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Filter by status" })).toBeInTheDocument();
});

it("focuses the actual editor, retains its draft after save failure, and returns focus after cancel", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => init?.method === "PUT" ? response({}, 500) : url.endsWith("memories") ? response({ items: [memory] }) : response({ autoSummaryEnabled: false, summary: null })));
  render(<MemoryPanel conversationId={storyId} conversationTitle="Story" runtimeError={null} />);
  const edit = await screen.findByRole("button", { name: "编辑" }); fireEvent.click(edit);
  const editor = screen.getByRole("textbox", { name: "编辑记忆" }); expect(editor).toHaveFocus();
  fireEvent.change(editor, { target: { value: "用户手工草稿" } }); fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByText("无法更新记忆，请重试。");
  expect(editor).toHaveValue("用户手工草稿");
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "编辑" })).toHaveFocus());
});

it("does not render old retrieval or update completions in the newly selected story", async () => {
  let releaseTest!: (value: Response) => void, releaseUpdate!: (value: Response) => void;
  const nextId = "00000000-0000-4000-8000-000000000019";
  const other = { ...memory, conversationId: nextId, content: "B story memory" };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/test")) return new Promise<Response>(resolve => { releaseTest = resolve; });
    if (init?.method === "PUT") return new Promise<Response>(resolve => { releaseUpdate = resolve; });
    return url.endsWith("memories") ? response({ items: [url.includes(nextId) ? other : memory] }) : response({ autoSummaryEnabled: false, summary: null });
  }));
  const { rerender } = render(<MemoryPanel conversationId={storyId} conversationTitle="A" runtimeError={null} />);
  await screen.findByText(memory.content); fireEvent.click(screen.getByRole("button", { name: "运行检索" })); fireEvent.click(screen.getByRole("button", { name: "固定" }));
  rerender(<MemoryPanel conversationId={nextId} conversationTitle="B" runtimeError={null} />);
  await screen.findByText("B story memory");
  await act(async () => { releaseTest(response({ results: [], injectedCount: 9, budgetTokens: 100, block: "Old A result" })); releaseUpdate(response({ ...memory, content: "Late A memory" })); });
  await waitFor(() => expect(screen.getByRole("button", { name: "运行检索" })).toBeEnabled());
  expect(screen.queryByText("Late A memory")).not.toBeInTheDocument(); expect(screen.queryByText("Old A result")).not.toBeInTheDocument();
  expect(screen.queryByText(/注入 9 条/)).not.toBeInTheDocument(); expect(screen.getByText("B story memory")).toBeInTheDocument();
});

it("keeps an unsaved memory edit when the same story's source revision refreshes", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("memories") ? response({ items: [memory] }) : response({ autoSummaryEnabled: false, summary: null })));
  const { rerender } = render(<MemoryPanel conversationId={storyId} conversationTitle="Story" sourceRevision="first" runtimeError={null} />);
  fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
  fireEvent.change(screen.getByRole("textbox", { name: "编辑记忆" }), { target: { value: "正在编辑的草稿" } });
  rerender(<MemoryPanel conversationId={storyId} conversationTitle="Story" sourceRevision="new-message" runtimeError={null} />);
  expect(await screen.findByRole("textbox", { name: "编辑记忆" })).toHaveValue("正在编辑的草稿");
});
