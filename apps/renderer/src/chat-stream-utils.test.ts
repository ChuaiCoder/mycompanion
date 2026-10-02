import { describe, expect, it } from "vitest";

import type { ChatMessage, ConversationDetail } from "@mycompanion/shared";

import { replaceMessage, updateLastAssistantContent } from "./chat-stream-utils";

const message = (id: string, role: "user" | "assistant", content: string): ChatMessage => ({
  id,
  conversationId: "00000000-0000-4000-8000-0000000000c1",
  branchId: "00000000-0000-4000-8000-0000000000b1",
  parentMessageId: null,
  role,
  content,
  status: "complete",
  createdAt: "2026-09-17T00:00:00.000Z",
});

const conversation = (messages: ChatMessage[]): ConversationDetail => ({
  id: "00000000-0000-4000-8000-0000000000c1",
  characterId: "00000000-0000-4000-8000-0000000000a1",
  characterName: "Aster",
  title: "工坊",
  lastMessagePreview: "",
  messageCount: messages.length,
  activeBranchId: "00000000-0000-4000-8000-0000000000b1",
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z",
  messages,
});

describe("chat stream utils", () => {
  it("appends a delta to the last assistant message only", () => {
    const current = conversation([
      message("m1", "user", "你好"),
      message("m2", "assistant", "欢迎"),
      message("m3", "user", "继续"),
      message("m4", "assistant", "正在"),
    ]);
    const updated = updateLastAssistantContent(current, "思考");
    expect(updated.messages.map((item) => item.content)).toEqual(["你好", "欢迎", "继续", "正在思考"]);
    expect(current.messages[3]?.content).toBe("正在");
  });

  it("returns the conversation unchanged when no assistant message exists", () => {
    const current = conversation([message("m1", "user", "你好")]);
    expect(updateLastAssistantContent(current, "增量")).toBe(current);
    expect(updateLastAssistantContent(conversation([]), "增量")).toEqual(conversation([]));
  });

  it("replaces the confirmed message by id and keeps the rest untouched", () => {
    const current = conversation([message("m1", "user", "你好"), message("m2", "assistant", "部分")]);
    const confirmed = { ...message("m2", "assistant", "完整回复"), status: "complete" as const };
    const updated = replaceMessage(current, confirmed);
    expect(updated.messages[1]).toEqual(confirmed);
    expect(updated.messages[1]).not.toBe(confirmed);
    expect(updated.messages[0]?.content).toBe("你好");
  });

  it("ignores a confirmed message that does not belong to the conversation", () => {
    const current = conversation([message("m1", "user", "你好")]);
    const updated = replaceMessage(current, message("m9", "assistant", "无关"));
    expect(updated.messages).toHaveLength(1);
    expect(updated.messages[0]?.content).toBe("你好");
  });
});
