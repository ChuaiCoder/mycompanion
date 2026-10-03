import { expect, it, vi } from "vitest";
import type { ExtensionChatMessage, ModelResponseState } from "@mycompanion/shared";
import { selectMessageSwipe, type SwipeRuntime } from "./swipe-runtime";

function fixture() {
  const message: ExtensionChatMessage = { id: "reply", mes: "Edited first", is_user: false, swipe_id: 0, swipes: ["First", "Second"],
    send_date: "old-date", gen_started: "old-start", extra: { variables: { left: 4 } },
    swipe_info: [{ custom: { preserved: true } }, { send_date: "second-date", extra: { variables: { right: 9 } }, custom: "right" }] };
  const context = { conversationId: "story", branchId: "branch", chat: [{ id: "user", mes: "Question", is_user: true }, message], chatMetadata: {} };
  const api: SwipeRuntime = { getContext: () => context, flushChatSaves: vi.fn().mockResolvedValue(undefined),
    saveMetadataDebounced: vi.fn(), saveChatConditional: vi.fn().mockResolvedValue(undefined), reloadCurrentChat: vi.fn().mockResolvedValue(undefined),
    addOneMessage: vi.fn(), event_types: { MESSAGE_SWIPED: "message_swiped" }, eventSource: { emit: vi.fn().mockResolvedValue(undefined) } };
  return { context, message, api, target: { conversationId: "story", branchId: "branch", messageId: "reply" } };
}
it("syncs edited candidate data, retains unknown swipe fields, awaits listeners and saves their changes", async () => {
  const { context, message, api, target } = fixture(); let resume!: () => void;
  api.eventSource.emit = vi.fn(async () => { await new Promise<void>(resolve => { resume = resolve; }); message.extra = { listener: true }; });
  const operation = selectMessageSwipe(target, 1, api); await vi.waitFor(() => expect(api.eventSource.emit).toHaveBeenCalled());
  expect(api.saveChatConditional).not.toHaveBeenCalled(); expect(message.mes).toBe("Second");
  expect(message.send_date).toBe("second-date"); expect(message.extra).toEqual({ variables: { right: 9 } });
  expect(message.swipes).toEqual(["Edited first", "Second"]);
  expect((message.swipe_info as Array<unknown>)[0]).toEqual({ custom: { preserved: true }, send_date: "old-date", gen_started: "old-start", gen_finished: undefined, extra: { variables: { left: 4 } } });
  resume(); await operation; expect(api.saveChatConditional).toHaveBeenCalledOnce();
  expect(context.chat[1]).toBe(message); expect(message.extra).toEqual({ listener: true });
});
it("does not save a new story after an awaited navigation listener, and ignores navigation during preflush", async () => {
  const { context, api, target } = fixture();
  api.eventSource.emit = vi.fn(async () => { context.conversationId = "other"; context.branchId = "other-branch"; });
  await selectMessageSwipe(target, 1, api); expect(api.saveMetadataDebounced).toHaveBeenCalledOnce();
  expect(api.saveChatConditional).not.toHaveBeenCalled(); expect(api.flushChatSaves).toHaveBeenCalledTimes(2);
  const second = fixture(); second.api.flushChatSaves = vi.fn(async () => { second.context.branchId = "navigated"; });
  await selectMessageSwipe(second.target, 1, second.api); expect(second.message.mes).toBe("Edited first"); expect(second.api.eventSource.emit).not.toHaveBeenCalled();
});
it("reconciles failed optimistic persistence and reports a durable reload failure", async () => {
  const { api, target } = fixture(); api.saveChatConditional = vi.fn().mockRejectedValue(new Error("SQL rejected"));
  await expect(selectMessageSwipe(target, 1, api)).rejects.toThrow("SQL rejected");
  expect(api.reloadCurrentChat).toHaveBeenCalledWith({ discardFailedSaves: true });
  api.reloadCurrentChat = vi.fn().mockRejectedValue(new Error("Read failed"));
  // The first mock reconcile leaves an optimistic object; reset its selection.
  api.getContext().chat[1]!.swipe_id = 0;
  await expect(selectMessageSwipe(target, 1, api)).rejects.toThrow("重新读取失败：Read failed");
});

function nativeFixture() {
  const result = fixture();
  const state = (reasoning: string): ModelResponseState => ({ protocol: "openai", reasoning, signature: "",
    toolCalls: [], media: [{ mimeType: "image/png", data: btoa(reasoning) }], providerContent: [] });
  const firstState = state("first reasoning"), secondState = state("second reasoning");
  const privateInfo = (index: number, responseState: ModelResponseState, status: "complete" | "failed", originalContent: string) => ({
    version: 1, index, status, originalContent, responseState, finishReason: index === 0 ? "stop" : "length",
    completionOutcome: index === 0 ? "complete" : "truncated",
  });
  const first = privateInfo(0, firstState, "complete", "First"), second = privateInfo(1, secondState, "failed", "Second");
  result.message.mes = "First"; result.message.status = "complete";
  result.message.generationMetadata = { model: "controlled-fixture", temperature: 0.8, maxTokens: 64,
    responseState: firstState, finishReason: "stop", completionOutcome: "complete",
    usage: { source: "provider-reported", inputTokens: 11, outputTokens: 7, totalTokens: 18 }, toolRounds: [] };
  result.message.swipe_info = [
    { extra: { __mycompanion_native_candidate: first, variables: { left: 4 } }, unknown: "left" },
    { extra: { __mycompanion_native_candidate: second, variables: { right: 9 } }, unknown: "right" },
  ];
  // A pre-existing extension save may not mirror the host private info in extra.
  // Syncing an old candidate must not accidentally discard the native record.
  return { ...result, first, second, firstState, secondState };
}

it("selects native candidate state before the awaited event and restores it without duplicating request usage", async () => {
  const { api, target, message, first, secondState, firstState } = nativeFixture();
  const usage = structuredClone((message.generationMetadata as Record<string, unknown>).usage);
  api.eventSource.emit = vi.fn(async () => {
    expect(message.status).toBe("failed");
    expect(message.generationMetadata).toMatchObject({ responseState: secondState, finishReason: "length", completionOutcome: "truncated", usage });
  });
  await selectMessageSwipe(target, 1, api);
  const infos = message.swipe_info as Array<{ extra: Record<string, unknown>; unknown: string }>;
  expect(infos[0]!.extra.__mycompanion_native_candidate).toEqual(first);
  expect(infos[0]!.extra.variables).toEqual({ left: 4 }); expect(infos[0]!.unknown).toBe("left");
  expect(infos.every(info => !("usage" in (info.extra.__mycompanion_native_candidate as object)))).toBe(true);
  api.eventSource.emit = vi.fn().mockResolvedValue(undefined);
  await selectMessageSwipe(target, 0, api);
  expect(message.mes).toBe("First"); expect(message.status).toBe("complete");
  expect(message.generationMetadata).toMatchObject({ responseState: firstState, finishReason: "stop", completionOutcome: "complete", usage });
});

it("does not borrow the previous native reasoning or media for an unrelated extension candidate", async () => {
  const { api, target, message } = nativeFixture();
  (message.swipe_info as unknown[])[1] = { extra: { variables: { external: true } } };
  await selectMessageSwipe(target, 1, api);
  expect(message.mes).toBe("Second"); expect(message.extra).toEqual({ variables: { external: true } });
  expect(message.generationMetadata).toMatchObject({ model: "controlled-fixture", usage: { totalTokens: 18 } });
  expect(message.generationMetadata).not.toHaveProperty("responseState");
  expect(message.generationMetadata).not.toHaveProperty("finishReason");
});
