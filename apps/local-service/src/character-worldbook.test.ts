import { describe, expect, it, vi } from "vitest";

import {
  characterDetailSchema,
  conversationDetailSchema,
} from "@mycompanion/shared";

import { buildApp } from "./app.js";
import {
  apps,
  commitCard,
  completionResponse,
  isCompletionRequest,
  lorebookCard,
  parseSse,
  setLorebookEntryEnabled,
  sseResponse,
} from "./test-helpers.js";

describe("character worldbook (FR-LORE-001/002/003)", () => {
  it("lists imported entries as disabled by default and persists enable state", async () => {
    const app = buildApp();
    apps.push(app);
    const character = await commitCard(app, lorebookCard);

    const listed = await app.inject({ method: "GET", url: `/api/characters/${character.id}/lorebook` });
    expect(listed.statusCode).toBe(200);
    const body = listed.json() as { characterId: string; entries: Array<{ index: number; enabled: boolean; sourceEnabled: boolean }> };
    expect(body.characterId).toBe(character.id);
    expect(body.entries).toHaveLength(3);
    // 导入默认全部停用；卡内自带的 enabled 值只作为展示（sourceEnabled）。
    expect(body.entries.every((entry) => entry.enabled === false)).toBe(true);
    expect(body.entries.map((entry) => entry.sourceEnabled)).toEqual([true, false, true]);

    const enabled = await setLorebookEntryEnabled(app, character.id, 0, true);
    expect(enabled.find((entry) => entry.index === 0)?.enabled).toBe(true);
    expect(enabled.find((entry) => entry.index === 1)?.enabled).toBe(false);

    // 重新读取角色详情时，启用状态仍然生效（持久化在 characters 表）。
    const reloaded = characterDetailSchema.parse(
      (await app.inject({ method: "GET", url: `/api/characters/${character.id}` })).json(),
    );
    expect(reloaded.lorebookEnabled).toHaveLength(3);
    expect(reloaded.lorebookEnabled.find((entry) => entry.index === 0)?.enabled).toBe(true);

    const allOn = await app.inject({
      method: "PUT",
      url: `/api/characters/${character.id}/lorebook/all`,
      payload: { enabled: true },
    });
    expect(allOn.statusCode).toBe(200);
    expect((allOn.json() as Array<{ enabled: boolean }>).every((entry) => entry.enabled)).toBe(true);

    // 不存在的序号返回 404；非法请求体返回 400。
    const missing = await app.inject({
      method: "PUT",
      url: `/api/characters/${character.id}/lorebook/9`,
      payload: { enabled: true },
    });
    expect(missing.statusCode).toBe(404);
    const badBody = await app.inject({
      method: "PUT",
      url: `/api/characters/${character.id}/lorebook/0`,
      payload: { enabled: "yes" },
    });
    expect(badBody.statusCode).toBe(400);
  });

  it("injects matched entries into the prompt without changing stored messages", async () => {
    let providerRequest: { messages?: Array<{ role: string; content: string }> } | undefined;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(
      async (_url: URL, init?: RequestInit) => {
        if (isCompletionRequest(init)) return completionResponse();
        providerRequest = JSON.parse(String(init?.body)) as typeof providerRequest;
        return sseResponse(["好的，我带你去。"]);
      },
    ));
    const app = buildApp();
    apps.push(app);
    const character = await commitCard(app, lorebookCard);
    // 启用关键词条目（index 0）和常驻条目（index 2）。
    await setLorebookEntryEnabled(app, character.id, 0, true);
    await setLorebookEntryEnabled(app, character.id, 2, true);
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

    const sent = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages`,
      payload: { content: "我们现在在工作室里吗？" },
    });
    expect(sent.statusCode).toBe(200);
    const events = parseSse(sent.body);

    // lorebook 事件：命中“工作室”，常驻条目无条件注入；未启用的天文台条目为 disabled。
    const lorebookEvent = events.find((event) => event.type === "lorebook") as {
      report: {
        block: string;
        injectedCount: number;
        position: string;
        results: Array<{ index: number; status: string; matchedKey: string | null }>;
      };
    } | undefined;
    expect(lorebookEvent?.report.injectedCount).toBe(2);
    expect(lorebookEvent?.report.position).toBe("after_character_core");
    // 酒馆优先选取高 order，拼接提示词时通过 unshift 将低 order 放在前面。
    expect(lorebookEvent?.report.block).toBe("工作室建在废弃天文台内部。\n\n固定背景：地图会说话。");
    const results = lorebookEvent?.report.results ?? [];
    expect(results.find((result) => result.index === 0)?.status).toBe("injected");
    expect(results.find((result) => result.index === 0)?.matchedKey).toBe("工作室");
    expect(results.find((result) => result.index === 1)?.status).toBe("disabled");
    expect(results.find((result) => result.index === 2)?.status).toBe("injected");

    // 世界书只进入系统提示词副本；已保存的聊天原文不变。
    expect(providerRequest?.messages?.some(message => message.role === "system" && message.content.includes("固定背景：地图会说话。"))).toBe(true);
    expect(providerRequest?.messages?.some(message => message.role === "system" && message.content.includes("工作室建在废弃天文台内部。"))).toBe(true);
    expect(providerRequest?.messages?.findLast(message => message.role === "user")).toMatchObject({
      role: "user",
      content: "我们现在在工作室里吗？",
    });
    const reloaded = conversationDetailSchema.parse((await app.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}`,
    })).json());
    expect(reloaded.messages.find((message) => message.role === "user")?.content).toBe("我们现在在工作室里吗？");
  });

  it("sends no worldbook block when nothing is enabled or matched", async () => {
    let providerRequest: { messages?: Array<{ role: string; content: string }> } | undefined;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(
      async (_url: URL, init?: RequestInit) => {
        if (isCompletionRequest(init)) return completionResponse();
        providerRequest = JSON.parse(String(init?.body)) as typeof providerRequest;
        return sseResponse(["嗯。"]);
      },
    ));
    const app = buildApp();
    apps.push(app);
    const character = await commitCard(app, lorebookCard);
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

    // 即使启用条目，文本未命中关键词且非常驻时也不注入。
    await setLorebookEntryEnabled(app, character.id, 1, true);
    const sent = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages`,
      payload: { content: "今天天气如何？" },
    });
    const events = parseSse(sent.body);
    const lorebookEvent = events.find((event) => event.type === "lorebook") as { report: { block: string; injectedCount: number } } | undefined;
    expect(lorebookEvent?.report.injectedCount).toBe(0);
    expect(lorebookEvent?.report.block).toBe("");
    expect(providerRequest?.messages?.[0]?.content).not.toContain("World book:");
  });

  it("runs the lorebook tester on sample text without touching real conversations", async () => {
    const app = buildApp();
    apps.push(app);
    const character = await commitCard(app, lorebookCard);
    await setLorebookEntryEnabled(app, character.id, 0, true);
    await setLorebookEntryEnabled(app, character.id, 2, true);

    const tested = await app.inject({
      method: "POST",
      url: `/api/characters/${character.id}/lorebook/test`,
      payload: { input: "我们回到工作室吧。" },
    });
    expect(tested.statusCode).toBe(200);
    const report = tested.json() as {
      characterId: string;
      block: string;
      injectedCount: number;
      results: Array<{ index: number; status: string; matchedKey: string | null }>;
    };
    expect(report.characterId).toBe(character.id);
    expect(report.injectedCount).toBe(2);
    expect(report.results.find((result) => result.index === 0)?.matchedKey).toBe("工作室");
    expect(report.results.find((result) => result.index === 1)?.status).toBe("disabled");
    expect(report.block).toContain("地图会说话");

    // 测试器不创建或修改真实聊天。
    const conversations = await app.inject({ method: "GET", url: "/api/conversations" });
    expect(conversations.json()).toMatchObject({ total: 0 });

    // 未命中时报告 no_match 且没有注入块。
    const noMatch = await app.inject({
      method: "POST",
      url: `/api/characters/${character.id}/lorebook/test`,
      payload: { input: "完全无关的文本。" },
    });
    const noMatchReport = noMatch.json() as { injectedCount: number; results: Array<{ index: number; status: string }> };
    expect(noMatchReport.injectedCount).toBe(1); // 只有常驻条目
    expect(noMatchReport.results.find((result) => result.index === 0)?.status).toBe("no_match");
  });

  it("returns 404 from the tester for an unknown character and 400 for oversized input", async () => {
    const app = buildApp();
    apps.push(app);
    const unknown = await app.inject({
      method: "POST",
      url: "/api/characters/00000000-0000-4000-8000-000000000000/lorebook/test",
      payload: { input: "x" },
    });
    expect(unknown.statusCode).toBe(404);

    const character = await commitCard(app, lorebookCard);
    const oversized = await app.inject({
      method: "POST",
      url: `/api/characters/${character.id}/lorebook/test`,
      payload: { input: "a".repeat(1024 * 1024 + 1) },
    });
    expect(oversized.statusCode).toBe(400);
  });
});
