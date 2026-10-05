import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PromptPreviewResponse } from "@mycompanion/shared";
import i18n from "../../i18n";
import * as api from "../../api";
import { PromptPreviewPanel } from "./PromptPreviewPanel";

// 提示词预览面板：区域用量条 + 可区分的消息行。三条 system 消息必须靠内容摘要区分，
// 否则折叠态就是一排一模一样的「系统提示词 展开」（真实界面里报过这个问题）。

const preview: PromptPreviewResponse = {
  tokenAccounting: {
    method: "tavern-compatibility", model: "unknown-model", encoding: "fallback",
    estimated: true, textEstimated: true, framingEstimated: true, mediaEstimated: false, complete: false,
    promptTokens: 1839, mediaTokens: 0, reasons: ["unknown-model"],
  },
  messages: [
    { role: "system", content: "你是《道渊》中的旅人。\n\n保持语气沉稳。" },
    { role: "system", content: "世界书：\n北港的灯塔在雨夜会熄灭。" },
    { role: "system", content: "这行很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长" },
    { role: "user", content: "我们现在在哪里？" },
  ],
  regions: [
    { key: "character_core", label: "角色核心", tokens: 246 },
    { key: "worldbook", label: "世界书", tokens: 1200 },
  ],
  totalTokens: 1839,
  recentMessageCount: 0,
  // 后端仍会报告脱敏处数（FR-PROMPT-004），但界面不再显示这个计数。
  redactions: 2,
  diagnostics: ["阶段摘要超出预算，已丢弃细节"],
};

beforeEach(async () => { await i18n.changeLanguage("zh"); });
afterEach(async () => { cleanup(); vi.restoreAllMocks(); await i18n.changeLanguage("zh"); });

async function open() {
  vi.spyOn(api, "promptPreview").mockResolvedValue(preview);
  const { container } = render(<PromptPreviewPanel conversationId="c1" sourceRevision="r1" draft="我们现在在哪里？" isGenerating={false} />);
  fireEvent.click(container.querySelector(".prompt-preview > summary")!);
  await screen.findByText("最终请求消息");
  return container;
}

it("distinguishes same-role messages by a content snippet instead of identical rows", async () => {
  const container = await open();
  const snippets = [...container.querySelectorAll(".prompt-preview__snippet")].map(node => node.textContent ?? "");
  expect(snippets).toHaveLength(4);
  // 三条 system 消息摘要各不相同，这正是折叠态可区分的关键。
  const systems = snippets.slice(0, 3);
  expect(new Set(systems).size).toBe(3);
  expect(systems[0]).toContain("你是《道渊》中的旅人");
  expect(systems[1]).toContain("北港的灯塔");
  // 换行被压平，摘要保持单行。
  expect(systems[0]).not.toContain("\n");
  // 超长内容截断加省略号，不会把行撑破。
  expect(systems[2]!.endsWith("…")).toBe(true);
  expect(systems[2]!.length).toBeLessThanOrEqual(141);
});

it("lists each classified region with its own token count", async () => {
  const container = await open();
  const legend = [...container.querySelectorAll(".prompt-preview__legend-item")].map(node => node.textContent ?? "");
  expect(legend).toHaveLength(2);
  // 区域用量是后端已归类的部分；这里只给绝对数，不给百分比（否则会被读成占满整个提示词）。
  expect(legend[0]).toContain("角色核心");
  expect(legend[0]).toContain("约 246 token");
  expect(legend[0]).not.toContain("%");
  expect(legend[1]).toContain("世界书");
  expect(legend[1]).toContain("约 1200 token");
  // 被裁剪的诊断必须仍然可见（FR-PROMPT-003）。
  expect(container.querySelector(".prompt-preview__diagnostics")?.textContent).toContain("已丢弃细节");
  // 条数单独给出，不能从 token 反推。
  expect(screen.getByText(/近期原始对话 0 条进入上下文/)).toBeInTheDocument();
});

it("merges duplicate region keys instead of drawing the same region twice", async () => {
  // 后端会把 main 与 charDescription 都归到 character_core，重复 key 不能变成两个图例。
  vi.spyOn(api, "promptPreview").mockResolvedValue({
    ...preview,
    regions: [
      { key: "character_core", label: "main", tokens: 30 },
      { key: "character_core", label: "charDescription", tokens: 246 },
      { key: "worldbook", label: "世界书", tokens: 4 },
    ],
  });
  const { container } = render(<PromptPreviewPanel conversationId="c1" sourceRevision="r1" draft="" isGenerating={false} />);
  fireEvent.click(container.querySelector(".prompt-preview > summary")!);
  await screen.findByText("最终请求消息");

  expect(container.querySelectorAll(".prompt-preview__bar-seg")).toHaveLength(2);
  const legend = [...container.querySelectorAll(".prompt-preview__legend-item")];
  expect(legend).toHaveLength(2);
  // 合并后 character_core 应为 276 token（不是两条 30 / 246）。
  expect(legend[0]!.textContent).toContain("约 276 token");
});

it("does not surface the redaction count in the header", async () => {
  const container = await open();
  const header = container.querySelector(".prompt-preview > summary")!.textContent ?? "";
  // 头部只报 token 总量；脱敏仍照常生效，只是不再显示计数。
  expect(header).toContain("约 1839 token");
  expect(header).not.toContain("脱敏");
  expect(header).not.toContain("2 处");
});

it("expands messages independently and shows the exact content of each", async () => {
  const container = await open();
  const summaries = [...container.querySelectorAll(".prompt-preview__message > summary")];
  expect(container.querySelectorAll(".prompt-preview__content")).toHaveLength(0);
  fireEvent.click(summaries[1]!);
  await waitFor(() => expect(container.querySelectorAll(".prompt-preview__content")).toHaveLength(1));
  expect(container.querySelector(".prompt-preview__content")!.textContent).toContain("北港的灯塔在雨夜会熄灭");
  // 展开是各自独立的：对比不同区域时可以把两条同时摊开。
  fireEvent.click(summaries[3]!);
  await waitFor(() => expect(container.querySelectorAll(".prompt-preview__content")).toHaveLength(2));
  const contents = [...container.querySelectorAll(".prompt-preview__content")].map(node => node.textContent ?? "");
  expect(contents.some(text => text.includes("北港的灯塔"))).toBe(true);
  expect(contents.some(text => text.includes("我们现在在哪里"))).toBe(true);
  // 再点一次收起，展开态完全复位。
  fireEvent.click(summaries[1]!);
  await waitFor(() => expect(container.querySelectorAll(".prompt-preview__content")).toHaveLength(1));
});
