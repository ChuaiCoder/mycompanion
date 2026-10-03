import { useState } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatMessage, ConversationDetail, GenerationSseEvent } from "@mycompanion/shared";
import * as api from "../api";
import { useChatGeneration } from "./useChatGeneration";
vi.mock("../composer-drafts", () => ({ loadComposerDraftStore: async () => ({ read: () => undefined, write: () => {}, flush: async () => {} }) }));

vi.mock("../api", async importOriginal => ({
  ...await importOriginal<typeof import("../api")>(),
  streamChatMessage: vi.fn(), streamRegenerate: vi.fn(), streamForegroundMode: vi.fn(), fetchConversation: vi.fn(),
  stopGeneration: vi.fn(), deleteMessage: vi.fn(), editMessage: vi.fn(), listConversations: vi.fn(),
}));

const story = (id: string): ConversationDetail => ({
  id, characterId: id + "-character", characterName: id, title: id,
  lastMessagePreview: "", messageCount: 0, activeBranchId: id + "-branch", messages: [],
  createdAt: "2026-10-02T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z",
});
const first = story("first"), second = story("second");
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(initial = first) {
  const reports = { lorebook: vi.fn(), budget: vi.fn(), memory: vi.fn() };
  const hook = renderHook(() => {
    const [active, setActive] = useState<ConversationDetail | null>(initial);
    const [error, setError] = useState<string | null>(null);
    const chat = useChatGeneration({ initialInput: "", activeConversation: active,
      setActiveConversation: setActive, setConversations: vi.fn(), setRuntimeError: setError,
      providerModel: "test", setLastLorebookReport: reports.lorebook,
      setLastPromptBudget: reports.budget, setLastMemoryReport: reports.memory });
    return { ...chat, active, setActive, error };
  });
  return { ...hook, reports };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.fetchConversation).mockResolvedValue(first);
  vi.mocked(api.listConversations).mockResolvedValue({ items: [], total: 0 });
});
afterEach(cleanup);

it("impersonation streams only into the draft and leaves real chat messages untouched", async () => {
  const existing: ChatMessage = { id: "existing", conversationId: first.id, branchId: first.activeBranchId, parentMessageId: null, role: "assistant", content: "existing reply", status: "complete", createdAt: first.createdAt };
  const initial = { ...first, messages: [existing] }; vi.mocked(api.fetchConversation).mockResolvedValue(initial);
  vi.mocked(api.streamForegroundMode).mockImplementation(async (_id, mode, _signal, event) => {
    expect(mode).toBe("impersonate"); event({ type: "delta", delta: "partial" });
    event({ type: "impersonate_result", text: "final user draft" });
  });
  const { result } = fixture(initial);
  await act(async () => expect(await result.current.handleImpersonate()).toEqual({ status: "complete", text: "final user draft" }));
  expect(result.current.chatInput).toBe("final user draft"); expect(result.current.active?.messages).toEqual([existing]);
});

it("late impersonation output cannot replace the newly opened story's draft", async () => {
  let callback!: (event: GenerationSseEvent) => void; const pending = deferred<void>();
  vi.mocked(api.streamForegroundMode).mockImplementation(async (_id, _mode, _signal, event) => { callback = event; await pending.promise; });
  const { result } = fixture(); let operation!: ReturnType<typeof result.current.handleImpersonate>;
  act(() => { operation = result.current.handleImpersonate(); });
  act(() => { result.current.setActive(second); result.current.setChatInput("new story draft"); });
  await act(async () => { callback({ type: "delta", delta: "old partial" }); callback({ type: "impersonate_result", text: "old final" }); pending.resolve(); await operation; });
  expect(result.current.chatInput).toBe("new story draft"); expect(result.current.active?.id).toBe(second.id);
});

it("continued assistant start retains the same message prefix without appending a row", async () => {
  const existing: ChatMessage = { id: "continued", conversationId: first.id, branchId: first.activeBranchId, parentMessageId: null, role: "assistant", content: "prefix", status: "complete", createdAt: first.createdAt };
  const complete = { ...existing, content: "prefix suffix" }; const initial = { ...first, messages: [existing] };
  vi.mocked(api.fetchConversation).mockResolvedValue({ ...initial, messages: [complete] });
  vi.mocked(api.streamForegroundMode).mockImplementation(async (_id, mode, _signal, event) => {
    expect(mode).toBe("continue"); event({ type: "assistant_start", message: { ...existing, status: "streaming" } });
    event({ type: "delta", delta: " suffix" }); event({ type: "done", message: complete });
  });
  const { result } = fixture(initial); act(() => result.current.setChatInput("retained user draft"));
  await act(async () => expect(await result.current.handleContinue()).toEqual({ status: "complete", text: complete.content }));
  expect(result.current.active?.messages).toEqual([complete]); expect(result.current.chatInput).toBe("retained user draft");
});

it("accepts a regenerated branch and removes its old reply before the next output macro reads context", async () => {
  const message = (id: string, parentMessageId: string | null, role: ChatMessage["role"]): ChatMessage => ({
    id, parentMessageId, role, conversationId: first.id, branchId: first.activeBranchId,
    content: id, status: "complete", createdAt: first.createdAt,
  });
  const opening = message("opening", null, "assistant"), user = message("user", "opening", "user");
  const oldReply = message("old-reply", "user", "assistant");
  const accepted = { ...message("new-reply", "user", "assistant"), branchId: "regenerated-branch", content: "", status: "streaming" as const };
  const pending = deferred<void>();
  vi.mocked(api.streamRegenerate).mockReturnValue(pending.promise);
  const { result } = fixture({ ...first, messages: [opening, user, oldReply] });
  let run!: ReturnType<typeof result.current.handleRegenerate>;
  act(() => { run = result.current.handleRegenerate(); });
  const onEvent = vi.mocked(api.streamRegenerate).mock.calls[0]![2];
  act(() => {
    onEvent({ type: "assistant_start", message: accepted });
    // The next SSE macro_request is handled in the same API reader turn.
    // It must not wait for the end-of-stream reload or a deferred render.
    expect(result.current.active?.activeBranchId).toBe(accepted.branchId);
    expect(result.current.active?.messages.map(item => item.id)).toEqual([opening.id, user.id, accepted.id]);
    onEvent({ type: "delta", delta: "regenerated" });
  });
  expect(result.current.active?.messages.at(-1)?.content).toBe("regenerated");
  expect(result.current.active?.messages).not.toContainEqual(oldReply);
  vi.mocked(api.fetchConversation).mockResolvedValue(result.current.active!);
  await act(async () => { pending.resolve(); await run; });
});

it("commits a preceding user event with assistant_start so immediate macros see the actual new message", async () => {
  const pending = deferred<void>();
  vi.mocked(api.streamChatMessage).mockReturnValue(pending.promise);
  const { result } = fixture();
  let run!: ReturnType<typeof result.current.handleSendMessage>;
  act(() => { run = result.current.handleSendMessage("new user"); });
  const onEvent = vi.mocked(api.streamChatMessage).mock.calls[0]![3];
  const user: ChatMessage = { id: "new-user", parentMessageId: null, role: "user", conversationId: first.id,
    branchId: first.activeBranchId, content: "new user", status: "complete", createdAt: first.createdAt };
  const assistant: ChatMessage = { ...user, id: "new-assistant", parentMessageId: user.id, role: "assistant", content: "", status: "streaming" };
  act(() => {
    onEvent({ type: "user_message", message: user });
    onEvent({ type: "assistant_start", message: assistant });
    expect(result.current.active?.messages.map(item => item.id)).toEqual([user.id, assistant.id]);
  });
  await act(async () => { pending.resolve(); await run; });
});

it("refreshes the new branch after a historical edit and discards a late refresh after story navigation", async () => {
  const { result } = fixture();
  const original = { id: "old", conversationId: first.id, branchId: first.activeBranchId, parentMessageId: null, role: "assistant" as const, content: "old", status: "complete" as const, createdAt: first.createdAt };
  const edited = { ...original, id: "new", branchId: "new-branch", content: "edited" };
  const updated = { ...first, activeBranchId: edited.branchId, messages: [edited] };
  vi.mocked(api.editMessage).mockResolvedValue(edited); vi.mocked(api.fetchConversation).mockResolvedValue(updated);
  act(() => result.current.beginEditMessage(original)); act(() => result.current.setEditingDraft("edited"));
  await act(async () => { await result.current.saveEditMessage(original.id); });
  expect(result.current.active).toEqual(updated); expect(result.current.editingMessageId).toBeNull();
  const late = deferred<ConversationDetail>(); vi.mocked(api.fetchConversation).mockReturnValue(late.promise);
  act(() => result.current.beginEditMessage(edited)); let operation!: Promise<void>;
  await act(async () => { operation = result.current.saveEditMessage(edited.id); await Promise.resolve(); });
  act(() => result.current.setActive(second)); await act(async () => { late.resolve(updated); await operation; });
  expect(result.current.active?.id).toBe(second.id);
});

it("dryRun retains the draft and returns preview without consuming a slash command", async () => {
  vi.mocked(api.streamChatMessage).mockImplementation(async (_id, content, _signal, event, options) => {
    expect(content).toBe(""); expect(options?.dryRun).toBe(true);
    event({ type: "generation_end", reason: "preview" });
  });
  const { result } = fixture();
  act(() => result.current.setChatInput("/echo retained"));
  await act(async () => expect(await result.current.handleSendMessage(undefined, { dryRun: true })).toEqual({ status: "preview" }));
  expect(result.current.chatInput).toBe("/echo retained"); expect(result.current.active?.messages).toEqual([]);
});

it("preflight stop is a normal result, while an explicit preflight error remains a failure", async () => {
  const { result } = fixture();
  vi.mocked(api.streamChatMessage).mockImplementation(async (_id, _content, _signal, event) => {
    event({ type: "generation_end", reason: "stopped" });
  });
  await act(async () => expect(await result.current.handleSendMessage("", { allowEmpty: true })).toEqual({ status: "stopped" }));
  vi.mocked(api.streamChatMessage).mockImplementation(async (_id, _content, _signal, event) => {
    event({ type: "error", message: "preflight failed" });
    event({ type: "generation_end", reason: "stopped" });
  });
  await act(async () => expect(await result.current.handleSendMessage("", { allowEmpty: true })).toMatchObject({ status: "failed" }));
  expect(result.current.error).toBe("preflight failed");
});

it("propagates the caller's cancellation signal and resolves stopped", async () => {
  const caller = new AbortController();
  vi.mocked(api.streamChatMessage).mockImplementation(async (_id, _content, signal) => {
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const { result } = fixture(); let run!: ReturnType<typeof result.current.handleSendMessage>;
  act(() => { run = result.current.handleSendMessage("", { allowEmpty: true, signal: caller.signal }); });
  await act(async () => { caller.abort(new Error("caller stopped")); expect(await run).toEqual({ status: "stopped" }); });
  expect(result.current.error).toBeNull(); expect(result.current.isNativeGenerating).toBe(false);
});

it.each(["failure", "abort", "regenerate"])("does not restore an old story after a late %s", async mode => {
  const pending = deferred<void>();
  vi.mocked(api.streamChatMessage).mockReturnValue(pending.promise);
  vi.mocked(api.streamRegenerate).mockReturnValue(pending.promise);
  const { result } = fixture();
  let operation!: Promise<unknown>;
  act(() => { operation = mode === "regenerate" ? result.current.handleRegenerate() : result.current.handleSendMessage("first draft"); });
  act(() => { result.current.setActive(second); result.current.setChatInput("second draft"); });
  await act(async () => {
    pending.reject(mode === "abort" ? new DOMException("Stopped", "AbortError") : new Error("old failure"));
    await operation;
  });
  expect(result.current.active?.id).toBe(second.id);
  expect(result.current.chatInput).toBe("second draft");
  expect(result.current.error).toBeNull();
  expect(result.current.isNativeGenerating).toBe(false);
});

it("stops the originating generation even after selecting a different story", async () => {
  const pending = deferred<void>();
  vi.mocked(api.streamChatMessage).mockReturnValue(pending.promise);
  const { result } = fixture();
  let operation!: Promise<unknown>;
  act(() => { operation = result.current.handleSendMessage("first draft"); });
  const signal = vi.mocked(api.streamChatMessage).mock.calls[0]![2];
  act(() => result.current.setActive(second));
  await act(async () => { await result.current.handleStopGeneration(); });
  expect(signal.aborted).toBe(true);
  expect(api.stopGeneration).toHaveBeenCalledWith(first.id);
  await act(async () => { pending.reject(new DOMException("Stopped", "AbortError")); await operation; });
  expect(result.current.active?.id).toBe(second.id);
});

it("does not replace the selected story with a delayed delete response", async () => {
  const pending = deferred<ConversationDetail>();
  vi.mocked(api.deleteMessage).mockReturnValue(pending.promise);
  const { result } = fixture();
  let operation!: Promise<unknown>;
  act(() => { operation = result.current.handleDeleteMessage("first-message"); });
  act(() => result.current.setActive(second));
  await act(async () => { pending.resolve(first); await operation; });
  expect(result.current.active?.id).toBe(second.id);
});

it("keeps late diagnostic events in their originating story", async () => {
  const pending = deferred<void>();
  vi.mocked(api.streamChatMessage).mockReturnValue(pending.promise);
  const { result, reports } = fixture();
  let operation!: Promise<unknown>;
  act(() => { operation = result.current.handleSendMessage("first draft"); });
  const onEvent = vi.mocked(api.streamChatMessage).mock.calls[0]![3];
  act(() => result.current.setActive(second));
  act(() => {
    for (const type of ["lorebook", "prompt_budget", "memory"]) {
      onEvent({ type, report: {} } as GenerationSseEvent);
    }
  });
  expect(reports.lorebook).not.toHaveBeenCalled();
  expect(reports.budget).not.toHaveBeenCalled();
  expect(reports.memory).not.toHaveBeenCalled();
  await act(async () => { pending.resolve(); await operation; });
});

it("does not mark a failed model request as a successful connection", async () => {
  const pending = deferred<void>();
  vi.mocked(api.streamChatMessage).mockReturnValue(pending.promise);
  const { result } = fixture();
  const onConnection = vi.fn();
  window.addEventListener("mycompanion:provider-tested", onConnection);
  let operation!: Promise<unknown>;
  try {
    act(() => { operation = result.current.handleSendMessage("draft"); });
    const onEvent = vi.mocked(api.streamChatMessage).mock.calls[0]![3];
    act(() => onEvent({ type: "done", message: { id: "failed", status: "failed" } } as GenerationSseEvent));
    expect(onConnection).not.toHaveBeenCalled();
    act(() => onEvent({ type: "done", message: { id: "complete", status: "complete" } } as GenerationSseEvent));
    expect(onConnection).toHaveBeenCalledOnce();
  } finally {
    window.removeEventListener("mycompanion:provider-tested", onConnection);
    await act(async () => { pending.resolve(); await operation; });
  }
});

it("starts only one stream for synchronous repeated sends and aborts it on unmount", async () => {
  const pending = deferred<void>();
  vi.mocked(api.streamChatMessage).mockReturnValue(pending.promise);
  const { result, unmount } = fixture();
  let operation!: Promise<unknown>;
  act(() => {
    operation = result.current.handleSendMessage("first draft");
    void result.current.handleSendMessage("duplicate draft");
  });
  expect(api.streamChatMessage).toHaveBeenCalledOnce();
  const signal = vi.mocked(api.streamChatMessage).mock.calls[0]![2];
  unmount();
  expect(signal.aborted).toBe(true);
  pending.reject(new DOMException("Stopped", "AbortError"));
  await operation;
});

it.each([false, true])("connection result respects saved connection changes (unchanged=%s)", async connectionUnchanged => {
  const pending = deferred<void>();
  vi.mocked(api.streamChatMessage).mockReturnValue(pending.promise);
  const { result } = fixture();
  const onConnection = vi.fn();
  window.addEventListener("mycompanion:provider-tested", onConnection);
  let operation!: Promise<unknown>;
  try {
    act(() => { operation = result.current.handleSendMessage("draft"); });
    const onEvent = vi.mocked(api.streamChatMessage).mock.calls[0]![3];
    // Same model name may still have a new URL or credentials. A no-op extension
    // settings flush is explicitly distinguished from a changed connection.
    window.dispatchEvent(new CustomEvent("mycompanion:provider-saved", { detail: { model: "test", connectionUnchanged } }));
    act(() => onEvent({ type: "done", message: { id: "reply", status: "complete" } } as GenerationSseEvent));
    expect(onConnection).toHaveBeenCalledTimes(connectionUnchanged ? 1 : 0);
  } finally {
    window.removeEventListener("mycompanion:provider-tested", onConnection);
    await act(async () => { pending.resolve(); await operation; });
  }
});
