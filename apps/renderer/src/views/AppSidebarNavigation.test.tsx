import { createRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { AppSidebar } from "./AppSidebar";

// 主导航的语义：每个入口都是「进入」，不是「开关」。
// 记忆曾经写成 toggle，导致在故事页点「记忆」反而把记忆关掉，永远进不去。

const props = (overrides: Partial<Parameters<typeof AppSidebar>[0]> = {}) => ({
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
  conversationCount: 0,
  pluginCount: 0,
  memoryInjectedCount: "" as const,
  conversations: [],
  activeConversationId: undefined,
  onOpenConversation: vi.fn(),
  onDeleteConversation: vi.fn(async () => true),
  onDeleteConversations: vi.fn(async (ids: readonly string[]) => ids.length),
  modelConnection: { state: "online" as const, modelCount: 3, model: "fixture-model", reason: null, issueField: undefined },
  fileInputRef: createRef<HTMLInputElement>(),
  onCardFile: vi.fn(),
  ...overrides,
});

beforeEach(async () => { await i18n.changeLanguage("zh"); });
afterEach(async () => { cleanup(); await i18n.changeLanguage("zh"); });

const navButton = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });

it("opens the memory page from the nav without toggling it closed", () => {
  // 即使记忆面板当前是打开的，点导航也只能"进入记忆页"，不能变成关闭。
  const onMemoryNav = vi.fn();
  render(<AppSidebar {...props({ memoryPanelOpen: true, onMemoryNav })} />);
  fireEvent.click(navButton("记忆"));
  expect(onMemoryNav).toHaveBeenCalledTimes(1);
});

it("marks the memory entry as the current page only on the memory view", () => {
  const { unmount } = render(<AppSidebar {...props({ view: "memory" })} />);
  expect(navButton("记忆")).toHaveAttribute("aria-current", "page");
  // 故事入口此时不再是当前页：两者不能同时高亮。
  expect(navButton("故事")).not.toHaveAttribute("aria-current");
  unmount();

  // 在故事页时反过来，即使记忆侧栏打开，故事才是当前页。
  const story = render(<AppSidebar {...props({ view: "chat", memoryPanelOpen: true })} />);
  expect(navButton("故事")).toHaveAttribute("aria-current", "page");
  expect(navButton("记忆")).not.toHaveAttribute("aria-current");
  story.unmount();

  // 其它页面时两者都不高亮。
  render(<AppSidebar {...props({ view: "library" })} />);
  expect(navButton("记忆")).not.toHaveAttribute("aria-current");
  expect(navButton("故事")).not.toHaveAttribute("aria-current");
});

it("shows the injected-memory badge only while reading a story", () => {
  const { unmount } = render(<AppSidebar {...props({ view: "chat", memoryInjectedCount: 3 })} />);
  expect(navButton("记忆").textContent).toContain("3");
  unmount();
  // 在记忆库页面这个数字含义不同（不是"本轮注入"），因此不显示，避免误导。
  render(<AppSidebar {...props({ view: "memory", memoryInjectedCount: 3 })} />);
  expect(navButton("记忆").textContent).not.toContain("3");
  expect(screen.getByText("记忆")).toBeInTheDocument();
});
