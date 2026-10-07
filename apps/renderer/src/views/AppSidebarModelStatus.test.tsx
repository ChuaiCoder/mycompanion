import { createRef } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { AppSidebar } from "./AppSidebar";

// 侧栏状态点显示的是**模型连通性**，不是"本地 HTTP 服务是否响应"。
// 后者与界面同进程、几乎永远成功，所以那个绿灯提供不了任何信息。

const props = (modelConnection: Parameters<typeof AppSidebar>[0]["modelConnection"]) => ({
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
  modelConnection,
  fileInputRef: createRef<HTMLInputElement>(),
  onCardFile: vi.fn(),
});

beforeEach(async () => { await i18n.changeLanguage("zh"); });
afterEach(async () => { cleanup(); await i18n.changeLanguage("zh"); });

it("says the model is connected only when the model actually answered", () => {
  render(<AppSidebar {...props({ state: "online", modelCount: 3, reason: null, issueField: undefined })} />);
  const status = document.querySelector(".service-state")!;
  expect(status.textContent).toContain("模型已连接");
  expect(status.className).toContain("service-state--online");
  // 读到的模型数一并给出，用户能确认连的是不是自己期望的那个服务。
  expect(status.textContent).toContain("3");
});

it("does not claim the model is connected while it is still being checked", () => {
  render(<AppSidebar {...props({ state: "checking", modelCount: 0, reason: null, issueField: undefined })} />);
  const status = document.querySelector(".service-state")!;
  expect(status.textContent).toContain("检查模型连接中");
  expect(status.textContent).not.toContain("模型已连接");
});

it("reports a disconnected model instead of a green light", () => {
  render(<AppSidebar {...props({ state: "offline", modelCount: 0, reason: "连接被拒绝，请检查服务地址。", issueField: "baseUrl" })} />);
  const status = document.querySelector(".service-state")!;
  expect(status.textContent).toContain("模型未连接");
  expect(status.className).toContain("service-state--offline");
  // 失败原因要能查到，而不是只有一个笼统的红点。
  expect(status.getAttribute("title")).toBe("连接被拒绝，请检查服务地址。");
});

it("hides the model count when the provider returned no list", () => {
  // 有些服务（或 Ollama 的某些版本）不返回模型列表，这不是错误，但也不该显示 0 个模型。
  render(<AppSidebar {...props({ state: "online", modelCount: 0, reason: null, issueField: undefined })} />);
  const status = document.querySelector(".service-state")!;
  expect(status.textContent).toContain("模型已连接");
  expect(status.querySelector("small")).toBeNull();
});
