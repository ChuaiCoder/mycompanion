import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MemoryRecord } from "@mycompanion/shared";
import i18n from "../i18n";
import { MemoryView } from "./MemoryView";

// 记忆库页面：一次列出所有故事的记忆。关键契约是按故事分组、每条只出现一次，
// 以及空态、筛选与来源定位。

const record = (overrides: Partial<MemoryRecord> & { id: string }): MemoryRecord => ({
  conversationId: "11111111-1111-4111-8111-111111111111",
  characterId: "22222222-2222-4222-8222-222222222222",
  type: "fact",
  content: "记忆内容",
  scope: "story",
  importance: 3,
  status: "active",
  pinned: false,
  sourceMessageIds: [],
  supersededBy: null,
  previousContent: null,
  createdAt: "2026-10-03T00:00:00.000Z",
  lastUsedAt: null,
  ...overrides,
});

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
// 记忆 ID 必须是合法 UUID：schema 会校验，否则整份清单解析失败、页面只剩错误态。
const M1 = "11111111-1111-4111-8111-111111111111";
const M2 = "22222222-2222-4222-8222-222222222222";
const M3 = "33333333-3333-4333-8333-333333333333";
const SOURCE = "44444444-4444-4444-8444-444444444444";

const inventory = {
  items: [
    { memory: record({ id: M1, conversationId: A, content: "甲线的线索" }), conversationId: A, conversationTitle: "《道渊》· 上午" },
    { memory: record({ id: M2, conversationId: A, content: "甲线的第二条" }), conversationId: A, conversationTitle: "《道渊》· 上午" },
    { memory: record({ id: M3, conversationId: B, scope: "user", content: "全局偏好" }), conversationId: B, conversationTitle: "《道渊》· 下午" },
  ],
  total: 3,
};

function stub(data: unknown = inventory, status = 200) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

/** 带来源消息的记忆：来源区要先展开，且需要一份合法的故事导出。 */
function stubWithSource() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/export")
      ? {
          format: "mycompanion-story", formatVersion: 1,
          conversation: {
            id: A, characterId: M2, characterName: "道渊", title: "《道渊》· 上午",
            activeBranchId: A, createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z",
          },
          messages: [{
            id: SOURCE, branchId: A, parentMessageId: null, role: "assistant",
            content: "来源原文", status: "complete", createdAt: "2026-10-03T00:00:00.000Z",
          }],
          stageSummary: null,
          memories: [],
        }
      : {
          items: [{
            memory: record({ id: M1, conversationId: A, content: "甲线的线索", sourceMessageIds: [SOURCE] }),
            conversationId: A, conversationTitle: "《道渊》· 上午",
          }],
          total: 1,
        };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
}

beforeEach(async () => { await i18n.changeLanguage("zh"); });
afterEach(async () => { cleanup(); vi.unstubAllGlobals(); await i18n.changeLanguage("zh"); });

it("groups memories by their owning story and shows each story once", async () => {
  stub();
  const { container } = render(<MemoryView online onOpenSource={vi.fn()} />);

  // 两条来自甲线、一条来自乙线，应当只有两个分组，组头是故事标题。
  const groups = await waitFor(() => {
    const found = container.querySelectorAll(".memory-page-group");
    expect(found).toHaveLength(2);
    return found;
  });
  const headings = [...container.querySelectorAll(".memory-page-group__head h2")].map(node => node.textContent);
  expect(headings).toEqual(["《道渊》· 上午", "《道渊》· 下午"]);
  expect(within(groups[0] as HTMLElement).getAllByRole("listitem")).toHaveLength(2);
  expect(within(groups[1] as HTMLElement).getAllByRole("listitem")).toHaveLength(1);
  // 统计条给出记忆总数，而不是分组数。
  expect(container.querySelector(".memory-page-stat strong")?.textContent).toBe("3");
  expect(screen.getByText("条记忆")).toBeInTheDocument();
});

it("shows an actionable empty state instead of a blank page", async () => {
  stub({ items: [], total: 0 });
  const { container } = render(<MemoryView online onOpenSource={vi.fn()} />);
  expect(await screen.findByText("还没有记忆")).toBeInTheDocument();
  expect(container.querySelector(".memory-page-empty")).not.toBeNull();
  // 空态要说明记忆是怎么来的，而不是只说没有。
  expect(screen.getByText(/系统会自动提取/)).toBeInTheDocument();
});

it("passes the filters through to the inventory query", async () => {
  const calls = stub();
  render(<MemoryView online onOpenSource={vi.fn()} />);
  await screen.findByText("甲线的线索");

  fireEvent.change(screen.getByLabelText("按范围筛选"), { target: { value: "user" } });
  await waitFor(() => expect(calls.some(url => url.includes("scope=user"))).toBe(true));

  fireEvent.change(screen.getByLabelText("按状态筛选"), { target: { value: "disabled" } });
  await waitFor(() => expect(calls.some(url => url.includes("scope=user") && url.includes("status=disabled"))).toBe(true));
});

it("surfaces a load failure instead of an endless spinner", async () => {
  stub({ error: { code: "BOOM", message: "读取失败。" } }, 500);
  const { container } = render(<MemoryView online onOpenSource={vi.fn()} />);
  expect(await screen.findByText("无法读取记忆，请重试。")).toBeInTheDocument();
  expect(container.querySelector(".memory-page-group")).toBeNull();
});

it("warns instead of pretending the library is empty when the service is offline", async () => {
  stub();
  render(<MemoryView online={false} onOpenSource={vi.fn()} />);
  expect(await screen.findByText("服务未连接，无法读取记忆。")).toBeInTheDocument();
});

it("forwards source navigation with the story that owns the memory", async () => {
  stubWithSource();
  const onOpenSource = vi.fn();
  render(<MemoryView online onOpenSource={onOpenSource} />);
  await screen.findByText("甲线的线索");

  // 来源区默认折叠，展开后才取回来源故事。
  const sources = screen.getByText(/来源与变更/);
  fireEvent.click(sources.closest("summary") ?? sources);

  // 必须带上这条记忆自己的故事与来源消息，否则会跳到别的故事里定位失败。
  fireEvent.click(await screen.findByRole("button", { name: "跳到原始消息" }));
  expect(onOpenSource).toHaveBeenCalledTimes(1);
  expect(onOpenSource.mock.calls[0]![0]).toBe(A);
  expect(onOpenSource.mock.calls[0]![1]).toBe(SOURCE);
});
