import { useRef } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CharacterDetail, ConversationDetail } from "@mycompanion/shared";
import * as api from "../api";
import { useConversations } from "./useConversations";
import { useCharacterSelection } from "./useCharacterSelection";

vi.mock("../api", async original => ({ ...await original<typeof import("../api")>(),
  fetchConversation: vi.fn(), fetchCharacter: vi.fn(), listCharacters: vi.fn() }));
const story = (id: string) => ({ id } as ConversationDetail);
const character = (id: string) => ({ id } as CharacterDetail);
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => { vi.resetAllMocks(); vi.mocked(api.listCharacters).mockResolvedValue({ items: [], total: 0 }); });
afterEach(cleanup);

it.each(["success", "failure"])("ignores a late startup story restore %s after navigation", async outcome => {
  const pending = deferred<ConversationDetail>(), error = vi.fn();
  vi.mocked(api.fetchConversation).mockImplementation(id => id === "old" ? pending.promise : Promise.resolve(story(id)));
  const { result } = renderHook(() => useConversations({ navigationRevision: useRef(0), resumeConversationId: "old",
    selectedCharacterId: undefined, setWorkspaceView: vi.fn(), setRuntimeError: error }));
  await act(async () => { await result.current.handleOpenConversation("new"); });
  await act(async () => {
    if (outcome === "success") pending.resolve(story("old")); else pending.reject(new Error("late failure"));
    await pending.promise.catch(() => {});
  });
  expect(result.current.activeConversation?.id).toBe("new");
  expect(error).not.toHaveBeenCalledWith("无法恢复之前的故事。");
});

it.each(["success", "failure"])("ignores a late startup character restore %s after selection", async outcome => {
  const pending = deferred<CharacterDetail>();
  vi.mocked(api.fetchCharacter).mockImplementation(id => id === "old" ? pending.promise : Promise.resolve(character(id)));
  const { result } = renderHook(() => useCharacterSelection({ navigationRevision: useRef(0), resumeCharacterId: "old",
    setWorkspaceView: vi.fn(), closeCharacterPanels: vi.fn(), clearImportState: vi.fn(), setSuccessMessage: vi.fn() }));
  await act(async () => { await result.current.handleSelectCharacter("new"); });
  await act(async () => {
    if (outcome === "success") pending.resolve(character("old")); else pending.reject(new Error("late failure"));
    await pending.promise.catch(() => {});
  });
  expect(result.current.selectedCharacter?.id).toBe("new");
  expect(result.current.listError).toBeNull();
});

it("still restores the previous story when navigation has not changed", async () => {
  const pending = deferred<ConversationDetail>();
  vi.mocked(api.fetchConversation).mockReturnValue(pending.promise);
  const { result } = renderHook(() => useConversations({ navigationRevision: useRef(0), resumeConversationId: "old",
    selectedCharacterId: undefined, setWorkspaceView: vi.fn(), setRuntimeError: vi.fn() }));
  await act(async () => { pending.resolve(story("old")); await pending.promise; });
  expect(result.current.activeConversation?.id).toBe("old");
});
