import { describe, expect, it, vi } from "vitest";

import {
  characterDetailSchema,
  conversationDetailSchema,
  type ChatMessage,
} from "@mycompanion/shared";

import { buildApp } from "./app.js";
import { countCompatibilityMessagesSync } from "./tokens/tokenizer-service.js";
import {
  apps,
  completionResponse,
  fullV2Card,
  isCompletionRequest,
  parseSse,
  sseResponse,
  stoppableSseResponse,
} from "./testing/helpers.js";

describe("desktop chat runtime", () => {
  it.each(["foreground", "memory"] as const)("closes the independent service while %s is waiting on the model", async (kind) => {
    let modelSignal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: URL, init?: RequestInit) => {
      if (kind === "foreground") {
        modelSignal = init?.signal ?? undefined;
        markStarted();
        return stoppableSseResponse(modelSignal);
      }
      if (!isCompletionRequest(init)) return sseResponse(["Completed foreground reply."]);
      modelSignal = init?.signal ?? undefined;
      markStarted();
      return new Promise<Response>((_resolve, reject) => {
        modelSignal?.addEventListener("abort", () => reject(modelSignal?.reason), { once: true });
        if (modelSignal?.aborted) reject(modelSignal.reason);
      });
    }));
    const app = buildApp();
    apps.push(app);
    const character = characterDetailSchema.parse((await app.inject({
      method: "POST", url: "/api/characters/import/commit",
      payload: { filename: "shutdown.json", card: fullV2Card },
    })).json());
    await app.inject({ method: "PUT", url: "/api/settings/provider",
      payload: { kind: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "shutdown-fixture" } });
    const conversation = conversationDetailSchema.parse((await app.inject({
      method: "POST", url: "/api/conversations", payload: { characterId: character.id },
    })).json());
    const generation = app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/messages`,
      payload: { content: "Shutdown fixture" } });
    await started;
    await app.close();
    expect(modelSignal?.aborted).toBe(true);
    const response = await generation;
    const done = parseSse(response.body).find(event => event.type === "done") as { message: ChatMessage };
    expect(done.message.status).toBe(kind === "foreground" ? "stopped" : "complete");
  });

  it("persists a story and streams character context through an OpenAI-compatible provider", async () => {
    let providerRequest: { messages?: Array<{ role: string; content: string }>; stream?: boolean } | undefined;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(
      async (_url: URL, init?: RequestInit) => {
        if (isCompletionRequest(init)) return completionResponse();
        providerRequest = JSON.parse(String(init?.body)) as typeof providerRequest;
        return sseResponse(["欢迎回来，", "旅行者。"]);
      },
    ));
    const app = buildApp({
      secretCodec: { seal: (value) => `sealed:${value}`, unseal: (value) => value.slice(7) },
    });
    apps.push(app);

    const imported = await app.inject({
      method: "POST",
      url: "/api/characters/import/commit",
      payload: { filename: "ccv2-full.json", card: fullV2Card },
    });
    const character = characterDetailSchema.parse(imported.json());
    const settings = await app.inject({
      method: "PUT",
      url: "/api/settings/provider",
      payload: {
        kind: "openai-compatible",
        baseUrl: "https://example.test/v1",
        model: "roleplay-model",
        apiKey: "test-secret",
        temperature: 0.7,
        maxTokens: 500,
      },
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({ hasApiKey: true, model: "roleplay-model" });
    expect(JSON.stringify(settings.json())).not.toContain("test-secret");

    const created = await app.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { characterId: character.id },
    });
    const conversation = conversationDetailSchema.parse(created.json());
    expect(conversation.messages[0]?.content).toContain("墨迹还没有干");

    const sent = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages`,
      payload: { content: "我们现在在哪里？" },
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.headers["content-type"]).toContain("text/event-stream");
    // 流式：逐段 delta，最终 done 携带完整文本与 complete 状态。
    const events = parseSse(sent.body);
    expect(events.map((event) => event.type)).toEqual(
      ["user_message", "lorebook", "memory", "prompt_budget", "assistant_start", "delta", "delta", "done"],
    );
    // 世界书事件携带匹配报告；fullV2Card 的条目默认停用，因此没有注入。
    const lorebookEvent = events.find((event) => event.type === "lorebook") as { report: { block: string; injectedCount: number } } | undefined;
    expect(lorebookEvent?.report.block).toBe("");
    expect(lorebookEvent?.report.injectedCount).toBe(0);
    const done = events.at(-1) as { message: ChatMessage };
    expect(done.message.content).toBe("欢迎回来，旅行者。");
    expect(done.message.status).toBe("complete");
    expect(providerRequest?.stream).toBe(true);
    expect(providerRequest?.messages?.[0]?.content).toBe("保持角色身份，并根据已经确认的剧情事实回答。");
    expect(providerRequest?.messages?.some(message => message.role === "system" && message.content.includes(String((fullV2Card as {data:{description:unknown}}).data.description)))).toBe(true);
    expect(providerRequest?.messages?.findLast(message => message.role === "user")).toMatchObject({
      role: "user",
      content: "我们现在在哪里？",
    });

    const reloaded = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}`,
    });
    const detail = conversationDetailSchema.parse(reloaded.json());
    expect(detail.messages).toHaveLength(3);
    expect(detail.messages.at(-1)).toMatchObject({ role: "assistant", status: "complete" });
  });

  it("returns the full story to the UI but only the newest 80 messages to the model", async () => {
    const providerRequests: Array<{
      messages: Array<{ role: string; content: string }>;
    }> = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(
      async (_url: URL, init?: RequestInit) => {
        if (isCompletionRequest(init)) return completionResponse();
        providerRequests.push(
          JSON.parse(String(init?.body)) as (typeof providerRequests)[number],
        );
        return sseResponse(["好的。"]);
      },
    ));
    const app = buildApp();
    apps.push(app);

    const imported = characterDetailSchema.parse((await app.inject({
      method: "POST",
      url: "/api/characters/import/commit",
      payload: { filename: "ccv2-full.json", card: fullV2Card },
    })).json());
    await app.inject({
      method: "PUT",
      url: "/api/settings/provider",
      payload: {
        kind: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "test-model",
      },
    });
    const conversation = conversationDetailSchema.parse((await app.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { characterId: imported.id },
    })).json());

    const turnCount = 41;
    for (let index = 0; index < turnCount; index += 1) {
      const sent = await app.inject({
        method: "POST",
        url: `/api/conversations/${conversation.id}/messages`,
        payload: { content: `第 ${index + 1} 句` },
      });
      expect(sent.statusCode).toBe(200);
    }

    // 开场白 + 每轮 2 条 = 83 条，全部返回给 UI 展示（不被 80 条窗口截断）。
    const reloaded = conversationDetailSchema.parse((await app.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}`,
    })).json());
    expect(reloaded.messages).toHaveLength(1 + turnCount * 2);
    expect(reloaded.messages[0]?.content).toContain("墨迹还没有干");

    // 模型上下文 = system + 最近 80 条：最旧的开场白与首轮用户消息被裁掉，最新一轮仍在窗口内。
    const lastRequest = providerRequests.at(-1);
    expect(lastRequest).toBeDefined();
    // PromptManager markers/regions have their own messages; count the actual
    // retained history by matching its unchanged content and role, not framing.
    const sourceHistory = reloaded.messages.slice(0, -1).slice(-80);
    expect(lastRequest?.messages?.filter(message => sourceHistory.some(source => source.role === message.role && source.content === message.content))).toHaveLength(80);
    expect(lastRequest?.messages?.[0]?.role).toBe("system");
    expect(JSON.stringify(lastRequest?.messages)).not.toContain("墨迹还没有干");
    expect(lastRequest?.messages).toContainEqual({
      role: "user",
      content: `第 ${turnCount} 句`,
    });
  });

  it("stops a generation and keeps the partial text marked stopped", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(
      async (_url: URL, init?: RequestInit) => stoppableSseResponse(init?.signal),
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

    // 发起生成（不等待完成），生成会阻塞在模型流上。
    const sent = app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages`,
      payload: { content: "讲个故事。" },
    });
    // 等生成进入 in-flight 状态（模型请求已发出、控制器已登记）。
    await new Promise((resolve) => setTimeout(resolve, 60));
    // 显式停止：服务端中止模型请求，保留已接收文本。
    const stop = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/generation/stop`,
    });
    expect(stop.statusCode).toBe(200);
    const sentResponse = await sent;
    expect(sentResponse.statusCode).toBe(200);
    const events = parseSse(sentResponse.body);
    const done = events.find((event) => event.type === "done") as { message: ChatMessage } | undefined;
    expect(done).toBeDefined();
    expect(done?.message.status).toBe("stopped");
    expect(done?.message.content).toBe("你好，");

    // 停止后的部分文本进入后续上下文（stopped 且非空）。
    const reloaded = conversationDetailSchema.parse((await app.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}`,
    })).json());
    const last = reloaded.messages.at(-1);
    expect(last?.status).toBe("stopped");
    expect(last?.content).toBe("你好，");
  });

  it("regenerates the last assistant reply on a new branch, keeping the original accessible", async () => {
    let call = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(
      async () => { call += 1; return sseResponse([call === 1 ? "第一版。" : "第二版。"]); },
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
    const firstBranchId = conversation.activeBranchId;

    const first = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages`,
      payload: { content: "你好。" },
    });
    const firstDone = (parseSse(first.body).find((event) => event.type === "done") as { message: ChatMessage }).message;
    expect(firstDone.content).toBe("第一版。");

    // 重新生成：分叉出新分支，当前分支切换，旧分支保留。
    const regen = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages/regenerate`,
    });
    const regenDone = (parseSse(regen.body).find((event) => event.type === "done") as { message: ChatMessage }).message;
    expect(regenDone.content).toBe("第二版。");
    expect(regenDone.branchId).not.toBe(firstBranchId);

    const reloaded = conversationDetailSchema.parse((await app.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}`,
    })).json());
    expect(reloaded.activeBranchId).not.toBe(firstBranchId);
    // 当前分支只含“开场白 + 用户 + 新助手回复”，不含旧的第一版。
    expect(reloaded.messages.map((message) => message.content)).not.toContain("第一版。");
    expect(reloaded.messages.at(-1)?.content).toBe("第二版。");

    // 切换回原分支：旧的第一版仍在。
    const switched = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/branches/${firstBranchId}/activate`,
    });
    expect(switched.statusCode).toBe(200);
    const oldBranch = conversationDetailSchema.parse((await app.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}`,
    })).json());
    expect(oldBranch.activeBranchId).toBe(firstBranchId);
    expect(oldBranch.messages.map((message) => message.content)).toContain("第一版。");
  });

  it("edits and deletes messages on the active branch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => sseResponse(["好的。"])));
    const app = buildApp();
    apps.push(app);
    const character = characterDetailSchema.parse((await app.inject({
      method: "POST",
      url: "/api/characters/import/commit",
      payload: { filename: "ccv2-full.json", card: fullV2Card },
    })).json());
    const conversation = conversationDetailSchema.parse((await app.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { characterId: character.id },
    })).json());
    // 产生一轮对话：用户消息 + 助手回复。
    await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages`,
      payload: { content: "你好。" },
    });
    const reloaded0 = conversationDetailSchema.parse((await app.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}`,
    })).json());
    const userMsg = reloaded0.messages.find((message) => message.role === "user");
    expect(userMsg).toBeDefined();

    // 编辑用户消息。
    const edit = await app.inject({
      method: "PATCH",
      url: `/api/conversations/${conversation.id}/messages/${userMsg?.id}`,
      payload: { content: "改过的话。" },
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.json()).toMatchObject({ content: "改过的话。", role: "user" });

    const reloaded = conversationDetailSchema.parse((await app.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}`,
    })).json());
    expect(reloaded.messages.some((message) => message.content === "改过的话。")).toBe(true);

    // 删除被编辑的用户消息。
    const target = reloaded.messages.find((message) => message.content === "改过的话。");
    const del = await app.inject({
      method: "DELETE",
      url: `/api/conversations/${conversation.id}/messages/${target?.id}`,
    });
    expect(del.statusCode).toBe(200);
    const afterDelete = conversationDetailSchema.parse((await app.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}`,
    })).json());
    expect(afterDelete.messages.some((message) => message.content === "改过的话。")).toBe(false);
  });

  it("rejects a second concurrent generation on the same story", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(
      async (_url: URL, init?: RequestInit) => stoppableSseResponse(init?.signal),
    ));
    const app = buildApp();
    apps.push(app);
    const character = characterDetailSchema.parse((await app.inject({
      method: "POST",
      url: "/api/characters/import/commit",
      payload: { filename: "ccv2-full.json", card: fullV2Card },
    })).json());
    const conversation = conversationDetailSchema.parse((await app.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { characterId: character.id },
    })).json());

    // 第一个生成进行中：重复提交应被 409 拒绝，不产生重复消息。
    const first = app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages`,
      payload: { content: "你好。" },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const second = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages`,
      payload: { content: "你好。" },
    });
    expect(second.statusCode).toBe(409);
    await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/generation/stop`,
    });
    await first;
  });

  it("installs permission-scoped declarative plugins and rejects SillyTavern manifests", async () => {
    let providerRequest: { messages?: Array<{ role: string; content: string }> } | undefined;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(
      async (_url: URL, init?: RequestInit) => {
        providerRequest = JSON.parse(String(init?.body)) as typeof providerRequest;
        return new Response(JSON.stringify({
          choices: [{ message: { content: "海港被月色照亮。" } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    ));
    const app = buildApp();
    apps.push(app);
    const manifest = {
      schemaVersion: 1,
      id: "scene-director",
      name: "Scene Director",
      version: "1.0.0",
      description: "Adds a scene command.",
      author: "MyCompanion",
      license: "MIT",
      permissions: ["prompt:system", "command:register"],
      contributes: {
        systemPrompt: "Keep spatial continuity explicit.",
        commands: [{ name: "scene", description: "Set scene", prompt: "Scene request: {{args}}" }],
      },
    };
    const installed = await app.inject({
      method: "POST",
      url: "/api/plugins/install",
      payload: manifest,
    });
    expect(installed.statusCode).toBe(201);
    expect(installed.json()).toMatchObject({ id: "scene-director", enabled: false });

    const enabled = await app.inject({
      method: "PUT",
      url: "/api/plugins/scene-director/enabled",
      payload: { enabled: true },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({ enabled: true });

    const imported = await app.inject({
      method: "POST",
      url: "/api/characters/import/commit",
      payload: { filename: "ccv2-full.json", card: fullV2Card },
    });
    const character = characterDetailSchema.parse(imported.json());
    await app.inject({
      method: "PUT",
      url: "/api/settings/provider",
      payload: {
        kind: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "test-model",
        temperature: 0.8,
        maxTokens: 200,
      },
    });
    const created = conversationDetailSchema.parse((await app.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { characterId: character.id },
    })).json());
    const commandPreviewResponse = await app.inject({ method: "POST",
      url: `/api/conversations/${created.id}/prompt-preview`, payload: { draft: "/scene 月色下的海港" } });
    expect(commandPreviewResponse.statusCode, commandPreviewResponse.body).toBe(200);
    const commandPreview = commandPreviewResponse.json();
    expect(commandPreview.messages.findLast((message: {role:string}) => message.role === "user")?.content).toBe("Scene request: 月色下的海港");
    const commandCount = countCompatibilityMessagesSync(commandPreview.messages, "test-model", true);
    expect(commandPreview.totalTokens).toBe(commandCount + 200 + 512);
    const sent = await app.inject({
      method: "POST",
      url: `/api/conversations/${created.id}/messages`,
      payload: { content: "/scene 月色下的海港" },
    });
    expect(sent.statusCode).toBe(200);
    expect(providerRequest?.messages?.some(message => message.role === "system" && message.content === "Keep spatial continuity explicit.")).toBe(true);
    expect(providerRequest?.messages?.findLast(message => message.role === "user")?.content).toBe(
      "Scene request: 月色下的海港",
    );

    const incompatible = await app.inject({
      method: "POST",
      url: "/api/plugins/install",
      payload: { display_name: "SillyTavern extension", js: "index.js" },
    });
    expect(incompatible.statusCode).toBe(422);
    expect(incompatible.json()).toMatchObject({
      error: { code: "INVALID_PLUGIN_MANIFEST" },
    });
  });
});
