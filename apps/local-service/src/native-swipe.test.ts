import { describe, expect, it } from "vitest";

import type { ConversationDetail } from "@mycompanion/shared";

import { buildApp } from "./app.js";
import { apps, commitCard } from "./testing/helpers.js";

const swipeCard = {
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: {
    name: "候选回复测试",
    description: "",
    personality: "",
    scenario: "",
    first_mes: "欢迎。",
    mes_example: "",
    creator_notes: "",
    system_prompt: "",
    post_history_instructions: "",
    alternate_greetings: ["备用问候", "再一句"],
    tags: [],
    creator: "MyCompanion",
    character_version: "1.0",
    extensions: {},
  },
};

async function fixture() {
  const app = buildApp();
  apps.push(app);
  const character = await commitCard(app, swipeCard, "swipe.json");
  const created = await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } });
  expect(created.statusCode, created.body).toBe(201);
  const story = created.json() as ConversationDetail;
  const greeting = story.messages[0]!;
  expect(greeting.extensionData?.swipes).toEqual(["欢迎。", "备用问候", "再一句"]);
  expect(greeting.extensionData?.swipe_id).toBe(0);
  const swipe = (swipeId: unknown) => app.inject({
    method: "POST",
    url: `/api/conversations/${story.id}/messages/${greeting.id}/swipe`,
    payload: { swipeId },
  });
  const read = async () => (await app.inject({ method: "GET", url: `/api/conversations/${story.id}` })).json() as ConversationDetail;
  return { app, story, greeting, swipe, read };
}

describe("POST /api/conversations/:id/messages/:messageId/swipe", () => {
  it("selects a candidate atomically, preserves the original text and persists the projection", async () => {
    const { greeting, swipe, read } = await fixture();

    const selected = await swipe(1);
    expect(selected.statusCode, selected.body).toBe(200);
    const message = selected.json();
    expect(message.content).toBe("备用问候");
    expect(message.extensionData.swipe_id).toBe(1);
    // 单消息且未污染：原候选文本不被覆盖；swipe_info 记录原候选的展示状态。
    expect(message.extensionData.swipes).toEqual(["欢迎。", "备用问候", "再一句"]);
    expect(message.extensionData.swipe_info[0]).toMatchObject({ send_date: greeting.createdAt });

    const persisted = (await read()).messages[0]!;
    expect(persisted.content).toBe("备用问候");
    expect(persisted.extensionData?.swipe_id).toBe(1);

    const back = await swipe(0);
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json().content).toBe("欢迎。");
    expect((await read()).messages[0]?.content).toBe("欢迎。");
  });

  it("rejects invalid selections and unknown targets without changing the message", async () => {
    const { app, story, greeting, swipe, read } = await fixture();

    expect((await swipe(5)).statusCode).toBe(409);
    expect((await swipe(5)).json().error.code).toBe("SWIPE_NOT_AVAILABLE");
    expect((await swipe(-1)).statusCode).toBe(400);
    expect((await swipe("1")).statusCode).toBe(400);

    const missingMessage = await app.inject({
      method: "POST",
      url: `/api/conversations/${story.id}/messages/00000000-0000-4000-8000-000000000000/swipe`,
      payload: { swipeId: 0 },
    });
    expect(missingMessage.statusCode).toBe(404);
    expect(missingMessage.json().error.code).toBe("MESSAGE_NOT_FOUND");
    const missingStory = await app.inject({
      method: "POST",
      url: `/api/conversations/00000000-0000-4000-8000-000000000000/messages/${greeting.id}/swipe`,
      payload: { swipeId: 0 },
    });
    expect(missingStory.statusCode).toBe(404);
    expect(missingStory.json().error.code).toBe("CONVERSATION_NOT_FOUND");

    const current = (await read()).messages[0]!;
    expect(current.content).toBe("欢迎。");
    expect(current.extensionData?.swipe_id).toBe(0);
  });
});
