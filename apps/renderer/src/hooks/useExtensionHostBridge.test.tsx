import { useState } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { toExtensionChatState, toExtensionMessage, type ChatMessage, type ConversationDetail, type ExtensionChatState } from "@mycompanion/shared";
import { useExtensionHostBridge } from "./useExtensionHostBridge";

const host = vi.hoisted(() => ({ context: undefined as any, callbacks: undefined as any }));
vi.mock("../ExtensionHost", () => ({ useExtensionHost: (context: any, callbacks: any) => { host.context = context; host.callbacks = callbacks; } }));
afterEach(() => { cleanup(); host.context = undefined; host.callbacks = undefined; });

const key = "__mycompanion_native_candidate";
const state = (reasoning: string, image: boolean) => ({ protocol: "openai" as const, model: "controlled", reasoning,
  signature: reasoning + "_SIGNATURE", toolCalls: [], media: image ? [{ mimeType: "image/png", data: "AQ==" }] : [], providerContent: [] });
function nativeMessage(): ChatMessage {
  const a = { version: 1, index: 0, originalContent: "A", status: "complete", finishReason: "stop", completionOutcome: "complete", responseState: state("AR", true) };
  const b = { version: 1, index: 1, originalContent: "B", status: "complete", finishReason: "length", completionOutcome: "truncated", responseState: state("BR", false) };
  return { id: "reply", conversationId: "story", branchId: "branch", parentMessageId: null, role: "assistant", content: "A", status: "complete", createdAt: "2026-10-03",
    generationMetadata: { model: "controlled", temperature: 0.8, maxTokens: 64, nativeCandidates: true, responseState: state("AR", true), finishReason: "stop", completionOutcome: "complete",
      usage: { source: "provider-reported", inputTokens: 11, outputTokens: 7, totalTokens: 18 } },
    extensionData: { swipes: ["A", "B"], swipe_id: 0, swipe_info: [{ extra: { [key]: a, variables: { a: 1 } } }, { extra: { [key]: b, variables: { b: 2 } } }],
      extra: { [key]: a, variables: { a: 1 } }, unknown: { retained: true } } };
}
const conversation = (messages: ChatMessage[]): ConversationDetail => ({ id: "story", activeBranchId: "branch", characterId: "role", characterName: "Role", title: "Fixture",
  messages, messageCount: messages.length, lastMessagePreview: messages.at(-1)?.content ?? "", createdAt: "2026-10-03", updatedAt: "2026-10-03", chatMetadata: {} });
function setup(initial: ConversationDetail) {
  const noop = vi.fn();
  return renderHook(() => {
    const [active, setActive] = useState<ConversationDetail | null>(initial);
    useExtensionHostBridge({ online: true, activeConversation: active, selectedCharacter: null, characters: [], codePlugins: [], isGenerating: false, isNativeGenerating: false,
      generationControlsBusy: false, navigationRevision: { current: 0 }, characterRefreshRevision: { current: 0 }, streamControllerRef: { current: null },
      setActiveConversation: setActive, setExtensionGenerating: noop, setConversations: noop, setCharacters: noop, setSelectedCharacter: noop,
      setChatInput: noop, setWorkspaceView: noop, setCharacterPanelOpen: noop, setOpenedPluginId: noop, clearImportState: noop,
      handleStopGeneration: async () => {}, handleSendMessage: async () => ({ status: "preview" }), handleRegenerate: async () => ({ status: "preview" }),
      handleContinue: async () => ({ status: "preview" }), handleImpersonate: async () => ({ status: "preview" }),
      handleCodePluginStatus: noop, handleCodePluginContributions: async () => {} });
    return active;
  });
}
function alternate(story: ConversationDetail): ExtensionChatState {
  const snapshot = toExtensionChatState(story), message = snapshot.messages[0]!;
  message.mes = "B"; message.swipe_id = 1; message.extra = (message.swipe_info as any[])[1].extra;
  return snapshot;
}

it("projects selected native reasoning/media into React and survives the next host roundtrip without duplicate metadata", () => {
  const initial = conversation([nativeMessage()]), view = setup(initial), next = alternate(initial);
  act(() => host.callbacks.renderChat(initial, next));
  let message = view.result.current!.messages[0]!;
  expect(message.generationMetadata).toMatchObject({ responseState: state("BR", false), finishReason: "length", completionOutcome: "truncated", usage: { totalTokens: 18 }, nativeCandidates: true });
  expect(message.extensionData).not.toHaveProperty("generationMetadata"); expect(message.extensionData).toMatchObject({ swipe_id: 1, extra: { variables: { b: 2 } }, unknown: { retained: true } });
  expect(host.context.chat[0].generationMetadata.responseState.reasoning).toBe("BR");
  act(() => host.callbacks.renderChat(initial, { messages: [structuredClone(host.context.chat[0])], metadata: {} }));
  message = view.result.current!.messages[0]!;
  expect(message.content).toBe("B"); expect(message.generationMetadata?.responseState?.reasoning).toBe("BR");
  expect(toExtensionMessage(message, "Role").generationMetadata).toEqual(message.generationMetadata);
});

it("ignores raw forged request metadata and keeps the host audit while applying the selected private candidate", () => {
  const initial = conversation([nativeMessage()]), view = setup(initial), next = alternate(initial);
  next.messages[0]!.generationMetadata = { model: "forged", nativeCandidates: false, usage: { totalTokens: 999999 }, responseState: state("FORGED", true) };
  next.messages[0]!.future = { unknown: true };
  act(() => host.callbacks.renderChat(initial, next));
  const message = view.result.current!.messages[0]!;
  expect(message.generationMetadata).toMatchObject({ model: "controlled", nativeCandidates: true, usage: { totalTokens: 18 }, responseState: state("BR", false) });
  expect(message.extensionData).not.toHaveProperty("generationMetadata"); expect(message.extensionData?.future).toEqual({ unknown: true });
});

it("uses a newly known durable message's host metadata rather than trusting extension projection fields", () => {
  const initial = conversation([]), durable = conversation([nativeMessage()]), view = setup(initial), next = alternate(durable);
  next.messages[0]!.generationMetadata = { model: "forged", nativeCandidates: false, usage: { totalTokens: 999999 } };
  act(() => host.callbacks.renderChat(durable, next));
  const message = view.result.current!.messages[0]!;
  expect(message.generationMetadata).toMatchObject({ model: "controlled", nativeCandidates: true, usage: { totalTokens: 18 }, responseState: state("BR", false) });
  expect(message.extensionData).not.toHaveProperty("generationMetadata");
});

it("retains current native streaming progress when a stale persistence snapshot rerenders the same message", () => {
  const live = nativeMessage(); live.status = "streaming"; live.content = "current native partial"; live.extensionData = { extra: { variables: { current: 1 } } };
  live.generationMetadata = { model: "current-model", temperature: 0.7, maxTokens: 256 };
  const stale = structuredClone(live); stale.content = ""; delete stale.generationMetadata;
  const initial = conversation([live]), durable = conversation([stale]), view = setup(initial), next = toExtensionChatState(durable);
  next.messages[0]!.generationMetadata = { model: "forged", usage: { totalTokens: 999999 } }; next.messages[0]!.future = { retained: true };
  act(() => host.callbacks.renderChat(durable, next));
  const message = view.result.current!.messages[0]!;
  expect(message.content).toBe("current native partial"); expect(message.status).toBe("streaming"); expect(message.generationMetadata?.model).toBe("current-model");
  expect(message.extensionData).not.toHaveProperty("generationMetadata"); expect(message.extensionData?.future).toEqual({ retained: true });
});

it("accepts completed durable host billing and native history instead of a still-streaming local configuration", () => {
  const pending = nativeMessage(); pending.status = "streaming"; pending.content = "partial"; pending.extensionData = {};
  pending.generationMetadata = { model: "controlled", temperature: 0.8, maxTokens: 64 };
  const initial = conversation([pending]), durable = conversation([nativeMessage()]), view = setup(initial), next = alternate(durable);
  next.messages[0]!.generationMetadata = { model: "forged", nativeCandidates: false, usage: { totalTokens: 999999 } };
  act(() => host.callbacks.renderChat(durable, next));
  const message = view.result.current!.messages[0]!;
  expect(message.generationMetadata).toMatchObject({ nativeCandidates: true, usage: { totalTokens: 18 }, responseState: state("BR", false) });
  expect(message.content).toBe("B"); expect(message.status).toBe("complete"); expect(message.extensionData).not.toHaveProperty("generationMetadata");
});
