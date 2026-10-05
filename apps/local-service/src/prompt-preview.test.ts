import { describe, expect, it, vi } from "vitest";

import {
  characterDetailSchema,
  conversationDetailSchema,
  promptPreviewResponseSchema,
} from "@mycompanion/shared";

import { buildApp } from "./app.js";
import {
  apps,
  completionResponse,
  fullV2Card,
  isCompletionRequest,
  sseResponse,
  type TestApp,
} from "./testing/helpers.js";

describe("提示词预览 (FR-PROMPT-004)", () => {
  async function setupPreview(): Promise<{
    app: TestApp;
    conversation: ReturnType<typeof conversationDetailSchema.parse>;
  }> {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(
      async (_url: URL, init?: RequestInit) =>
        (isCompletionRequest(init) ? completionResponse("[]") : sseResponse(["好的。"])),
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

  it("assembles the exact pre-send prompt with per-region token estimates", async () => {
    const { app, conversation } = await setupPreview();
    await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages`,
      payload: { content: "我们明天出发吗？" },
    });
    const preview = promptPreviewResponseSchema.parse((await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/prompt-preview`,
      payload: { draft: "带上地图。" },
    })).json());
    // 系统提示词 + 草稿作为当前用户输入必然保留。
    expect(preview.messages.at(0)?.role).toBe("system");
    const draftMessage = preview.messages.find((message) => message.content.includes("带上地图。"));
    expect(draftMessage?.role).toBe("user");
    // 区域按 FR-PROMPT-002 顺序：角色核心在前，Post-History 在后。
    const regionKeys = preview.regions.map((region) => region.key);
    expect(regionKeys).toContain("character_core");
    expect(regionKeys).toContain("post_history");
    expect(regionKeys[0]).toBe("character_core");
    expect(regionKeys.at(-1)).toBe("post_history");
    expect(preview.regions.every((region) => region.tokens > 0)).toBe(true);
    // 总 token = 各区域 + 近期消息 + 预留；至少覆盖区域之和。
    const regionTotal = preview.regions.reduce((sum, region) => sum + region.tokens, 0);
    expect(preview.totalTokens).toBeGreaterThanOrEqual(regionTotal);
    expect(preview.recentMessageCount).toBeGreaterThanOrEqual(1);
  });

  it("redacts credentials and sensitive fields from the previewed prompt", async () => {
    const { app, conversation } = await setupPreview();
    const preview = promptPreviewResponseSchema.parse((await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/prompt-preview`,
      payload: { draft: "密钥是 sk-abcdefgh1234567890 对吗？" },
    })).json());
    // sk- 开头的密钥被替换为脱敏标记。
    expect(preview.messages.some((message) => message.content.includes("sk-abcdefgh1234567890"))).toBe(false);
    expect(preview.messages.some((message) => message.content.includes("••••"))).toBe(true);
    expect(preview.redactions).toBeGreaterThanOrEqual(1);
  });

  it("redacts the stored provider API key from the preview", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(
      async (_url: URL, init?: RequestInit) =>
        (isCompletionRequest(init) ? completionResponse("[]") : sseResponse(["好的。"])),
    ));
    // 带安全存储的应用：保存真实 API key，预览时用它做脱敏。
    const app = buildApp({
      secretCodec: { seal: (value) => `sealed:${value}`, unseal: (value) => value.slice(7) },
    });
    apps.push(app);
    const character = characterDetailSchema.parse((await app.inject({
      method: "POST",
      url: "/api/characters/import/commit",
      payload: { filename: "ccv2-full.json", card: fullV2Card },
    })).json());
    const saved = await app.inject({
      method: "PUT",
      url: "/api/settings/provider",
      payload: {
        kind: "openai-compatible",
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "test-model",
        apiKey: "sk-stored-key-abcdef123456",
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ hasApiKey: true });
    const conversation = conversationDetailSchema.parse((await app.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { characterId: character.id },
    })).json());
    const preview = promptPreviewResponseSchema.parse((await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/prompt-preview`,
      payload: { draft: "我的 token 是 sk-stored-key-abcdef123456。" },
    })).json());
    // 真实保存的 key 不进入预览；脱敏计数大于 0。
    expect(preview.messages.some((message) => message.content.includes("sk-stored-key-abcdef123456"))).toBe(false);
    expect(preview.redactions).toBeGreaterThanOrEqual(1);
  });

  it("omits the draft when previewing only the current branch", async () => {
    const { app, conversation } = await setupPreview();
    await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages`,
      payload: { content: "第一句。" },
    });
    const preview = promptPreviewResponseSchema.parse((await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/prompt-preview`,
      payload: {},
    })).json());
    expect(preview.messages.some((message) => message.content.includes("第一句。"))).toBe(true);
  });

  it("returns 404 for an unknown conversation and 400 for an invalid draft", async () => {
    const { app, conversation } = await setupPreview();
    const missing = await app.inject({
      method: "POST",
      url: "/api/conversations/00000000-0000-4000-8000-000000000000/prompt-preview",
      payload: {},
    });
    expect(missing.statusCode).toBe(404);
    const badDraft = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/prompt-preview`,
      payload: { draft: 42 },
    });
    expect(badDraft.statusCode).toBe(400);
    const tooLong = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/prompt-preview`,
      payload: { draft: "长".repeat(100_001) },
    });
    expect(tooLong.statusCode).toBe(400);
  });

  it("redacts the draft in preview while the identical redacted prompt goes to generation", async () => {
    const { app, conversation } = await setupPreview();
    const draft = "带上地图。";
    const previewResponse = await app.inject({ method: "POST",
      url: `/api/conversations/${conversation.id}/prompt-preview`, payload: { draft } });
    expect(previewResponse.statusCode).toBe(200);
    const preview = promptPreviewResponseSchema.parse(previewResponse.json());

    const secret = "sk-abcdefgh1234567890";
    const privatePreview = promptPreviewResponseSchema.parse((await app.inject({ method: "POST",
      url: `/api/conversations/${conversation.id}/prompt-preview`, payload: { draft: `密钥是 ${secret}` } })).json());
    expect(JSON.stringify(privatePreview.messages)).not.toContain(secret);
    // 预览本身不写入故事：预览之后、发送之前的状态与预览前一致。
    const previewOnly = (await app.inject({ method: "GET", url: `/api/conversations/${conversation.id}` })).json();
    expect(previewOnly.messages).toEqual(conversation.messages);

    // 真实生成收到与预览完全一致的消息。
    const providerRequests: unknown[][] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: URL, init?: RequestInit) => {
      if (isCompletionRequest(init)) return completionResponse("[]");
      providerRequests.push((JSON.parse(String(init?.body)) as { messages: unknown[] }).messages);
      return sseResponse(["好的。"]);
    }));
    const sent = await app.inject({ method: "POST",
      url: `/api/conversations/${conversation.id}/messages`, payload: { content: draft } });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(providerRequests.at(-1)).toEqual(preview.messages);
  });

  it("uses provider token limits in both card and worldbook macros", async () => {
    const { app, conversation } = await setupPreview();
    const book = await app.inject({ method: "POST", url: "/api/worldinfo/edit", payload: {
      name: "request-budget-book", data: { entries: {
        1: { uid: 1, key: ["budget=1920"], keysecondary: [],
          content: "WORLD={{maxPrompt}}/{{maxContext}}/{{maxResponse}}", disable: false, position: 1 },
      } },
    } });
    expect(book.statusCode, book.body).toBe(200);
    const current = (await app.inject({ method: "GET", url: "/api/worldinfo/settings" })).json();
    const selected = await app.inject({ method: "PUT", url: "/api/worldinfo/settings", payload: {
      ...current, world_info: { globalSelect: ["request-budget-book"], charLore: [] },
    } });
    expect(selected.statusCode, selected.body).toBe(200);
    await app.inject({ method: "PUT", url: "/api/settings/provider", payload: {
      kind: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "test-model",
      contextLimitTokens: 2048, maxTokens: 128,
    } });

    const scan = await app.inject({ method: "POST", url: "/api/worldinfo/prompt", payload: {
      chat: ["budget=1920"], characterId: conversation.characterId, conversationId: conversation.id,
      maxContext: 2048, maxResponseTokens: 128, commitVariables: false,
    } });
    expect(scan.statusCode, scan.body).toBe(200);
    expect(scan.json().report.block).toBe("WORLD=1920/2048/128");
    const response = await app.inject({ method: "POST",
      url: `/api/conversations/${conversation.id}/prompt-preview`, payload: { draft: "budget=1920" } });
    expect(response.statusCode, response.body).toBe(200);
    const text = response.json().messages.map((message: { content: string }) => message.content).join("\n");
    expect(text).toContain("WORLD=1920/2048/128");
  });

  it("keeps prompt preview read-only and deterministic across repeated calls", async () => {
    const { app, conversation } = await setupPreview();
    const prompt = { key: "outlet", value: "OUTLET_ANCHOR", position: 0,
      depth: 0, scan: true, role: 0 };
    const call = () => app.inject({ method: "POST",
      url: `/api/conversations/${conversation.id}/prompt-preview`,
      payload: { draft: "继续。", extensionPrompts: [prompt] } });
    const first = await call(), second = await call();
    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    // 预览不提交宏副作用：两次预览输出一致，已保存变量不变。
    expect(second.json().messages).toEqual(first.json().messages);
    const chat = (await app.inject({ method: "GET", url: `/api/conversations/${conversation.id}` })).json();
    expect(chat.chatMetadata.variables ?? {}).toEqual(conversation.chatMetadata?.variables ?? {});
  });

  it("keeps card examples from the character card and drops them when the card empties mes_example", async () => {
    const { app, conversation } = await setupPreview();
    const draft = "带上地图。";
    const preview = promptPreviewResponseSchema.parse((await app.inject({ method: "POST",
      url: `/api/conversations/${conversation.id}/prompt-preview`, payload: { draft } })).json());
    expect(preview.messages.some(message => message.content.includes("小心纸张边缘"))).toBe(true);
    // 角色卡显式清空示例后，预览不再包含示例。
    const exported = await app.inject({ method: "GET", url: `/api/characters/${conversation.characterId}/export?format=json` });
    const card = exported.json() as { data: Record<string, unknown> };
    card.data.mes_example = "";
    const updated = await app.inject({ method: "PUT", url: `/api/characters/${conversation.characterId}`, payload: { card } });
    expect(updated.statusCode, updated.body).toBe(200);
    const filtered = promptPreviewResponseSchema.parse((await app.inject({ method: "POST",
      url: `/api/conversations/${conversation.id}/prompt-preview`, payload: { draft } })).json());
    expect(filtered.messages.some(message => message.content.includes("小心纸张边缘"))).toBe(false);
  });
});
