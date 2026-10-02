import { act, cleanup, renderHook } from "@testing-library/react";
import type { ChangeEvent } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { CharacterCardPreviewResponse, CharacterDetail } from "@mycompanion/shared";
import * as api from "../api";
import { useCharacterImport } from "./useCharacterImport";
vi.mock("../api", async original => ({ ...await original<typeof import("../api")>(), previewCharacterCard: vi.fn(), commitCharacterCard: vi.fn(), fetchCharacter: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const preview = (name: string): CharacterCardPreviewResponse => ({ name, format: "ccv2-json", specVersion: "2.0", descriptionPreview: "", firstMessagePreview: "", creator: "", characterVersion: "", tags: [], alternateGreetingsCount: 0, groupOnlyGreetingsCount: 0, lorebookEntryCount: 0, regexScriptCount: 0, lorebookEntries: [], regexScripts: [], assetCount: 0, extensionKeys: [], unknownFieldPaths: [], compatibilityDefaultPaths: [], warningCodes: [] });
const file = (name: string) => new File(['{}'], name, { type: "application/json" });
const event = (files: File[]) => ({ currentTarget: { files, value: "" } }) as unknown as ChangeEvent<HTMLInputElement>;
const detail = (name: string) => ({ id: name, name }) as CharacterDetail;

it("continues a batch after per-file preview and commit failures, retries only failed files and reuses failed submission keys", async () => {
  let previewFails = true, commitFails = true;
  vi.mocked(api.previewCharacterCard).mockImplementation(async value => { if (value.name === "network.json" && previewFails) throw new api.ApiRequestError("OFFLINE", "Temporary preview failure"); return preview(value.name); });
  vi.mocked(api.commitCharacterCard).mockImplementation(async value => { if (value.name === "retry.json" && commitFails) throw new api.ApiRequestError("SAVE_FAILED", "Temporary commit failure"); return detail(value.name); });
  const { result } = renderHook(() => useCharacterImport({ onCommitted: vi.fn() }));
  await act(async () => { await result.current.handleCardFile(event([file("network.json"), file("retry.json"), file("good.json")])); });
  expect(result.current.preview?.name).toBe("retry.json"); expect(result.current.batchItems[0]?.status).toBe("failed");
  await act(async () => { await result.current.handleCommit(); }); expect(result.current.preview?.name).toBe("good.json");
  await act(async () => { await result.current.handleCommit(); }); expect(result.current.batchItems.map(item => item.status)).toEqual(["failed", "failed", "saved"]);
  const firstKey = vi.mocked(api.commitCharacterCard).mock.calls[0]![1]; commitFails = false;
  await act(async () => { await result.current.handleRetryFile(result.current.batchItems[1]!.id); });
  await act(async () => { await result.current.handleCommit(); });
  expect(vi.mocked(api.commitCharacterCard).mock.calls[2]![1]).toBe(firstKey);
  previewFails = false; await act(async () => { await result.current.handleRetryFile(result.current.batchItems[0]!.id); });
  await act(async () => { await result.current.handleSkipFile(); });
  expect(result.current.batchItems.map(item => item.status)).toEqual(["skipped", "saved", "saved"]);
  expect(vi.mocked(api.commitCharacterCard).mock.calls.filter(([value]) => value.name === "good.json")).toHaveLength(1);
});

it("opens an existing duplicate without uploading and sends replace identity and revision explicitly", async () => {
  const matched = { ...preview("duplicate"), duplicates: [{ id: "existing", name: "duplicate", match: "exact" as const, updatedAt: "2026-10-02T00:00:00Z" }] };
  vi.mocked(api.previewCharacterCard).mockResolvedValue(matched); vi.mocked(api.fetchCharacter).mockResolvedValue(detail("existing")); vi.mocked(api.commitCharacterCard).mockResolvedValue(detail("existing"));
  const committed = vi.fn(), { result } = renderHook(() => useCharacterImport({ onCommitted: committed }));
  await act(async () => { await result.current.handleCardFile(event([file("duplicate.json")])); });
  await act(async () => { await result.current.handleOpenDuplicate("existing"); });
  expect(api.commitCharacterCard).not.toHaveBeenCalled(); expect(committed).toHaveBeenCalledWith(detail("existing"));
  await act(async () => { await result.current.handleCardFile(event([file("duplicate.json")])); });
  await act(async () => { await result.current.handleCommit("replace", "existing", matched.duplicates[0]!.updatedAt); });
  expect(api.commitCharacterCard).toHaveBeenCalledWith(expect.any(File), expect.any(String), undefined, { mode: "replace", targetId: "existing", expectedUpdatedAt: "2026-10-02T00:00:00Z" });
});

it("does not restore a late preview after canceling the import batch", async () => {
  let resolve!: (value: CharacterCardPreviewResponse) => void;
  vi.mocked(api.previewCharacterCard).mockReturnValue(new Promise(yes => { resolve = yes; }));
  const { result } = renderHook(() => useCharacterImport({ onCommitted: vi.fn() })); let pending!: Promise<void>;
  await act(async () => { pending = result.current.handleCardFile(event([file("late.json")])); await Promise.resolve(); });
  act(() => result.current.clearImportState()); await act(async () => { resolve(preview("late")); await pending; });
  expect(result.current.preview).toBeNull(); expect(result.current.batchItems).toEqual([]);
});
