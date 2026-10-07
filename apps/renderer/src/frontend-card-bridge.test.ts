import { describe, expect, it, vi } from "vitest";
import type { CardVariableMutation, ChatMessage } from "@mycompanion/shared";
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

const host = (messages: ChatMessage[] = [message()]): CardBridgeHost & {
  swipes: Array<[string, number]>;
  sent: string[];
  variables: Record<string, Record<string, unknown>>;
  writes: CardVariableMutation[];
  lorebooks: Record<string, Record<string, unknown>>;
  deleted: string[];
  triggered: number;
} => {
  const swipes: Array<[string, number]> = [];
  const sent: string[] = [];
  // 用一个内存实现替身模拟三级存储，测试桥的语义而不重复后端的落点逻辑。
  const variables: Record<string, Record<string, unknown>> = { global: {}, chat: {}, message: {} };
  const writes: CardVariableMutation[] = [];
  const lorebooks: Record<string, Record<string, unknown>> = {};
  const deleted: string[] = [];
  let triggered = 0;
  return {
    messages, characterName: "道渊", swipes, sent, variables, writes, lorebooks, deleted,
    get triggered() { return triggered; },
    onSelectSwipe: async (messageId, swipeId) => { swipes.push([messageId, swipeId]); },
    onSend: text => { sent.push(text); },
    onDeleteMessage: async (messageId) => { deleted.push(messageId); },
    onTrigger: () => { triggered++; },
    onReadVariables: async target => {
      const scope = target?.type ?? "merged";
      if (scope === "merged") return { ...variables.global, ...variables.chat, ...variables.message };
      return variables[scope] ?? {};
    },
    onWriteVariables: async mutation => {
      writes.push(mutation);
      const scope = mutation.type === "global" ? "global" : mutation.type === "message" ? "message" : "chat";
      const store = variables[scope]!;
      if (mutation.action === "replace") variables[scope] = { ...mutation.values };
      else if (mutation.action === "insert") {
        for (const [key, value] of Object.entries(mutation.values)) if (!Object.hasOwn(store, key)) store[key] = value;
      } else if (mutation.action === "set") {
        if (mutation.remove) delete store[mutation.key]; else store[mutation.key] = mutation.value;
      } else if (mutation.subject === "key") delete store[String(mutation.target)];
    },
    onListLorebooks: async () => Object.keys(lorebooks),
    onReadLorebook: async name => lorebooks[name] ?? null,
    onWriteLorebook: async (name, document) => { lorebooks[name] = document; },
  };
};

describe("card capability bridge", () => {
  it("denies only unimplemented and sandbox-escaping capabilities while allowing the card's own calls", () => {
    // 策略已改为默认放行：名单只保留"未实现"与"结构性逃逸入口"两类。
    for (const method of ["generate", "installExtension", "registerVariableSchema", "fetch", "eval", "parent", "top", "localStorage"]) {
      expect(isCardApiAllowed(method)).toBe(false);
    }
    // 卡片实际使用的 API 必须放行，否则开场流程走不通。
    for (const method of ["getChatMessages", "setChatMessage", "triggerSlash", "getVariables", "setVariables",
      "getLorebooks", "createLorebook", "createLorebookEntry", "getWorldbook", "setCharacter"]) {
      expect(isCardApiAllowed(method)).toBe(true);
    }
    // 名单本身保持可审计，且明显比"逐项禁止一切"更短。
    expect(CARD_API_DENYLIST.length).toBeGreaterThan(10);
    expect(CARD_API_DENYLIST.length).toBeLessThan(40);
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
    const denied = await runCardBridgeRequest({ id: 6, method: "registerVariableSchema", args: [{}] }, bridge);
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

  it("creates a lorebook and injects entries the way the card's opening does", async () => {
    const bridge = host();
    // 卡的创建流程：先建书，再逐条注入功法/气运/天定道侣。
    expect(await runCardBridgeRequest({ id: 60, method: "getLorebooks", args: [] }, bridge))
      .toEqual({ id: 60, ok: true, value: [] });
    expect(await runCardBridgeRequest({ id: 61, method: "createLorebook", args: ["道渊开局创建人物"] }, bridge))
      .toEqual({ id: 61, ok: true, value: true });
    expect(bridge.lorebooks["道渊开局创建人物"]).toEqual({ entries: {} });

    const entry = { type: "constant", position: "before_character_definition", order: 100, comment: "甲-功法设定", content: "【甲的主修功法】：御剑" };
    expect(await runCardBridgeRequest({ id: 62, method: "createLorebookEntry", args: ["道渊开局创建人物", entry] }, bridge))
      .toEqual({ id: 62, ok: true, value: true });
    const document = bridge.lorebooks["道渊开局创建人物"]!;
    expect(Object.values(document.entries as Record<string, unknown>)).toHaveLength(1);
    expect(Object.values(document.entries as Record<string, unknown>)[0]).toMatchObject({ comment: "甲-功法设定", type: "constant" });

    // 只建书、不注入内容：不能把已有条目清空。
    await runCardBridgeRequest({ id: 63, method: "createLorebook", args: ["道渊开局创建人物"] }, bridge);
    expect(Object.values((bridge.lorebooks["道渊开局创建人物"]!.entries as Record<string, unknown>))).toHaveLength(1);

    // 同 comment 再次注入应覆盖而不是重复追加。
    await runCardBridgeRequest({ id: 64, method: "createLorebookEntry", args: ["道渊开局创建人物", { ...entry, content: "【甲的主修功法】：炼丹" }] }, bridge);
    const after = Object.values(bridge.lorebooks["道渊开局创建人物"]!.entries as Record<string, unknown>);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ content: "【甲的主修功法】：炼丹" });
  });

  it("runs the card's chained opening command and refuses unsupported ones", async () => {
    const bridge = host();
    // 卡的开局指令形态：/sys 正文 | /cut <id> | /trigger
    const lastId = bridge.messages.at(-1)!.id;
    const result = await runCardBridgeRequest({
      id: 70, method: "triggerSlash",
      args: [`/sys [仙缘已定]\n**道号**: 甲 | /cut ${lastId} | /trigger`],
    }, bridge);
    expect(result).toEqual({ id: 70, ok: true, value: "" });
    // /sys 当作一次用户发言
    expect(bridge.sent).toHaveLength(1);
    expect(bridge.sent[0]).toContain("仙缘已定");
    // /cut 删掉占位消息
    expect(bridge.deleted).toEqual([lastId]);
    // /trigger 触发一次生成
    expect(bridge.triggered).toBe(1);

    // 不支持的指令要明确失败，而不是静默忽略
    const unsupported = await runCardBridgeRequest({ id: 71, method: "triggerSlash", args: ["/extension install evil"] }, bridge);
    expect(unsupported).toMatchObject({ id: 71, ok: false });
    expect((unsupported as { error: string }).error).toContain("未支持");
  });

  it("implements the variable API independently of the macro engine", async () => {
    const bridge = host();
    // 变量曾经在黑名单里；现在必须真的可读写，而不是返回"未实现"。
    expect(isCardApiAllowed("getVariables")).toBe(true);
    expect(isCardApiAllowed("setVariables")).toBe(true);
    expect(isCardApiAllowed("replaceVariables")).toBe(true);
    expect(isCardApiAllowed("insertVariables")).toBe(true);
    expect(isCardApiAllowed("deleteVariable")).toBe(true);
    // 未实现的两项仍应被拒绝，避免卡片以为环境完整。
    expect(isCardApiAllowed("registerVariableSchema")).toBe(false);
    expect(isCardApiAllowed("updateVariablesWith")).toBe(false);

    const write = await runCardBridgeRequest({ id: 20, method: "setVariables", args: [{ hp: 10, mp: 5 }, { type: "chat" }] }, bridge);
    expect(write).toEqual({ id: 20, ok: true, value: true });
    expect(bridge.variables.chat).toEqual({ hp: 10, mp: 5 });

    const read = await runCardBridgeRequest({ id: 21, method: "getVariables", args: [{ type: "chat" }] }, bridge);
    expect(read).toEqual({ id: 21, ok: true, value: { hp: 10, mp: 5 } });

    // 不给作用域时是合并视图（消息级 > 故事级 > 全局）
    await runCardBridgeRequest({ id: 22, method: "setVariables", args: [{ hp: 99 }, { type: "global" }] }, bridge);
    const merged = await runCardBridgeRequest({ id: 23, method: "getVariables", args: [{}] }, bridge);
    expect(merged).toEqual({ id: 23, ok: true, value: { hp: 10, mp: 5 } });
  });

  it("keeps insertVariables from overwriting while insertOrAssign does overwrite", async () => {
    const bridge = host();
    await runCardBridgeRequest({ id: 30, method: "setVariables", args: [{ keep: "原值" }, { type: "chat" }] }, bridge);

    await runCardBridgeRequest({ id: 31, method: "insertVariables", args: [{ keep: "新值", added: 1 }, { type: "chat" }] }, bridge);
    expect(bridge.variables.chat).toEqual({ keep: "原值", added: 1 });

    await runCardBridgeRequest({ id: 32, method: "insertOrAssignVariables", args: [{ keep: "新值" }, { type: "chat" }] }, bridge);
    expect(bridge.variables.chat).toEqual({ keep: "新值", added: 1 });
  });

  it("maps a numeric message id to that message instead of assuming the latest", async () => {
    const first = message();
    const second = message({ id: "44444444-4444-4444-8444-444444444444", content: "第二条" });
    const bridge = host([first, second]);

    const written = await runCardBridgeRequest({ id: 40, method: "setVariables", args: [{ here: 1 }, { type: "message", message_id: 0 }] }, bridge);
    expect(written).toEqual({ id: 40, ok: true, value: true });
    // 必须落在第 0 条消息上，而不是最后一条。
    expect(bridge.writes.at(-1)!.messageId).toBe(first.id);

    // 越界序号要明确失败，而不是静默写到别的消息。
    const outOfRange = await runCardBridgeRequest({ id: 41, method: "setVariables", args: [{ x: 1 }, { type: "message", message_id: 9 }] }, bridge);
    expect(outOfRange).toMatchObject({ id: 41, ok: false });

    // 省略 message_id → 最后一条
    await runCardBridgeRequest({ id: 42, method: "setVariables", args: [{ y: 1 }, { type: "message" }] }, bridge);
    expect(bridge.writes.at(-1)!.messageId).toBe(second.id);
  });

  it("deletes a variable by name and refuses a missing key", async () => {
    const bridge = host();
    await runCardBridgeRequest({ id: 50, method: "setVariables", args: [{ doomed: 1 }, { type: "chat" }] }, bridge);
    const removed = await runCardBridgeRequest({ id: 51, method: "deleteVariable", args: [{ key: "doomed", type: "chat" }] }, bridge);
    expect(removed).toEqual({ id: 51, ok: true, value: true });
    expect(bridge.variables.chat).toEqual({});

    const noKey = await runCardBridgeRequest({ id: 52, method: "deleteVariable", args: [{ type: "chat" }] }, bridge);
    expect(noKey).toMatchObject({ id: 52, ok: false });
  });

  it("ships a bridge script that installs the API before card scripts run", () => {
    // 卡片脚本用 `typeof getChatMessages !== 'undefined'` 判断能力是否存在，因此桥必须先挂好。
    // 变量函数也必须在注入脚本里定义——宿主侧实现而没挂到 window 上，卡片仍会走降级分支
    // （这正是真机验证抓到过的缺口）。
    const names = [
      "getChatMessages", "setChatMessage", "triggerSlash", "TavernHelper",
      "getVariables", "getAllVariables", "replaceVariables", "insertVariables",
      "insertOrAssignVariables", "setVariables", "deleteVariable",
      "triggerSlash", "executeSlashCommands", "createLorebook", "createLorebookEntry",
    ];
    for (const name of names) {
      expect(CARD_BRIDGE_SCRIPT).toContain(`window.${name} =`);
    }
    expect(CARD_BRIDGE_SCRIPT).toContain("postMessage");
    expect(parseSlashSend("/send 开启仙途")).toBe("开启仙途");
    expect(parseSlashSend("/send-as-user hi")).toBe("hi");
    expect(parseSlashSend("/help")).toBeNull();

    // 仅仅断言"出现过 window.X ="是不够的：别名行 `window.TavernHelper.triggerSlash = window.triggerSlash`
    // 同样包含这个子串，而真正的定义可以完全不存在（实测就漏过了这个缺口，
    // 导致卡片 `typeof triggerSlash === 'function'` 判假、静默不发送开局指令）。
    // 因此这里**真正求值**桥脚本，逐一确认每个名字都可用。
    const sandbox: Record<string, unknown> = { addEventListener: () => {} };
    const bridgeWindow = new Proxy(sandbox, {
      get: (target, key) => (typeof key === "string" && key in target ? target[key] : undefined),
      set: (target, key, value) => { if (typeof key === "string") target[key] = value; return true; },
    });
    const run = new Function("window", "document", "CARD_BRIDGE_REQUEST", CARD_BRIDGE_SCRIPT);
    run(bridgeWindow, { addEventListener: () => {} }, CARD_BRIDGE_REQUEST);
    for (const name of names) {
      if (name === "TavernHelper") continue;
      expect(typeof sandbox[name], `window.${name} 必须是可调用的函数`).toBe("function");
    }
    expect(typeof sandbox.TavernHelper).toBe("object");
    // TavernHelper 上的别名同样必须真的指向函数。
    const helper = sandbox.TavernHelper as Record<string, unknown>;
    expect(typeof helper.triggerSlash).toBe("function");
    expect(typeof helper.getChatMessages).toBe("function");
  });

  it("keeps the frame's own escape hatches closed even though the policy is a deny list", async () => {
    // 黑名单是"默认放行"，所以这里锁住的是：真正危险的能力逐项在名单里，
    // 而且未实现的能力返回失败——卡脚本不会拿到假数据而做出错误决定。
    const bridge = host();
    const checked = await Promise.all(
      ["generate", "installExtension", "fetch", "eval", "parent", "top", "localStorage", "registerVariableSchema"]
        .map((method, index) => runCardBridgeRequest({ id: 100 + index, method, args: [] }, bridge)),
    );
    for (const result of checked) expect(result).toMatchObject({ ok: false });
    expect(vi.isMockFunction(bridge.onSend)).toBe(false);
  });
});
