import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatMessage } from "@mycompanion/shared";
import * as api from "./api";
import { DisplayTextProvider, needsDisplayTransform, useDisplayText } from "./display-text";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const message = (id: string, content: string): ChatMessage => ({
  id, conversationId: "22222222-2222-4222-8222-222222222222", branchId: "33333333-3333-4333-8333-333333333333",
  parentMessageId: null, role: "assistant", content, status: "complete", createdAt: "2026-10-03T00:00:00.000Z",
});

it("only requests display transforms for content that can carry one", () => {
  // 卡把界面放在显示规则里时，占位符就是这个形态。
  expect(needsDisplayTransform("[重塑仙缘]")).toBe(true);
  // 前端卡内容本身也需要转换（规则可能替换其中片段）。
  expect(needsDisplayTransform("```html\n<html><head></head><body>x</body></html>\n```")).toBe(true);
  // 普通消息、超长方括号内容、非方括号包裹的都不该产生请求。
  expect(needsDisplayTransform("你好，旅人。")).toBe(false);
  const longPlaceholder = "[" + "很长".repeat(40) + "]";
  expect(longPlaceholder.slice(1, -1).length).toBeGreaterThan(60);
  expect(needsDisplayTransform(longPlaceholder)).toBe(false);
  expect(needsDisplayTransform("说话前 [停顿] 了一下")).toBe(false);
  expect(needsDisplayTransform("")).toBe(false);
});

function Probe({ id }: { id: string }) {
  const texts = useDisplayText();
  return <span data-testid="value">{texts.get(id) ?? "(原文)"}</span>;
}

it("replaces the displayed text with the transform result without touching stored content", async () => {
  const original = message("11111111-1111-4111-8111-111111111111", "[重塑仙缘]");
  const transform = vi.spyOn(api, "transformDisplayText").mockResolvedValue([
    { messageId: original.id, text: "<html><body>创建界面</body></html>" },
  ]);
  render(
    <DisplayTextProvider conversationId={original.conversationId} messages={[original]}>
      <Probe id={original.id} />
    </DisplayTextProvider>,
  );
  expect(screen.getByTestId("value").textContent).toBe("(原文)");
  await waitFor(() => expect(screen.getByTestId("value").textContent).toContain("创建界面"));
  // 只发送需要转换的消息，且原文未被改写。
  expect(transform).toHaveBeenCalledTimes(1);
  expect(transform.mock.calls[0]![1]).toEqual([{ messageId: original.id, text: "[重塑仙缘]" }]);
  expect(original.content).toBe("[重塑仙缘]");
});

it("does not call the service when no message needs a transform", async () => {
  const transform = vi.spyOn(api, "transformDisplayText").mockResolvedValue([]);
  render(
    <DisplayTextProvider conversationId="22222222-2222-4222-8222-222222222222" messages={[message("44444444-4444-4444-8444-444444444444", "普通回复")]}>
      <Probe id="44444444-4444-4444-8444-444444444444" />
    </DisplayTextProvider>,
  );
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(transform).not.toHaveBeenCalled();
  expect(screen.getByTestId("value").textContent).toBe("(原文)");
});

it("falls back to the original text when the transform fails", async () => {
  const original = message("55555555-5555-4555-8555-555555555555", "[重塑仙缘]");
  vi.spyOn(api, "transformDisplayText").mockRejectedValue(new Error("boom"));
  render(
    <DisplayTextProvider conversationId={original.conversationId} messages={[original]}>
      <Probe id={original.id} />
    </DisplayTextProvider>,
  );
  await new Promise(resolve => setTimeout(resolve, 20));
  // 显示层不能因为正则问题丢内容。
  expect(screen.getByTestId("value").textContent).toBe("(原文)");
});
