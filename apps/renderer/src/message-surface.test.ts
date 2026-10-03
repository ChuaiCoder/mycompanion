import { afterEach, expect, it, vi } from "vitest";
import type { ConversationDetail, ExtensionChatMessage } from "@mycompanion/shared";
import { MessageSurface } from "./message-surface";
afterEach(() => document.body.replaceChildren());
function fixture(count: number, branch = "branch"): ConversationDetail {
  return { id: "story", characterId: "role", characterName: "Role", title: "Long story", activeBranchId: branch,
    createdAt: "2026-10-03", updatedAt: "2026-10-03", messageCount: count, lastMessagePreview: "", messages:
      Array.from({ length: count }, (_, index) => ({ id: `message-${index}`, conversationId: "story", branchId: branch,
        parentMessageId: index ? `message-${index - 1}` : null, role: index % 2 ? "assistant" : "user",
        content: `Line ${index}`, status: "complete", createdAt: "2026-10-03" })) };
}
function bind() { const container = document.createElement("div"); document.body.append(container); const surface = new MessageSurface(); surface.bind(container, vi.fn()); return { surface, container }; }
it("keeps the complete 10000-message story while rendering 100 absolute indices, then loads the previous page", () => {
  const { surface, container } = bind(), story = fixture(10_000); surface.sync(story);
  expect(story.messages).toHaveLength(10_000); expect(surface.rows).toHaveLength(100);
  expect(container.querySelector('.mes')?.getAttribute('mesid')).toBe("9900");
  expect(container.querySelector('.last_mes')?.getAttribute('mesid')).toBe("9999");
  surface.loadMore(); expect(surface.rows).toHaveLength(200);
  expect(container.querySelector('.mes')?.getAttribute('mesid')).toBe("9800");
  expect(container.querySelectorAll('.last_mes')).toHaveLength(1);
});
it("preserves extension DOM removal and explicit older swipe nodes, and resets windows only on a scope switch or print", () => {
  const { surface, container } = bind(), story = fixture(250); surface.sync(story);
  const node = surface.rows.find(row => row.index === 180)!.element; node.dataset.extension = "kept";
  surface.rows.find(row => row.index === 190)!.element.remove();
  surface.sync({ ...story, messages: [...story.messages] });
  expect(container.querySelector('[mesid="180"]')).toBe(node); expect(node.dataset.extension).toBe("kept");
  expect(container.querySelector('[mesid="190"]')).toBeNull();
  const raw: ExtensionChatMessage = { id: "message-10", mes: "Older explicit candidate", is_user: false, swipes: ["Older explicit candidate", "Alternate"], swipe_id: 0 };
  const revealed = surface.add(raw, 10, { type: "swipe" }, { conversationId: "story", branchId: "branch", name2: "Role" });
  surface.sync(story); expect(revealed.isConnected).toBe(true);
  expect(container.querySelector('[mesid="10"]')).toBe(revealed);
  surface.sync(fixture(250, "new-branch")); expect(surface.rows).toHaveLength(100); expect(revealed.isConnected).toBe(false);
  surface.print(story.messages.map(message => ({ id: message.id, mes: message.content, is_user: message.role === "user" })), { conversationId: "story", branchId: "branch", name2: "Role" });
  expect(surface.rows).toHaveLength(100); expect(container.querySelector('[mesid="190"]')).not.toBeNull();
});
it("reveals a memory source and keeps its absolute index before focusing the same visible node", () => {
  const { surface, container } = bind(); surface.sync(fixture(250)); surface.ensureVisible("message-80");
  expect(container.querySelector('[mesid="80"]')?.getAttribute('data-message-id')).toBe("message-80");
  expect(surface.rows).toHaveLength(250); expect(container.querySelector('#show_more_messages')).toBeNull();
});
it("reconciles an optimistic extension swipe to an unchanged durable host snapshot after a failed save", () => {
  const { surface, container } = bind(), story = fixture(200); surface.sync(story);
  const original = container.querySelector('[mesid="199"]');
  surface.add({ id: "message-199", mes: "Unsaved candidate", is_user: false }, 199, { type: "swipe" }, { conversationId: "story", branchId: "branch", name2: "Role" });
  expect(surface.rows.find(row => row.index === 199)?.message.content).toBe("Unsaved candidate");
  surface.sync({ ...story, messages: [...story.messages] });
  expect(surface.rows.find(row => row.index === 199)?.message.content).toBe("Line 199");
  expect(container.querySelector('[mesid="199"]')).toBe(original);
});
it("removes deleted synchronized DOM rows and reindexes the remaining rows before extensions refresh them", () => {
  const { surface, container } = bind(), story = fixture(3); surface.sync(story);
  const retained = surface.rows.find(row => row.index === 2)!.element;
  const deleted = surface.rows.find(row => row.index === 1)!.element;
  surface.sync({ ...story, messageCount: 2, messages: [story.messages[2]!, story.messages[0]!] });
  expect(deleted.isConnected).toBe(false);
  expect(container.querySelectorAll(':scope > .mes')).toHaveLength(2);
  expect([...container.querySelectorAll(':scope > .mes')].map(node => [node.getAttribute('mesid'), node.getAttribute('data-message-id')]))
    .toEqual([["0", "message-2"], ["1", "message-0"]]);
  expect(container.querySelector('[mesid="0"]')).toBe(retained);
  expect(container.querySelector('.last_mes')?.getAttribute('mesid')).toBe("1");
});
