import { describe, expect, it, vi } from "vitest";

import type { CharacterDetail, ChatMessage } from "@mycompanion/shared";

import { extractMemories, summarizeMessages } from "./memory-extractor.js";

const NOW = "2026-09-20T00:00:00.000Z";

function character(overrides: Partial<CharacterDetail> = {}): CharacterDetail {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    name: "阿斯特",
    description: "制图师。",
    personality: "好奇。",
    scenario: "工作室。",
    firstMessage: "欢迎。",
    alternateGreetings: [],
    alternateGreetingsCount: 0,
    exampleDialogue: "",
    systemPrompt: "",
    postHistoryInstructions: "",
    creatorNotes: "",
    tags: [],
    creator: "Test",
    characterVersion: "1.0",
    sourceFormat: "ccv2-json",
    sourceVersion: "2.0",
    rawExtensions: {},
    unknownFieldPaths: [],
    regexEnabled: [],
    lorebookEnabled: [],
    lorebookEntryCount: 0,
    regexScriptCount: 0,
    lorebookEntries: [],
    regexScripts: [],
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function message(role: ChatMessage["role"], content: string, index: number): ChatMessage {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    conversationId: "00000000-0000-4000-8000-000000000009",
    branchId: "00000000-0000-4000-8000-000000000009",
    parentMessageId: null,
    role,
    content,
    status: "complete",
    createdAt: NOW,
  };
}

const SETTINGS = {
  kind: "openai-compatible" as const,
  baseUrl: "http://127.0.0.1:11434/v1",
  model: "test-model",
  hasApiKey: false,
  temperature: 0.8,
  maxTokens: 512,
  contextLimitTokens: 4096,
};

const pair: [ChatMessage, ChatMessage] = [
  message("user", "我改名叫远航了。", 1),
  message("assistant", "好的，远航。", 2),
];

const completeTextMock = vi.fn();
vi.mock("../providers/model-client.js", () => ({
  get completeText() {
    return completeTextMock;
  },
}));

describe("extractMemories (FR-MEM-002)", () => {
  it.each(["valid", "forged", "hypothetical-subquote", "wrong-subject", "wrong-property", "negated", "hearsay"])
    ("only preserves checked transition source quotes: %s", async kind => {
      const quote = "玩家的位置从北京搬到上海。";
      const actual = kind === "hypothetical-subquote" ? `如果${quote}` : kind === "negated" ? "玩家的位置没有从北京搬到上海。"
        : kind === "hearsay" ? `小王说${quote}` : quote;
      const sourcePair: [ChatMessage, ChatMessage] = [message("user", actual, 20), message("assistant", "收到。", 21)];
      const claim = { subject: kind === "wrong-subject" ? "小王" : "玩家", predicate: kind === "wrong-property" ? "出生地" : "位置",
        value: "上海", temporality: "current", transition: { from: "北京", sourceRole: "user",
          quote: kind === "forged" ? "玩家的位置从北京变为上海。" : kind === "negated" || kind === "hearsay" ? actual : quote } };
      completeTextMock.mockReset().mockResolvedValue(JSON.stringify([{ type: "state", content: "玩家在上海。", importance: 4, claim }]));
      const records = await extractMemories({ settings: SETTINGS, character: character(), conversationId: sourcePair[0].conversationId,
        pair: sourcePair, alreadyExtractedSourceIds: new Set<string>() });
      expect(records).toHaveLength(1);
      expect(records[0]?.claim?.transition).toEqual(kind === "valid"
        ? { from: "北京", sourceMessageId: sourcePair[0].id, quote } : undefined);
    });
  it("skips a round whose source message was already extracted", async () => {
    completeTextMock.mockReset().mockResolvedValue("[]");
    const records = await extractMemories({
      settings: SETTINGS,
      character: character(),
      conversationId: pair[0].conversationId,
      pair,
      alreadyExtractedSourceIds: new Set([pair[0].id]),
    });
    expect(records).toEqual([]);
    expect(completeTextMock).not.toHaveBeenCalled();
  });

  it("parses the fenced JSON array into story-scope records with both source ids", async () => {
    completeTextMock.mockReset().mockResolvedValue(
      '```json\n[{"type":"state","content":"玩家改名为远航。","importance":4}]```',
    );
    const records = await extractMemories({
      settings: SETTINGS,
      character: character(),
      conversationId: pair[0].conversationId,
      pair,
      alreadyExtractedSourceIds: new Set<string>(),
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: "state",
      scope: "story",
      importance: 4,
      status: "active",
      pinned: false,
      supersededBy: null,
      previousContent: null,
    });
    expect(records[0]?.sourceMessageIds).toEqual([pair[0].id, pair[1].id]);
  });

  it("drops invalid items and returns [] when the model fails (FR-MEM-002 失败不阻塞聊天)", async () => {
    completeTextMock.mockReset().mockResolvedValue('前缀 [{"type":"nonsense"}] 后缀');
    expect(await extractMemories({
      settings: SETTINGS,
      character: character(),
      conversationId: pair[0].conversationId,
      pair,
      alreadyExtractedSourceIds: new Set<string>(),
    })).toEqual([]);

    completeTextMock.mockReset().mockRejectedValue(new Error("网络错误"));
    expect(await extractMemories({
      settings: SETTINGS,
      character: character(),
      conversationId: pair[0].conversationId,
      pair,
      alreadyExtractedSourceIds: new Set<string>(),
    })).toEqual([]);
  });
});

describe("summarizeMessages (FR-MEM-006)", () => {
  it("summarizes earlier messages and tracks coverage", async () => {
    completeTextMock.mockReset().mockResolvedValue("玩家来到工作室，与阿斯特约定绘制星图。");
    const result = await summarizeMessages({
      settings: SETTINGS,
      character: character(),
      messages: [message("user", "你好", 1), message("assistant", "欢迎", 2)],
    });
    expect(result).toMatchObject({
      content: "玩家来到工作室，与阿斯特约定绘制星图。",
      coveredMessageCount: 2,
    });
  });

  it("returns undefined for too few messages or model failure", async () => {
    completeTextMock.mockReset();
    expect(await summarizeMessages({
      settings: SETTINGS,
      character: character(),
      messages: [message("user", "你好", 1)],
    })).toBeUndefined();

    completeTextMock.mockReset().mockRejectedValue(new Error("超时"));
    expect(await summarizeMessages({
      settings: SETTINGS,
      character: character(),
      messages: [message("user", "你好", 1), message("assistant", "欢迎", 2)],
    })).toBeUndefined();
  });
});
