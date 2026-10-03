import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

// 启动恢复竞态复现：sessionStorage 同时带有角色与故事 ID（扩展刷新/页面恢复的真实形态），
// 挂载后两条恢复链路并行，最终界面必须落在恢复的故事上。

const characterId = "81fd7803-b4e0-409d-a2da-2c3db0169452";
const conversationId = "2e141519-4e8f-4323-a8c1-59e8f619be8a";
const messageId = "7b9e2a50-3c6f-4f3a-9c3f-2f0f6f2a1111";
const now = new Date().toISOString();

const characterDetail = {
  id: characterId,
  name: "林晚",
  description: "绘本画家",
  personality: "温柔",
  scenario: "海边小镇",
  firstMessage: "要不要坐一会儿？",
  alternateGreetings: [],
  exampleDialogue: "",
  systemPrompt: "",
  postHistoryInstructions: "",
  creatorNotes: "",
  creator: "",
  characterVersion: "1.0",
  tags: [],
  sourceFormat: "ccv2-json",
  sourceVersion: "2.0",
  alternateGreetingsCount: 0,
  lorebookEntryCount: 0,
  regexScriptCount: 0,
  rawExtensions: {},
  unknownFieldPaths: [],
  lorebookEntries: [],
  regexScripts: [],
  regexEnabled: [],
  lorebookEnabled: [],
  createdAt: now,
  updatedAt: now,
};

const message = {
  id: messageId,
  conversationId,
  branchId: conversationId,
  parentMessageId: null,
  role: "assistant",
  content: "要不要坐一会儿？",
  status: "complete",
  createdAt: now,
};

const conversationDetail = {
  id: conversationId,
  characterId,
  characterName: "林晚",
  title: "林晚 · 测试故事",
  lastMessagePreview: "要不要坐一会儿？",
  messageCount: 1,
  activeBranchId: conversationId,
  createdAt: now,
  updatedAt: now,
  messages: [message],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function stubResumeFetch(delay: { character?: number; conversation?: number } = {}) {
  const latency = (ms: number | undefined) => new Promise((resolve) => setTimeout(resolve, ms ?? 0));
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/health")) return json({ status: "ok", service: "mycompanion-local-service", version: "0.2.1" });
    if (url.includes(`/api/characters/${characterId}`)) { await latency(delay.character); return json(characterDetail); }
    if (url.endsWith("/api/characters")) return json({ items: [], total: 0 });
    if (url.includes(`/api/conversations/${conversationId}`)) { await latency(delay.conversation); return json(conversationDetail); }
    if (url.endsWith("/api/conversations")) return json({ items: [], total: 0 });
    if (url.includes("/api/settings/provider")) return json({ kind: "openai-compatible", baseUrl: "http://localhost", model: "test", hasApiKey: false, temperature: 1, maxTokens: 1024, contextLimitTokens: 8192 });
    if (url.endsWith("/api/plugins")) return json({ items: [], total: 0 });
    return json({ error: { message: "not found" } }, 404);
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("App startup resume", () => {
  it.each([
    { name: "character resolves first", delay: { character: 0, conversation: 30 } },
    { name: "conversation resolves first", delay: { character: 30, conversation: 0 } },
  ])("restores the story when both character and story ids are stashed ($name)", async ({ delay }) => {
    stubResumeFetch(delay);
    sessionStorage.setItem(
      "mycompanion.extension-resume",
      JSON.stringify({ view: "chat", characterId, conversationId }),
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("林晚 · 测试故事")).toBeInTheDocument();
    });
  });
});
