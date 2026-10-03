import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ConversationDetail } from "@mycompanion/shared";
import * as api from "../api";
import * as settings from "../extension-settings";
import { useConversations } from "./useConversations";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const story = (id: string, branch: string): ConversationDetail => ({ id, activeBranchId: branch, characterId: "role", characterName: "Role", title: id, messages: [], messageCount: 0, lastMessagePreview: "", createdAt: "2026-10-03", updatedAt: "2026-10-03" });
function setup() {
  const navigationRevision = { current: 0 }, setRuntimeError = vi.fn();
  const view = renderHook(() => useConversations({ navigationRevision, resumeConversationId: undefined, selectedCharacterId: undefined, setWorkspaceView: vi.fn(), setRuntimeError }));
  act(() => { view.result.current.setActiveConversation(story("original", "branch")); });
  return { ...view, setRuntimeError };
}
it("does not dispatch an old branch activation after navigation during the settings flush", async () => {
  let resume!: () => void; vi.spyOn(settings, "flushSharedExtensionSettings").mockImplementation(() => new Promise<void>(resolve => { resume = resolve; }));
  vi.spyOn(api, "fetchConversation").mockResolvedValue(story("other", "other-branch"));
  const activate = vi.spyOn(api, "activateBranch").mockResolvedValue(story("original", "candidate"));
  const { result } = setup(); let operation!: Promise<void>;
  act(() => { operation = result.current.handleActivateBranch("original", "candidate"); });
  expect(result.current.branchBusy).toBe(true);
  await act(async () => { await result.current.handleOpenConversation("other"); });
  await act(async () => { resume(); await operation; });
  expect(activate).not.toHaveBeenCalled(); expect(result.current.activeConversation?.id).toBe("other"); expect(result.current.branchBusy).toBe(false);
});
it("ignores a dispatched activation's late response after navigation and preserves visible errors on a failed flush", async () => {
  vi.spyOn(settings, "flushSharedExtensionSettings").mockResolvedValue(undefined);
  vi.spyOn(api, "fetchConversation").mockResolvedValue(story("other", "other-branch"));
  let resume!: (value: ConversationDetail) => void;
  const activate = vi.spyOn(api, "activateBranch").mockImplementation(() => new Promise(resolve => { resume = resolve; }));
  const { result, setRuntimeError } = setup(); let operation!: Promise<void>;
  await act(async () => { operation = result.current.handleActivateBranch("original", "candidate"); });
  expect(activate).toHaveBeenCalledWith("original", "candidate");
  await act(async () => { await result.current.handleOpenConversation("other"); });
  await act(async () => { resume(story("original", "candidate")); await operation; });
  expect(result.current.activeConversation?.id).toBe("other");
  act(() => result.current.setActiveConversation(story("original", "branch")));
  vi.mocked(settings.flushSharedExtensionSettings).mockRejectedValue(new Error("Unsaved extension write"));
  await act(async () => { await result.current.handleActivateBranch("original", "candidate"); });
  expect(activate).toHaveBeenCalledTimes(1); expect(result.current.activeConversation?.activeBranchId).toBe("branch");
  expect(setRuntimeError).toHaveBeenLastCalledWith("Unsaved extension write");
});
