import { afterEach, expect, it, vi } from "vitest";
import { selectMessageSwipe } from "./swipe-runtime";

const message = { id: "00000000-0000-4000-8000-000000000001", conversationId: "00000000-0000-4000-8000-000000000002",
  branchId: "00000000-0000-4000-8000-000000000003", parentMessageId: null, role: "assistant",
  content: "备用问候", status: "complete", createdAt: "2026-10-03T00:00:00.000Z",
  extensionData: { swipes: ["欢迎。", "备用问候"], swipe_id: 1 } };
const target = { conversationId: message.conversationId, messageId: message.id };
afterEach(() => { vi.unstubAllGlobals(); });

it("posts the selection to the native swipe endpoint and returns the projected message", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify(message), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  const selected = await selectMessageSwipe(target, 1);
  expect(fetch).toHaveBeenCalledWith(`/api/conversations/${message.conversationId}/messages/${message.id}/swipe`, expect.objectContaining({
    method: "POST", body: JSON.stringify({ swipeId: 1 }),
  }));
  expect(selected.content).toBe("备用问候");
  expect(selected.extensionData?.swipe_id).toBe(1);
});

it("surfaces the server's conflict message", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "SWIPE_NOT_AVAILABLE", message: "候选回复已改变，请重新选择。" } }),
    { status: 409, headers: { "Content-Type": "application/json" } })));
  await expect(selectMessageSwipe(target, 5)).rejects.toThrow("候选回复已改变，请重新选择。");
});
