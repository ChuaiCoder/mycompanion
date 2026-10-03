import { describe, expect, it, vi } from "vitest";

import {
  characterDetailSchema,
  conversationDetailSchema,
  promptPreviewResponseSchema,
  toExtensionChatState,
} from "@mycompanion/shared";

import { buildApp } from "./app.js";
import {
  apps,
  completionResponse,
  fullV2Card,
  isCompletionRequest,
  sseResponse,
  type TestApp,
} from "./test-helpers.js";

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

  it("assembles identical native and extension messages for the same text turn without exposing redacted preview text to generation", async () => {
    const { app, conversation } = await setupPreview();
    const draft = "带上地图。";
    const previewResponse = await app.inject({ method: "POST",
      url: `/api/conversations/${conversation.id}/prompt-preview`, payload: { draft } });
    expect(previewResponse.statusCode).toBe(200);
    const preview = promptPreviewResponseSchema.parse(previewResponse.json());
    const extensionResponse = await app.inject({ method: "POST",
      url: `/api/conversations/${conversation.id}/extension-prompt-assembly`,
      payload: { messages: [{ role: "user", content: draft },
        ...conversation.messages.toReversed().map(message => ({ role: message.role, content: message.content }))],
        messageExamples: [[]], extensionPrompts: [], type: "normal" },
    });
    expect(extensionResponse.statusCode).toBe(200);
    const extension = extensionResponse.json() as { messages: typeof preview.messages; totalTokens: number };
    expect(extension.messages).toEqual(preview.messages);
    expect(extension.totalTokens).toBe(preview.totalTokens);

    const secret = "sk-abcdefgh1234567890";
    const privatePrompt = await app.inject({ method: "POST",
      url: `/api/conversations/${conversation.id}/extension-prompt-assembly`,
      payload: { messages: [{ role: "user", content: `密钥是 ${secret}` }],
        messageExamples: [], extensionPrompts: [], type: "normal" },
    });
    expect(privatePrompt.statusCode).toBe(200);
    expect(JSON.stringify(privatePrompt.json())).toContain(secret);
    const redacted = promptPreviewResponseSchema.parse((await app.inject({ method: "POST",
      url: `/api/conversations/${conversation.id}/prompt-preview`, payload: { draft: `密钥是 ${secret}` },
    })).json());
    expect(JSON.stringify(redacted.messages)).not.toContain(secret);
  });

  it("uses extension request token limits in both card and worldbook macros", async () => {
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

    const scan = await app.inject({ method: "POST", url: "/api/worldinfo/prompt", payload: {
      chat: ["budget=1920"], characterId: conversation.characterId, conversationId: conversation.id,
      maxContext: 2048, maxResponseTokens: 128, commitVariables: false,
    } });
    expect(scan.statusCode, scan.body).toBe(200);
    expect(scan.json().report.block).toBe("WORLD=1920/2048/128");
    const response = await app.inject({ method: "POST",
      url: `/api/conversations/${conversation.id}/extension-prompt-assembly`, payload: {
        messages: [{ role: "user", content: "budget=1920" }], messageExamples: [],
        extensionPrompts: [], charDescription: "CARD={{maxPrompt}}/{{maxContext}}/{{maxResponse}}",
        contextLimitTokens: 2048, maxTokens: 128, type: "normal",
        worldInfoAfter: scan.json().report.block,
      } });
    expect(response.statusCode, response.body).toBe(200);
    const assembled = response.json() as { messages: Array<{ content: string }>; contextLimitTokens: number };
    const text = assembled.messages.map(message => message.content).join("\n");
    expect(text).toContain("CARD=1920/2048/128");
    expect(text).toContain("WORLD=1920/2048/128");
    expect(assembled.contextLimitTokens).toBe(2048);
  });

  it("preserves the independent PromptManager pass after earlier browser resolution", async () => {
    const { app, conversation } = await setupPreview();
    const base = toExtensionChatState(conversation);
    const next = structuredClone(base);
    next.metadata = { variables: { inner: "SECOND" } };
    const saved = await app.inject({ method: "PUT",
      url: `/api/conversations/${conversation.id}/extension-state`,
      payload: { branchId: conversation.activeBranchId, base, next } });
    expect(saved.statusCode, saved.body).toBe(200);
    const prompt = { key: "one-pass", value: "{{getvar::inner}}", position: 0,
      depth: 0, scan: true, role: 0 };
    const call = (extensionPrompts: unknown[]) => app.inject({ method: "POST",
      url: `/api/conversations/${conversation.id}/prompt-preview`,
      payload: { draft: "继续。", extensionPrompts } });
    const resolved = await call([{ ...prompt, macrosResolved: true }]);
    const raw = await call([prompt]);
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect(raw.statusCode, raw.body).toBe(200);
    // The executed upstream population oracle's extension-residual fixture
    // proves preparePrompt still substitutes residual syntax in a later pass.
    expect(resolved.json().messages.some((message: { content: string }) => message.content === "SECOND")).toBe(true);
    expect(raw.json().messages.some((message: { content: string }) => message.content === "SECOND")).toBe(true);
  });

  it("keeps card examples when extension conversion produces empty blocks, but honors an explicit empty example list", async () => {
    const { app, conversation } = await setupPreview();
    const draft = "带上地图。";
    const preview = promptPreviewResponseSchema.parse((await app.inject({ method: "POST",
      url: `/api/conversations/${conversation.id}/prompt-preview`, payload: { draft } })).json());
    const assemble = async (messageExamples: unknown[]) => {
      const response = await app.inject({ method: "POST",
        url: `/api/conversations/${conversation.id}/extension-prompt-assembly`, payload: {
          messages: [{ role: "user", content: draft },
            ...conversation.messages.toReversed().map(message => ({ role: message.role, content: message.content }))],
          messageExamples, extensionPrompts: [], type: "normal",
        } });
      expect(response.statusCode).toBe(200);
      return response.json() as { messages: typeof preview.messages; totalTokens: number };
    };
    const unparsed = await assemble([[]]);
    expect(unparsed.messages).toEqual(preview.messages);
    expect(unparsed.totalTokens).toBe(preview.totalTokens);
    const parsed = await assemble([[{ role: "system", name: "example_assistant",
      content: "小心纸张边缘，那里比看起来更远。" }]]);
    expect(parsed.messages).toEqual(preview.messages);
    expect(parsed.totalTokens).toBe(preview.totalTokens);
    const filtered = await assemble([]);
    expect(filtered.messages.some(message => message.content.includes("小心纸张边缘"))).toBe(false);
    const changed = await assemble([[{ role: "system", name: "example_assistant", content: "改写后的示例。" }]]);
    expect(changed.messages.some(message => message.content.includes("改写后的示例。"))).toBe(true);
    expect(changed.messages.some(message => message.content.includes("小心纸张边缘"))).toBe(false);
  });

  it("uses saved chat-level card overrides in native preview and extension assembly", async () => {
    const { app, conversation } = await setupPreview();
    const base = toExtensionChatState(conversation);
    const next = structuredClone(base);
    next.metadata = { scenario: "聊天级场景：{{char}} {{getvar::route}}",
      system_prompt: "聊天级系统规则 {{getglobalvar::weather}}。",
      mes_example: "<START>\n{{char}}: 聊天级示例。", variables: { route: "北方" } };
    const saved = await app.inject({ method: "PUT",
      url: `/api/conversations/${conversation.id}/extension-state`,
      payload: { branchId: conversation.activeBranchId, base, next } });
    expect(saved.statusCode, saved.body).toBe(200);
    const settings = await app.inject({ method: "PUT", url: "/api/extensions/settings",
      payload: { extensionSettings: { variables: { global: { weather: "雨" } } } } });
    expect(settings.statusCode, settings.body).toBe(200);
    const draft = "带上地图。";
    const native = promptPreviewResponseSchema.parse((await app.inject({ method: "POST",
      url: `/api/conversations/${conversation.id}/prompt-preview`, payload: { draft } })).json());
    const extensionResponse = await app.inject({ method: "POST",
      url: `/api/conversations/${conversation.id}/extension-prompt-assembly`, payload: {
        messages: [{ role: "user", content: draft },
          ...conversation.messages.toReversed().map(message => ({ role: message.role, content: message.content }))],
        messageExamples: [[{ role: "system", name: "example_assistant", content: "聊天级示例。" }]],
        Scenario: "聊天级场景：阿斯特 北方", systemPromptOverride: "聊天级系统规则 雨。",
        extensionPrompts: [], type: "normal",
      } });
    expect(extensionResponse.statusCode, extensionResponse.body).toBe(200);
    const extension = extensionResponse.json() as { messages: typeof native.messages; totalTokens: number };
    const nativeText = native.messages.map(message => message.content).join("\n");
    expect(nativeText).toContain("聊天级场景：阿斯特 北方");
    expect(nativeText).toContain("聊天级系统规则 雨。");
    expect(nativeText).toContain("聊天级示例。");
    expect(nativeText).not.toContain("旧天文台");
    expect(extension.messages).toEqual(native.messages);
    expect(extension.totalTokens).toBe(native.totalTokens);
    const providerRequests: Array<typeof native.messages> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: URL, init?: RequestInit) => {
      if (isCompletionRequest(init)) return completionResponse("[]");
      providerRequests.push((JSON.parse(String(init?.body)) as { messages: typeof native.messages }).messages);
      return sseResponse(["好的。"]);
    }));
    const sent = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/messages`,
      payload: { content: draft } });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(providerRequests.at(-1)).toEqual(native.messages);
    const requestsBeforeQuiet = providerRequests.length;
    const quiet = await app.inject({ method: "POST",
      url: `/api/conversations/${conversation.id}/quiet-generation`, payload: { quietPrompt: "" } });
    expect(quiet.statusCode, quiet.body).toBe(200);
    expect(providerRequests.length).toBeGreaterThan(requestsBeforeQuiet);
    const quietText = providerRequests.at(-1)?.map(message => message.content).join("\n");
    expect(quietText).toContain("聊天级场景：阿斯特 北方");
    expect(quietText).toContain("聊天级示例。");
  });

  it("preserves extension overrides and pictures while rejecting unimplemented tool history before model transport", async () => {
    const { app, conversation } = await setupPreview();
    const url = `/api/conversations/${conversation.id}/extension-prompt-assembly`;
    const response = await app.inject({ method: "POST", url, payload: {
      messages: [{ role: "user", content: "请继续" }, { role: "system", content: "旁白提示" }],
      messageExamples: [], extensionPrompts: [], charDescription: "临时角色描述", Scenario: "临时场景",
      worldInfoBefore: "临时世界书", worldInfoAfter: "", systemPromptOverride: "临时系统提示",
      type: "normal",
    } });
    expect(response.statusCode).toBe(200);
    const result = response.json() as { messages: Array<{ role: string; content: string }> };
    expect(result.messages.some(message => message.content.includes("临时角色描述"))).toBe(true);
    expect(result.messages.some(message => message.content.includes("临时世界书"))).toBe(true);
    expect(result.messages.some(message => message.role === "system" && message.content === "旁白提示")).toBe(true);
    const emptyReasoning = await app.inject({ method: "POST", url, payload: {
      messages: [{ role: "user", content: "请继续", reasoning: "", signature: null }],
      messageExamples: [], extensionPrompts: [], type: "normal",
    } });
    expect(emptyReasoning.statusCode).toBe(200);
    const picture = await app.inject({ method: "POST", url, payload: {
      messages: [{ role: "user", content: "看看图片", image: "data:image/png;base64,AAAA" }],
      messageExamples: [], extensionPrompts: [], type: "normal",
    } });
    expect(picture.statusCode,picture.body).toBe(200);
    expect(picture.json().messages.find((message:{role:string})=>message.role==="user").content).toEqual([
      {type:"text",text:"看看图片"},{type:"image_url",image_url:{url:"data:image/png;base64,AAAA",detail:"auto"}},
    ]);
    const unsupported = await app.inject({ method: "POST", url, payload: {
      messages: [{ role: "assistant", content: "Tool history", tool_calls:[] }],
      messageExamples: [], extensionPrompts: [], type: "normal",
    } });
    expect(unsupported.statusCode).toBe(422);
    expect(unsupported.json()).toMatchObject({ error: { code: "UNSUPPORTED_PROMPT_MEDIA" } });
  });
});
