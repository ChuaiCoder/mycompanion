import { describe, expect, it, vi } from "vitest";

import { conversationDetailSchema } from "@mycompanion/shared";

import { buildApp } from "./app.js";
import { countCompatibilityMessagesSync } from "./tokens/tokenizer-service.js";
import {
  apps,
  commitCard,
  lorebookCard,
  parseSse,
  setLorebookEntryEnabled,
  sseResponse,
} from "./testing/helpers.js";

describe("prompt budget (FR-PROMPT-003)", () => {
  it("emits a prompt_budget report and trims within a tight context limit", async () => {
    let generatedMessages: Array<{ role: string; content: string }> = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: unknown, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      if (payload.stream === true) generatedMessages = payload.messages;
      return sseResponse(["好的。"]);
    }));
    const app = buildApp();
    apps.push(app);
    const character = await commitCard(app, lorebookCard);
    await setLorebookEntryEnabled(app, character.id, 0, true);
    await setLorebookEntryEnabled(app, character.id, 2, true);
    // 标准 PromptManager 的 Main/New Chat framing 后，固定区域+当前输入
    // 为817 token；830能容纳它们，但不能再容纳关键词世界书和旧长消息。
    // 裁剪内容要出现在诊断里；最终估算不超过上限。
    const settings = await app.inject({
      method: "PUT",
      url: "/api/settings/provider",
      payload: {
        kind: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "test-model",
        maxTokens: 200,
        contextLimitTokens: 830,
      },
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({ contextLimitTokens: 830, maxTokens: 200 });

    const conversation = conversationDetailSchema.parse((await app.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { characterId: character.id },
    })).json());

    // 先积累几条较长的消息，让历史超出可用预算，触发“较旧消息先被裁剪”。
    for (const phrase of ["旧消息甲", "旧消息乙", "旧消息丙"]) {
      const filled = await app.inject({
        method: "POST",
        url: `/api/conversations/${conversation.id}/messages`,
        payload: { content: `${phrase}：${"字".repeat(180)}` },
      });
      expect(filled.statusCode).toBe(200);
    }

    const sent = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages`,
      payload: { content: "我们现在在工作室里吗？" },
    });
    expect(sent.statusCode).toBe(200);
    const events = parseSse(sent.body);
    const budgetEvent = events.find((event) => event.type === "prompt_budget") as {
      report: {
        contextLimitTokens: number;
        availableTokens: number;
        regions: Array<{ key: string }>;
        recentMessageCount: number;
        diagnostics: string[];
        totalTokens: number;
      };
    } | undefined;
    expect(budgetEvent).toBeDefined();
    expect(budgetEvent?.report.contextLimitTokens).toBe(830);
    // 请求级 BPE 计数包含消息 framing；关键词世界书需让位给固定内容和当前输入。
    expect(budgetEvent?.report.regions.map((region) => region.key)).toContain("character_core");
    expect(budgetEvent?.report.regions.map((region) => region.key)).toContain("worldbook_constant");
    expect(generatedMessages.some(message => message.role === "system" && message.content.includes("固定背景：地图会说话。"))).toBe(true);
    expect(budgetEvent?.report.recentMessageCount).toBeGreaterThan(0);
    expect(budgetEvent?.report.totalTokens).toBeLessThanOrEqual(830);
    // 超出预算的较早消息被丢弃，且诊断中说明。
    expect(budgetEvent?.report.diagnostics.join("")).toContain("较早消息");
    expect(budgetEvent?.report.diagnostics.join("")).toContain("世界书条目");
    expect(JSON.stringify(generatedMessages)).not.toContain("工作室建在废弃天文台内部");
    const exact = countCompatibilityMessagesSync(generatedMessages as never, "test-model", true);
    expect(budgetEvent?.report.totalTokens).toBe(exact + 712);
  });
});
