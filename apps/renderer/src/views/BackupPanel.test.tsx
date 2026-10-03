import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BackupPanel } from "./BackupPanel";
import i18n from "../i18n";
const host = vi.hoisted(() => ({ flush: vi.fn(), reload: vi.fn(), world: vi.fn(), composer: vi.fn() }));
vi.mock("../extension-settings", () => ({ flushSharedExtensionSettings: host.flush, reloadApplication: host.reload,
  loadSharedExtensionSettings: vi.fn(), saveSharedExtensionSettings: vi.fn(), saveSharedExtensionSettingsDebounced: vi.fn(), onSharedExtensionSettingsSaved: vi.fn() }));
vi.mock("../world-editor-drafts", () => ({ flushWorldEditorDrafts: host.world }));
vi.mock("../composer-drafts", () => ({ flushComposerDrafts: host.composer }));
const backup = { format: "mycompanion-backup", formatVersion: 1, createdAt: "2026-10-02T00:00:00.000Z",
  manifest: { characterCount: 0, conversationCount: 0, messageCount: 0, memoryCount: 0, pluginCount: 0, codePluginCount: 0, settingsIncluded: false, checksum: "0".repeat(64) },
  characters: [], conversations: [], memories: [], stageSummaries: [], conversationSettings: [], plugins: [], codePlugins: [], providerSettings: null };
const tally = { new: 0, overwrite: 0, skip: 0, conflict: 0 };
const applied = { characters: 0, conversations: 0, memories: 0, plugins: 0, codePlugins: 0, extensionSettings: 0, userAvatars: 0, worldbooks: 0, worldInfoSettings: 0, retainedCharacterChats: 0 };
const preview = { valid: true, errors: [], sections: Object.fromEntries(Object.keys(applied).map(key => [key, tally])), totals: tally };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
function file(value: unknown = backup) { const result = new File([JSON.stringify(value)], "backup.json", { type: "application/json" }); Object.defineProperty(result, "text", { value: async () => JSON.stringify(value) }); return result; }
beforeEach(() => { host.flush.mockResolvedValue(undefined); });
afterEach(async () => { cleanup(); await i18n.changeLanguage("zh"); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });

it("downloads the complete backup after flushing drafts and settings", async () => {
  const fetch = vi.fn(async () => response(backup)); vi.stubGlobal("fetch", fetch);
  const create = vi.fn(() => "blob:backup"); Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  render(<BackupPanel />); fireEvent.click(screen.getByRole("button", { name: "导出完整备份" }));
  await screen.findByText("已开始下载完整备份。"); expect(fetch).toHaveBeenCalledWith("/api/backup", expect.any(Object));
  expect(host.flush.mock.invocationCallOrder[0]).toBeLessThan(fetch.mock.invocationCallOrder[0]!); expect(create).toHaveBeenCalled(); expect(click).toHaveBeenCalledTimes(1);
});

it("previews each strategy and does not reload on a failed restore; retry succeeds", async () => {
  let fail = true; const fetch = vi.fn(async (url: string) => url.endsWith("preview") ? response(preview) : fail ? response({ error: { code: "RESTORE_FAILED", message: "恢复失败" } }, 500) : response({ applied, skipped: applied }));
  vi.stubGlobal("fetch", fetch); render(<BackupPanel />);
  fireEvent.change(screen.getByLabelText("选择备份文件"), { target: { files: [file()] } }); await screen.findByRole("table");
  expect(fetch).toHaveBeenLastCalledWith("/api/backup/restore/preview", expect.objectContaining({ body: JSON.stringify({ backup, strategy: "skip" }) }));
  expect(fetch.mock.calls.every(([url]) => url.endsWith("preview"))).toBe(true);
  fireEvent.change(screen.getByLabelText("恢复冲突处理"), { target: { value: "overwrite" } }); await screen.findByRole("table");
  fireEvent.click(screen.getByRole("button", { name: "确认恢复" })); await screen.findByText("恢复失败"); expect(host.reload).not.toHaveBeenCalled();
  expect(screen.getByRole("table")).toBeInTheDocument(); fail = false; fireEvent.click(screen.getByRole("button", { name: "确认恢复" }));
  await waitFor(() => expect(host.reload).toHaveBeenCalledTimes(1));
});

it("shows checksum errors returned with 422 and prevents restore, and cancel makes no write", async () => {
  const fetch = vi.fn(async () => response({ ...preview, valid: false, errors: ["完整性校验失败"] }, 422)); vi.stubGlobal("fetch", fetch);
  render(<BackupPanel />); fireEvent.change(screen.getByLabelText("选择备份文件"), { target: { files: [file()] } });
  await screen.findByText("完整性校验失败"); expect(screen.getByRole("button", { name: "确认恢复" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "取消" })); expect(screen.queryByRole("table")).not.toBeInTheDocument(); expect(fetch).toHaveBeenCalledTimes(1);
});

it("rejects other JSON files locally and prevents restore while generation is busy", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); const ui = render(<BackupPanel />);
  fireEvent.change(screen.getByLabelText("选择备份文件"), { target: { files: [file({ hello: "world" })] } });
  await screen.findByText("备份格式或版本不受支持，请选择 MyCompanion 完整备份文件。"); expect(fetch).not.toHaveBeenCalled();
  ui.rerender(<BackupPanel busy />); expect(screen.getByRole("button", { name: "导出完整备份" })).toBeDisabled();
});

it("changes language during a restore preview without losing the chosen file or strategy, or restoring it", async () => {
  await i18n.changeLanguage("en");
  const fetch = vi.fn(async (_url: string) => response({ ...preview, totals: { ...tally, new: 1000 } }));
  vi.stubGlobal("fetch", fetch); render(<BackupPanel />);
  fireEvent.change(screen.getByLabelText("Choose backup file"), { target: { files: [file()] } });
  await screen.findByRole("table", { name: "Restore preview" });
  fireEvent.change(screen.getByLabelText("Restore conflict handling"), { target: { value: "overwrite" } });
  await screen.findByText("Add 1,000, overwrite 0, skip 0.");
  await waitFor(() => expect(screen.getByRole("button", { name: "Confirm restore" })).toBeEnabled());
  await act(() => i18n.changeLanguage("zh"));
  expect(screen.getByRole("table", { name: "恢复预览" })).toBeInTheDocument();
  expect(screen.getByLabelText("恢复冲突处理")).toHaveValue("overwrite");
  expect(screen.getByText(/backup\.json/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "确认恢复" })).toBeEnabled();
  expect(fetch.mock.calls.every(([url]) => url.endsWith("/preview"))).toBe(true);
  expect(host.reload).not.toHaveBeenCalled();
});
