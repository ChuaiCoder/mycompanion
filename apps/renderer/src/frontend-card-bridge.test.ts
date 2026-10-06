import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@mycompanion/shared";
import {
  CARD_API_DENYLIST,
  CARD_BRIDGE_REQUEST,
  CARD_BRIDGE_SCRIPT,
  isCardApiAllowed,
  parseCardBridgeRequest,
  parseSlashSend,
  runCardBridgeRequest,
  toCardMessage,
  type CardBridgeHost,
} from "./frontend-card-bridge";

const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "11111111-1111-4111-8111-111111111111", conversationId: "22222222-2222-4222-8222-222222222222",
  branchId: "33333333-3333-4333-8333-333333333333", parentMessageId: null, role: "assistant",
  content: "第一版开场白", status: "complete", createdAt: "2026-10-03T00:00:00.000Z",
  extensionData: { swipes: ["第一版开场白", "重塑仙缘"], swipe_id: 0, swipe_info: [{ extra: {} }, { extra: {} }] },
  ...overrides,
});

const host = (messages: ChatMessage[] = [message()]): CardBridgeHost & { swipes: Array<[string, number]>; sent: string[] } => {
  const swipes: Array<[string, number]> = [];
  const sent: string[] = [];
  return {
    messages, characterName: "道渊", swipes, sent,
    onSelectSwipe: async (messageId, swipeId) => { swipes.push([messageId, swipeId]); },
    onSend: text => { sent.push(text); },
  };
};

describe("card capability bridge", () => {
  it("denies data, extension and network capabilities while allowing the card's own calls", () => {
    // 黑名单里的能力必须被拒绝。
    for (const method of ["getVariables", "setVariables", "getWorldbook", "setCharacter", "installExtension", "generate", "fetch"]) {
      expect(isCardApiAllowed(method)).toBe(false);
    }
    // 卡片实际使用的三个 API 必须放行，否则开场白按钮无效。
    for (const method of ["getChatMessages", "setChatMessage", "triggerSlash"]) {
      expect(isCardApiAllowed(method)).toBe(true);
    }
    // 名单本身保持可审计。
    expect(CARD_API_DENYLIST.length).toBeGreaterThan(20);
  });

  it("resolves the card's swipe switch to the app's own swipe endpoint", async () => {
    const bridge = host();
    // 卡片脚本的实际调用形态（取自卡内脚本）。
    const read = await runCardBridgeRequest({ id: 1, method: "getChatMessages", args: [0, { include_swipe: true }] }, bridge);
    expect(read.ok).toBe(true);
    const first = (read as { value: Array<{ swipes: string[]; swipe_id: number }> }).value[0]!;
    expect(first.swipes).toEqual(["第一版开场白", "重塑仙缘"]);
    expect(first.swipe_id).toBe(0);

    const write = await runCardBridgeRequest({
      id: 2, method: "setChatMessage",
      args: [first.swipes[1], 0, { swipe_id: 1, refresh: "display_and_render_current" }],
    }, bridge);
    expect(write).toEqual({ id: 2, ok: true, value: true });
    // 必须落到"切换候选"而不是直接覆写消息内容。
    expect(bridge.swipes).toEqual([[message().id, 1]]);
  });

  it("maps /send to a real user message and rejects other slash commands", async () => {
    const bridge = host();
    const sent = await runCardBridgeRequest({ id: 3, method: "triggerSlash", args: ["/send 开启仙途"] }, bridge);
    expect(sent).toEqual({ id: 3, ok: true, value: "" });
    expect(bridge.sent).toEqual(["开启仙途"]);

    // 其它指令（例如装扩展）不应被当作发送处理。
    const other = await runCardBridgeRequest({ id: 4, method: "triggerSlash", args: ["/extension install evil"] }, bridge);
    expect(other).toMatchObject({ id: 4, ok: false });
    expect(bridge.sent).toEqual(["开启仙途"]);
  });

  it("refuses to overwrite message content directly and explains why", async () => {
    const bridge = host();
    const result = await runCardBridgeRequest({ id: 5, method: "setChatMessage", args: ["被改写的文本", 0, {}] }, bridge);
    expect(result).toMatchObject({ id: 5, ok: false });
    expect((result as { error: string }).error).toContain("切换候选");
    expect(bridge.swipes).toEqual([]);
  });

  it("reports a clear error for denylisted and unimplemented capabilities", async () => {
    const bridge = host();
    const denied = await runCardBridgeRequest({ id: 6, method: "setVariables", args: [{}] }, bridge);
    expect(denied).toMatchObject({ id: 6, ok: false });
    expect((denied as { error: string }).error).toContain("禁用");

    const unknown = await runCardBridgeRequest({ id: 7, method: "generate", args: [] }, bridge);
    expect(unknown).toMatchObject({ id: 7, ok: false });
  });

  it("projects messages into the shape card scripts read, degrading when there are no swipes", () => {
    const plain = message({ extensionData: undefined, content: "只有一条" });
    const view = toCardMessage(plain, "道渊");
    expect(view).toMatchObject({ mes: "只有一条", is_user: false, role: "assistant", name: "道渊" });
    // 没有候选数据时退化为单候选，卡片因此自然降级而不是拿到空数组。
    expect(view.swipes).toEqual(["只有一条"]);
    expect(view.swipe_id).toBe(0);

    // swipe_id 越界时收敛到合法范围，避免卡片按错误序号取到 undefined。
    const stale = toCardMessage(message({ extensionData: { swipes: ["a", "b"], swipe_id: 9 } }), "道渊");
    expect(stale.swipe_id).toBe(1);
  });

  it("ignores foreign messages and only answers its own request protocol", () => {
    expect(parseCardBridgeRequest({ type: CARD_BRIDGE_REQUEST, id: 1, method: "getChatMessages", args: [] }))
      .toEqual({ id: 1, method: "getChatMessages", args: [] });
    // 别的 postMessage 不应被当成卡片请求。
    expect(parseCardBridgeRequest({ type: "some-other", id: 1, method: "x" })).toBeNull();
    expect(parseCardBridgeRequest({ type: CARD_BRIDGE_REQUEST, id: "1", method: "x" })).toBeNull();
    expect(parseCardBridgeRequest(null)).toBeNull();
    expect(parseCardBridgeRequest("text")).toBeNull();
  });

  it("ships a bridge script that installs the API before card scripts run", () => {
    // 卡片脚本用 `typeof getChatMessages !== 'undefined'` 判断能力是否存在，因此桥必须先挂好。
    for (const name of ["getChatMessages", "setChatMessage", "triggerSlash", "TavernHelper"]) {
      expect(CARD_BRIDGE_SCRIPT).toContain(name);
    }
    expect(CARD_BRIDGE_SCRIPT).toContain("postMessage");
    expect(parseSlashSend("/send 开启仙途")).toBe("开启仙途");
    expect(parseSlashSend("/send-as-user hi")).toBe("hi");
    expect(parseSlashSend("/help")).toBeNull();
  });

  it("keeps the frame's own escape hatches closed even though the policy is a deny list", async () => {
    // 黑名单是"默认放行"，所以这里锁住的是：真正危险的能力逐项在名单里，
    // 而且未实现的能力返回失败——卡脚本不会拿到假数据而做出错误决定。
    const bridge = host();
    const checked = await Promise.all(
      ["getVariables", "setVariables", "getWorldbook", "installExtension", "fetch", "eval", "parent", "top", "localStorage"]
        .map((method, index) => runCardBridgeRequest({ id: 100 + index, method, args: [] }, bridge)),
    );
    for (const result of checked) expect(result).toMatchObject({ ok: false });
    expect(vi.isMockFunction(bridge.onSend)).toBe(false);
  });
});
