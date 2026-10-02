import { describe, expect, it, vi } from "vitest";

import {
  characterDetailSchema,
  conversationDetailSchema,
  type ChatMessage,
} from "@mycompanion/shared";

import { buildApp } from "./app.js";
import {
  apps,
  commitCard,
  completionResponse,
  fullV2Card,
  isCompletionRequest,
  parseSse,
  sseResponse,
  type TestApp,
} from "./test-helpers.js";

// 带自定义正则规则的角色卡：一条只作用于用户输入，一条只作用于模型上下文。
const regexStagesCard = {
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: {
    name: "正则测试",
    description: "用于验证正则阶段的测试角色。",
    personality: "",
    scenario: "",
    first_mes: "你好。",
    mes_example: "",
    creator_notes: "",
    system_prompt: "",
    post_history_instructions: "",
    alternate_greetings: [],
    tags: ["test"],
    creator: "MyCompanion",
    character_version: "1.0",
    extensions: {
      regex_scripts: [
        { scriptName: "输入替换", findRegex: "/世界/g", replaceString: "星球", placement: [1] },
        { scriptName: "提示替换", findRegex: "/旅行/g", replaceString: "远行", placement: [1], promptOnly: true },
      ],
    },
  },
};

async function setRegexEnabled(
  app: TestApp,
  id: string,
  order: number,
  enabled: boolean,
) {
  const response = await app.inject({
    method: "PUT",
    url: `/api/characters/${id}/regex/${order}`,
    payload: { enabled },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as Array<{ disabled: boolean; order: number }>;
}

describe("character regex rules (FR-REGEX-001…007)", () => {
  it("lists imported rules as disabled by default and persists enable state", async () => {
    const app = buildApp();
    apps.push(app);
    const character = await commitCard(app, fullV2Card, "ccv2-full.json");

    const listed = await app.inject({ method: "GET", url: `/api/characters/${character.id}/regex` });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      characterId: character.id,
      rules: [{ scriptName: "方向措辞整理", disabled: true, findRegex: "/北行/gi" }],
    });

    const enabled = await setRegexEnabled(app, character.id, 0, true);
    expect(enabled[0]?.disabled).toBe(false);

    // 重新读取角色详情时，启用状态仍然生效（持久化在 characters 表）。
    const reloaded = characterDetailSchema.parse(
      (await app.inject({ method: "GET", url: `/api/characters/${character.id}` })).json(),
    );
    expect(reloaded.regexEnabled).toHaveLength(1);
    expect(reloaded.regexEnabled[0]?.disabled).toBe(false);

    const disabled = await setRegexEnabled(app, character.id, 0, false);
    expect(disabled[0]?.disabled).toBe(true);

    // 不存在的序号返回 404；非法请求体返回 400。
    const missing = await app.inject({
      method: "PUT",
      url: `/api/characters/${character.id}/regex/9`,
      payload: { enabled: true },
    });
    expect(missing.statusCode).toBe(404);
    const badBody = await app.inject({
      method: "PUT",
      url: `/api/characters/${character.id}/regex/0`,
      payload: { enabled: "yes" },
    });
    expect(badBody.statusCode).toBe(400);
  });

  it("enables and disables all rules of a character at once", async () => {
    const app = buildApp();
    apps.push(app);
    const character = await commitCard(app, regexStagesCard);

    const allOn = await app.inject({
      method: "PUT",
      url: `/api/characters/${character.id}/regex/all`,
      payload: { enabled: true },
    });
    expect(allOn.statusCode).toBe(200);
    expect((allOn.json() as Array<{ disabled: boolean }>).every((rule) => rule.disabled === false)).toBe(true);

    const allOff = await app.inject({
      method: "PUT",
      url: `/api/characters/${character.id}/regex/all`,
      payload: { enabled: false },
    });
    expect((allOff.json() as Array<{ disabled: boolean }>).every((rule) => rule.disabled)).toBe(true);
  });

  it("runs the rule tester on sample text without touching real conversations", async () => {
    const app = buildApp();
    apps.push(app);
    const character = await commitCard(app, fullV2Card, "ccv2-full.json");
    await setRegexEnabled(app, character.id, 0, true);

    const tested = await app.inject({
      method: "POST",
      url: `/api/characters/${character.id}/regex/test`,
      payload: { input: "我北行。" },
    });
    expect(tested.statusCode).toBe(200);
    const report = tested.json() as {
      stages: Array<{ stage: string; input: string; output: string; rules: Array<{ status: string }> }>;
      finalOutput: string;
    };
    // 酒馆不会替空 placement 推测来源；这些规则保留但不执行。
    expect(report.stages.map((stage) => stage.stage)).toEqual(["input", "prompt", "output", "display"]);
    expect(report.stages[0]?.output).toBe("我北行。");
    expect(report.stages[1]?.output).toBe("我北行。");
    expect(report.finalOutput).toBe("我北行。");
    expect(report.stages[0]?.rules).toHaveLength(0);
    expect(report.stages[2]?.rules).toHaveLength(0);
    expect(report.stages[3]?.rules).toHaveLength(0);
    expect(report.stages[1]?.rules).toEqual([]);

    // 测试器不创建或修改真实聊天。
    const conversations = await app.inject({ method: "GET", url: "/api/conversations" });
    expect(conversations.json()).toMatchObject({ total: 0 });

    // 未启用规则时全部跳过，输出等于输入。
    await setRegexEnabled(app, character.id, 0, false);
    const skipped = await app.inject({
      method: "POST",
      url: `/api/characters/${character.id}/regex/test`,
      payload: { input: "北行" },
    });
    expect((skipped.json() as { finalOutput: string }).finalOutput).toBe("北行");
  });

  it("applies input/prompt/output stages in chat and never overwrites stored raw text", async () => {
    let providerRequest: { messages?: Array<{ role: string; content: string }> } | undefined;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(
      async (_url: URL, init?: RequestInit) => {
        if (isCompletionRequest(init)) return completionResponse();
        providerRequest = JSON.parse(String(init?.body)) as typeof providerRequest;
        return sseResponse(["旅行世界"]);
      },
    ));
    const app = buildApp();
    apps.push(app);
    const character = await commitCard(app, regexStagesCard);
    await setRegexEnabled(app, character.id, 0, true);
    await setRegexEnabled(app, character.id, 1, true);
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
      payload: { content: "世界旅行" },
    });
    expect(sent.statusCode).toBe(200);
    const events = parseSse(sent.body);
    const userEvent = events.find((event) => event.type === "user_message") as { message: ChatMessage } | undefined;
    expect(userEvent?.message.content).toBe("星球旅行");

    // 保存的原文 = 输入阶段结果；prompt 阶段（旅行→远行）只进入模型上下文。
    expect(providerRequest?.messages?.at(-1)).toMatchObject({ role: "user", content: "星球远行" });

    // 输出阶段没有启用任何规则，助手回复保持模型原文。
    const done = events.at(-1) as { message: ChatMessage };
    expect(done.message.content).toBe("旅行世界");
    expect(done.message.status).toBe("complete");

    const reloaded = conversationDetailSchema.parse((await app.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}`,
    })).json());
    expect(reloaded.messages.at(-1)?.content).toBe("旅行世界");
  });

  it("lets a failing rule keep the rest of the pipeline running in chat", async () => {
    const card = {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name: "混合规则",
        description: "",
        personality: "",
        scenario: "",
        first_mes: "你好。",
        mes_example: "",
        creator_notes: "",
        system_prompt: "",
        post_history_instructions: "",
        alternate_greetings: [],
        tags: [],
        creator: "MyCompanion",
        character_version: "1.0",
        extensions: {
          regex_scripts: [
            // 语法错误：未闭合的字符类。
            { scriptName: "坏规则", findRegex: "/^[", replaceString: "x", placement: [1], order: 0 },
            { scriptName: "好规则", findRegex: "/世界/g", replaceString: "星球", placement: [1], order: 1 },
          ],
        },
      },
    };
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => sseResponse(["好的。"])));
    const app = buildApp();
    apps.push(app);
    const character = await commitCard(app, card);
    await setRegexEnabled(app, character.id, 0, true);
    await setRegexEnabled(app, character.id, 1, true);
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
      payload: { content: "世界" },
    });
    expect(sent.statusCode).toBe(200);
    const events = parseSse(sent.body);
    // 坏规则失败不阻断好规则：保存内容仍然被替换。
    const userEvent = events.find((event) => event.type === "user_message") as { message: ChatMessage } | undefined;
    expect(userEvent?.message.content).toBe("星球");
    const done = events.at(-1) as { message: ChatMessage };
    expect(done.message.status).toBe("complete");
  });

  it("returns 404 from the tester for an unknown character and 400 for oversized input", async () => {
    const app = buildApp();
    apps.push(app);
    const unknown = await app.inject({
      method: "POST",
      url: "/api/characters/00000000-0000-4000-8000-000000000000/regex/test",
      payload: { input: "x" },
    });
    expect(unknown.statusCode).toBe(404);

    const character = await commitCard(app, fullV2Card, "ccv2-full.json");
    const oversized = await app.inject({
      method: "POST",
      url: `/api/characters/${character.id}/regex/test`,
      payload: { input: "a".repeat(1024 * 1024 + 1) },
    });
    expect(oversized.statusCode).toBe(400);
  });
});
