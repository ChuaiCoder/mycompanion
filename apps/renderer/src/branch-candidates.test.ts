import { expect, it } from "vitest";
import type { ConversationDetail, StoryExportJson } from "@mycompanion/shared";
import { replyBranches } from "./branch-candidates";
it("offers only same-turn regeneration branches with identical prefixes and no later continuation", () => {
  const user = { id: "user", parentMessageId: null, role: "user" as const, content: "Question", status: "complete" as const, createdAt: "2026-10-03", extensionData: { extra: { retained: 1 } } };
  const reply = { id: "reply", parentMessageId: "user", role: "assistant" as const, content: "First", status: "complete" as const, createdAt: "2026-10-03" };
  const active: ConversationDetail = { id: "story", characterId: "role", characterName: "Role", title: "Story", activeBranchId: "a", createdAt: "2026-10-03", updatedAt: "2026-10-03", messageCount: 2, lastMessagePreview: "First", messages: [user, reply].map(message => ({ ...message, conversationId: "story", branchId: "a" })) };
  const messages: StoryExportJson["messages"] = [
    ...[user, reply].map(message => ({ ...message, branchId: "a" })),
    ...[{ ...user, extensionData: { name: "User", is_system: false, send_date: user.createdAt, extra: { retained: 1 } } }, { ...reply, id: "second", content: "Second" }].map(message => ({ ...message, branchId: "b" })),
    ...[{ ...user, content: "Edited question" }, reply].map(message => ({ ...message, branchId: "edited" })),
    ...[user, reply, { ...user, id: "later", parentMessageId: "reply" }].map(message => ({ ...message, branchId: "continued" })),
  ];
  const story: StoryExportJson = { format: "mycompanion-story", formatVersion: 1, conversation: { ...active }, messages, stageSummary: null, memories: [] };
  expect(replyBranches(story, active).map(item => item.branchId)).toEqual(["a", "b"]);
  expect(replyBranches({ ...story, conversation: { ...story.conversation, id: "other" } }, active)).toEqual([]);
});
