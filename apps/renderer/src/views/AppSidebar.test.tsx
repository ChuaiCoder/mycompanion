import { createRef } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within, act } from "@testing-library/react";
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
    onDeleteConversations: vi.fn(async (ids: readonly string[]) => ids.length),
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

describe("侧边栏批量删除故事", () => {
  const second: ConversationSummary = { ...conversation, id: "33333333-3333-4333-8333-333333333333", title: "旅人 · 10/3 17:25" };
  const enterSelectMode = () => fireEvent.click(screen.getByRole("button", { name: "批量管理" }));
  const checkbox = (title: string) => screen.getByRole("checkbox", { name: `选择故事“${title}”` });

  it("collects exactly the checked stories and deletes them in one request", async () => {
    const onDeleteConversations = vi.fn(async (ids: readonly string[]) => ids.length);
    render(<AppSidebar {...props({ conversations: [conversation, second], onDeleteConversations })} />);
    enterSelectMode();

    // 选中两个故事：一次请求，而不是逐条 DELETE。
    fireEvent.click(checkbox(conversation.title));
    fireEvent.click(checkbox(second.title));
    expect(screen.getByText("已选 2 个")).toBeInTheDocument();
    expect(onDeleteConversations).not.toHaveBeenCalled();

    // 先二次确认，再删除。
    fireEvent.click(screen.getByRole("button", { name: "删除所选" }));
    expect(onDeleteConversations).not.toHaveBeenCalled();
    expect(screen.getByText("删除这些故事？")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    await waitFor(() => expect(onDeleteConversations).toHaveBeenCalledTimes(1));
    expect(onDeleteConversations).toHaveBeenCalledWith([conversation.id, second.id]);
  });

  it("will not delete an empty selection", async () => {
    const onDeleteConversations = vi.fn(async (ids: readonly string[]) => ids.length);
    render(<AppSidebar {...props({ conversations: [conversation], onDeleteConversations })} />);
    enterSelectMode();

    // 未选中任何故事时入口是禁用的，不能靠点击绕过。
    expect(screen.getByRole("button", { name: "删除所选" })).toBeDisabled();
    expect(onDeleteConversations).not.toHaveBeenCalled();
  });

  it("selects all and clears again from the toolbar", async () => {
    render(<AppSidebar {...props({ conversations: [conversation, second] })} />);
    enterSelectMode();

    fireEvent.click(screen.getByRole("button", { name: "全选" }));
    expect(screen.getByText("已选 2 个")).toBeInTheDocument();
    // 全选后按钮换成"取消全选"，再点回到 0。
    fireEvent.click(screen.getByRole("button", { name: "取消全选" }));
    expect(screen.getByText("已选 0 个")).toBeInTheDocument();
  });

  it("leaves selection mode and reports how many were removed", async () => {
    const onDeleteConversations = vi.fn(async (ids: readonly string[]) => ids.length);
    render(<AppSidebar {...props({ conversations: [conversation], onDeleteConversations })} />);
    enterSelectMode();

    fireEvent.click(checkbox(conversation.title));
    fireEvent.click(screen.getByRole("button", { name: "删除所选" }));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    await waitFor(() => expect(screen.getByText("已删除 1 个故事。")).toBeInTheDocument());
    // 全部删完就退出管理模式，不留在一个空列表上；入口回到"批量管理"。
    expect(screen.getByRole("button", { name: "批量管理" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("counts only stories that still exist after a partial delete", async () => {
    // 服务端只确认删掉了一个：另一个必须留在列表里，且选中数要跟着列表收敛。
    const onDeleteConversations = vi.fn(async () => 1);
    render(<AppSidebar {...props({ conversations: [conversation, second], onDeleteConversations })} />);
    enterSelectMode();

    fireEvent.click(screen.getByRole("button", { name: "全选" }));
    fireEvent.click(screen.getByRole("button", { name: "删除所选" }));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    await waitFor(() => expect(onDeleteConversations).toHaveBeenCalledTimes(1));
    // 返回值是 1，但两个 id 都传给了服务端；界面提示 1 个，且不退出管理模式。
    expect(onDeleteConversations).toHaveBeenCalledWith([conversation.id, second.id]);
    await waitFor(() => expect(screen.getByText("已删除 1 个故事。")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "完成" })).toBeInTheDocument();
  });

  it("returns to normal rows when leaving selection mode", async () => {
    render(<AppSidebar {...props({ conversations: [conversation, second] })} />);
    enterSelectMode();
    fireEvent.click(checkbox(conversation.title));
    fireEvent.click(screen.getByRole("button", { name: "完成" }));

    // 退出后不再有复选框，普通行与删除入口恢复；重新进入时选中态已清空。
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: deleteLabel, hidden: true })).toBeInTheDocument();
    enterSelectMode();
    expect(screen.getByText("已选 0 个")).toBeInTheDocument();
  });

  it("does not leave the result notice on screen", async () => {
    // 提示只说明刚发生的一件事，不能常驻（否则侧栏看起来一直停在某种状态里）。
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const onDeleteConversations = vi.fn(async (ids: readonly string[]) => ids.length);
      render(<AppSidebar {...props({ conversations: [conversation], onDeleteConversations })} />);
      enterSelectMode();
      fireEvent.click(checkbox(conversation.title));
      fireEvent.click(screen.getByRole("button", { name: "删除所选" }));
      fireEvent.click(screen.getByRole("button", { name: "删除" }));

      await waitFor(() => expect(screen.getByText("已删除 1 个故事。")).toBeInTheDocument());
      // 计时到点后自行消失，不需要用户做任何操作。
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(screen.queryByText("已删除 1 个故事。")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
