import { createRef } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationSummary } from "@mycompanion/shared";
import i18n from "../i18n";
import { AppSidebar } from "./AppSidebar";

// 侧边栏删除故事：软删除 + 行内二次确认。jsdom 不加载样式表，所以这里对组件做行为
// 断言（确认 → 调用 → 收起 / 取消 / 失败保留），真实布局与可见性由 Electron 验证。
// 删除按钮平时 visibility:hidden，因此查询时显式带上 hidden:true。

const conversation: ConversationSummary = {
  id: "11111111-1111-4111-8111-111111111111",
  characterId: "22222222-2222-4222-8222-222222222222",
  characterName: "旅人",
  title: "旅人 · 10/3 19:18",
  lastMessagePreview: "你好",
  messageCount: 3,
  activeBranchId: "11111111-1111-4111-8111-111111111111",
  createdAt: "2026-10-03T00:00:00.000Z",
  updatedAt: "2026-10-03T00:00:00.000Z",
};

const deleteLabel = `删除故事“${conversation.title}”`;

function props(overrides: Partial<Parameters<typeof AppSidebar>[0]> = {}) {
  return {
    collapsed: false,
    onCollapseToggle: vi.fn(),
    view: "chat" as const,
    memoryPanelOpen: false,
    onNavigate: vi.fn(),
    onChatNav: vi.fn(),
    onMemoryNav: vi.fn(),
    busy: false,
    isImporting: false,
    onOpenFilePicker: vi.fn(),
    conversationCount: 1,
    pluginCount: 0,
    memoryInjectedCount: "" as const,
    conversations: [conversation],
    activeConversationId: conversation.id,
    onOpenConversation: vi.fn(),
    onDeleteConversation: vi.fn(async () => true),
    modelConnection: { state: "online" as const, modelCount: 3, reason: null, issueField: undefined },
    fileInputRef: createRef<HTMLInputElement>(),
    onCardFile: vi.fn(),
    ...overrides,
  };
}

const deleteButton = () => screen.getByRole("button", { name: deleteLabel, hidden: true });

beforeEach(async () => { await i18n.changeLanguage("zh"); });
afterEach(async () => { cleanup(); await i18n.changeLanguage("zh"); });

describe("侧边栏删除故事", () => {
  it("asks inline before deleting and issues exactly one delete", async () => {
    const onDeleteConversation = vi.fn(async () => true);
    render(<AppSidebar {...props({ onDeleteConversation })} />);

    // 第一次点击只抬起行内确认，不直接删。
    fireEvent.click(deleteButton());
    expect(onDeleteConversation).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "删除" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(onDeleteConversation).toHaveBeenCalledTimes(1));
    expect(onDeleteConversation).toHaveBeenCalledWith(conversation.id);
    // 成功后确认态收起。
    await waitFor(() => expect(screen.queryByRole("button", { name: "删除" })).not.toBeInTheDocument());
  });

  it("cancels without deleting", async () => {
    const onDeleteConversation = vi.fn(async () => true);
    render(<AppSidebar {...props({ onDeleteConversation })} />);

    fireEvent.click(deleteButton());
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("button", { name: "删除" })).not.toBeInTheDocument();
    expect(onDeleteConversation).not.toHaveBeenCalled();
    // 行本身仍然在，可以选择、可以再次删除。
    expect(deleteButton()).toBeInTheDocument();
  });

  it("keeps the confirmation open when the delete fails so it can be retried", async () => {
    const onDeleteConversation = vi.fn(async () => false);
    render(<AppSidebar {...props({ onDeleteConversation })} />);

    fireEvent.click(deleteButton());
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(onDeleteConversation).toHaveBeenCalledTimes(1));
    // 失败保留确认态（不是静默弹回），按钮可再次点击重试。
    expect(screen.getByRole("button", { name: "删除" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(onDeleteConversation).toHaveBeenCalledTimes(2));
  });

  it("only raises the confirmation for the row that was clicked", async () => {
    const second: ConversationSummary = { ...conversation, id: "33333333-3333-4333-8333-333333333333", title: "旅人 · 10/3 17:25" };
    render(<AppSidebar {...props({ conversations: [conversation, second] })} />);

    fireEvent.click(screen.getByRole("button", { name: `删除故事“${second.title}”`, hidden: true }));
    // 恰好一个确认区，且挂在被点击的那一行上（该行已不再是普通行）。
    const groups = screen.getAllByRole("group", { hidden: true });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.getAttribute("aria-label")).toBe("删除故事");
    expect(within(groups[0]!).getByText("删除？")).toBeInTheDocument();
    expect(within(groups[0]!).getByRole("button", { name: "取消" })).toBeInTheDocument();
    // 未被点击的行保持普通行，仍可打开、仍可发起删除。
    expect(screen.getByRole("button", { name: deleteLabel, hidden: true })).toBeInTheDocument();
  });
});
