import { describe, expect, it, vi } from "vitest";

import {
  characterDetailSchema,
  conversationDetailSchema,
  memoryRecordSchema,
  stageSummarySchema,
  type ChatMessage,
  type MemoryRecord,
} from "@mycompanion/shared";

import { buildApp } from "./app.js";
import {
  apps,
  completionByKind,
  completionResponse,
  fullV2Card,
  isCompletionRequest,
  parseSse,
  sseResponse,
  waitFor,
  type TestApp,
} from "./testing/helpers.js";

describe("long-term memory (FR-MEM-001…008)", () => {
  async function setupConversation(): Promise<{
    app: TestApp;
    conversation: ReturnType<typeof conversationDetailSchema.parse>;
  }> {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(
      async (_url: URL, init?: RequestInit) =>
        (isCompletionRequest(init) ? completionByKind(init) : sseResponse(["好的。"])),
    ));
    const app = buildApp();
    apps.push(app);
    const character = characterDetailSchema.parse((await app.inject({
      method: "POST",
      url: "/api/characters/import/commit",
      payload: { filename: "ccv2-full.json", card: fullV2Card },
    })).json());
    await app.inject({
      method: "PUT",
      url: "/api/settings/provider",
      payload: { kind: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "test-model" },
    });
    const conversation = conversationDetailSchema.parse((await app.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { characterId: character.id },
    })).json());
    return { app, conversation };
  }

  const listMemory = (app: TestApp, conversationId: string, query = ""): Promise<MemoryRecord[]> =>
    app.inject({ method: "GET", url: `/api/conversations/${conversationId}/memories${query}` })
      .then((response) => {
        expect(response.statusCode).toBe(200);
        const payload = response.json() as { items: MemoryRecord[]; total: number };
        return payload.items;
      });

  it("extracts story-scope memories from completed rounds and re-injects them in later turns", async () => {
    const { app, conversation } = await setupConversation();
    const first = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages`,
      payload: { content: "我改名叫远航了。" },
    });
    const firstEvents = parseSse(first.body);
    expect(firstEvents.map((event) => event.type)).toEqual(
      ["user_message", "lorebook", "memory", "prompt_budget", "assistant_start", "delta", "done"],
    );
    // 首轮检索时尚无记忆；提取在 done 之后的后台任务中完成。
    const firstMemory = firstEvents.find((event) => event.type === "memory") as { report: { results: unknown[] } };
    expect(firstMemory.report.results).toHaveLength(0);
    const item = await waitFor(() => listMemory(app, conversation.id).then((items) => items[0]));
    expect(item).toMatchObject({
      type: "fact",
      scope: "story",
      status: "active",
      pinned: false,
      importance: 4,
    });
    expect(item.sourceMessageIds).toHaveLength(2);
    // 来源必须是本轮真实消息：用户消息与本轮助手回复。
    const userMessage = (firstEvents.find((event) => event.type === "user_message") as { message: ChatMessage }).message;
    const assistantMessage = (firstEvents.find((event) => event.type === "done") as { message: ChatMessage }).message;
    expect(item.sourceMessageIds).toContain(userMessage.id);
    expect(item.sourceMessageIds).toContain(assistantMessage.id);
    // 注入的记忆会记录最后使用时间（按 ID 定位，避免第二轮新提取的记忆排在前面）。
    expect(item.lastUsedAt).toBeNull();

    const second = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages`,
      payload: { content: "远航，我们出发吗？" },
    });
    const secondEvents = parseSse(second.body);
    const secondMemory = secondEvents.find((event) => event.type === "memory") as {
      report: { results: Array<{ memoryId: string; injected: boolean; score: number }>; block: string };
    };
    expect(secondMemory.report.results.find((result) => result.memoryId === item.id))
      .toMatchObject({ memoryId: item.id, injected: true, score: expect.any(Number) });
    expect(secondMemory.report.block).toContain("玩家改名叫远航。");
    await waitFor(() => listMemory(app, conversation.id).then((items) =>
      items.find((memory) => memory.id === item.id)?.lastUsedAt ?? undefined));
  });

  it("supports the memory center: filter, pin, edit with restore, disable, delete", async () => {
    const { app, conversation } = await setupConversation();
    await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages`,
      payload: { content: "我改名叫远航了。" },
    });
    const item = await waitFor(() => listMemory(app, conversation.id).then((items) => items[0]));
    if (!item) throw new Error("no memory extracted");

    // 筛选：状态过滤。
    expect(await listMemory(app, conversation.id, "?status=active")).toHaveLength(1);
    expect(await listMemory(app, conversation.id, "?status=superseded")).toHaveLength(0);

    // 固定 + 停用。
    let updated = memoryRecordSchema.parse((await app.inject({
      method: "PUT",
      url: `/api/conversations/${conversation.id}/memories/${item.id}`,
      payload: { pinned: true, status: "disabled" },
    })).json());
    expect(updated).toMatchObject({ pinned: true, status: "disabled", previousContent: null });

    // 编辑保留旧版本，可恢复。
    updated = memoryRecordSchema.parse((await app.inject({
      method: "PUT",
      url: `/api/conversations/${conversation.id}/memories/${item.id}`,
      payload: { content: "玩家的名字叫远航。" },
    })).json());
    expect(updated).toMatchObject({ content: "玩家的名字叫远航。", previousContent: "玩家改名叫远航。" });
    const restored = memoryRecordSchema.parse((await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/memories/${item.id}/restore`,
    })).json());
    expect(restored).toMatchObject({ content: "玩家改名叫远航。", previousContent: null, pinned: true });

    // 校验：非法字段 400，不存在的记忆 404。
    const badBody = await app.inject({
      method: "PUT",
      url: `/api/conversations/${conversation.id}/memories/${item.id}`,
      payload: { content: "" },
    });
    expect(badBody.statusCode).toBe(400);
    const missing = await app.inject({
      method: "DELETE",
      url: `/api/conversations/${conversation.id}/memories/00000000-0000-4000-8000-000000000000`,
    });
    expect(missing.statusCode).toBe(404);

    // 删除。
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/conversations/${conversation.id}/memories/${item.id}`,
    });
    expect(deleted.json()).toEqual({ deleted: true });
    expect(await listMemory(app, conversation.id)).toHaveLength(0);
  });

  it("keeps near-wording facts pending instead of guessing a temporal replacement (FR-MEM-004)", async () => {
    const { app, conversation } = await setupConversation();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(
      async (_url: URL, init?: RequestInit) => {
        if (!isCompletionRequest(init)) return sseResponse(["好的。"]);
        const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content: string }> };
        const user = body.messages?.at(-1)?.content ?? "";
        return completionResponse(
          user.includes("远行")
            ? '[{"type":"fact","content":"玩家改名叫远行。","importance":4}]'
            : '[{"type":"fact","content":"玩家改名叫远航。","importance":4}]',
        );
      },
    ));
    await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/messages`, payload: { content: "我改名叫远航了。" } });
    await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/messages`, payload: { content: "其实我改名叫远行。" } });
    const items = await waitFor(() => listMemory(app, conversation.id).then((value) => (value.length >= 2 ? value : undefined)));
    const statuses = items.map((memory) => memory.status).sort();
    expect(statuses).toEqual(["active", "pending"]);
    expect(items.find(memory => memory.status === "active")?.supersededBy).toBeNull();
    expect(items.find(memory => memory.status === "pending")?.reconciliation?.kind).toBe("uncertain");
    // 未核实的相近新记录不注入，但来源和规则理由仍可见。
    const test = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/memories/test`,
      payload: { input: "远航" },
    });
    const report = test.json() as { results: Array<{ memoryId: string; injected: boolean; diagnostics: string[] }> };
    expect(report.results.find(result => result.memoryId === items.find(memory => memory.status === "pending")?.id)?.injected).toBe(false);
    expect(report.results.filter((result) => result.diagnostics.join("").includes("待确认")).length).toBe(1);
  });

  it("orphans memories whose sources left the branch and restores them on re-activation (FR-MEM-008)", async () => {
    const { app, conversation } = await setupConversation();
    const firstBranchId = conversation.activeBranchId;
    await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/messages`, payload: { content: "我改名叫远航了。" } });
    const item = await waitFor(() => listMemory(app, conversation.id).then((items) => items[0]));
    if (!item) throw new Error("no memory extracted");

    // 重新生成：在最后一个用户消息处分叉，旧助手回复留在原分支 → 来源不再全部可达。
    const regen = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages/regenerate`,
    });
    expect(regen.statusCode).toBe(200);
    await waitFor(() => listMemory(app, conversation.id).then((items) =>
      items.find(memory => memory.id === item.id && memory.status === "orphaned")));
    const orphaned = await listMemory(app, conversation.id, "?status=orphaned");
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0]?.id).toBe(item.id);

    // 回到原分支：来源重新可达，记忆恢复 active。
    const switched = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/branches/${firstBranchId}/activate`,
    });
    expect(switched.statusCode).toBe(200);
    await waitFor(() => listMemory(app, conversation.id).then((items) =>
      items.find(memory => memory.id === item.id && memory.status === "active")));
  });

  it("manages the stage summary: edit, restore, auto toggle (FR-MEM-006)", async () => {
    const { app, conversation } = await setupConversation();

    // 自动摘要开关。
    const autoOff = await app.inject({
      method: "PUT",
      url: `/api/conversations/${conversation.id}/summary/auto`,
      payload: { enabled: false },
    });
    expect(autoOff.json()).toMatchObject({ autoSummaryEnabled: false });
    const autoBad = await app.inject({
      method: "PUT",
      url: `/api/conversations/${conversation.id}/summary/auto`,
      payload: { enabled: "yes" },
    });
    expect(autoBad.statusCode).toBe(400);

    // 手动编辑（无旧摘要时创建）+ 恢复上一版本。
    const edited = stageSummarySchema.parse((await app.inject({
      method: "PUT",
      url: `/api/conversations/${conversation.id}/summary`,
      payload: { content: "手动摘要。" },
    })).json());
    expect(edited.content).toBe("手动摘要。");
    const editedAgain = stageSummarySchema.parse((await app.inject({
      method: "PUT",
      url: `/api/conversations/${conversation.id}/summary`,
      payload: { content: "第二次摘要。" },
    })).json());
    expect(editedAgain.previousContent).toBe("手动摘要。");
    const restored = stageSummarySchema.parse((await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/summary/restore`,
    })).json());
    expect(restored.content).toBe("手动摘要。");
    expect(restored.previousContent).toBeNull();

    // 读取。
    const fetched = await app.inject({ method: "GET", url: `/api/conversations/${conversation.id}/summary` });
    expect(fetched.json()).toMatchObject({ autoSummaryEnabled: false, summary: { content: "手动摘要。" } });
  });
});
