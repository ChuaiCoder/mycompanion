import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorldInfoDocument } from "@mycompanion/shared";
import { WorldInfoPanel } from "./WorldInfoPanel";

const state = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), drafts: new Map(), selected: "", flush: vi.fn() }));
vi.mock("../world-info-runtime", () => ({ loadWorldInfoRuntime: async () => ({
  newWorldInfoEntryTemplate: { content: "", key: [] }, loadWorldInfo: state.load, saveWorldInfo: state.save,
  syncWorldInfoControls: vi.fn(), selectWorldInfoEditor: (name: string) => window.dispatchEvent(new CustomEvent("mycompanion:world-editor", { detail: { name } })),
}) }));
vi.mock("../world-editor-drafts", () => ({ loadWorldDraftStore: async () => ({
  read: (name: string) => state.drafts.get(name), write: (name: string, draft: unknown) => state.drafts.set(name, structuredClone(draft)),
  selected: () => state.selected, select: (name: string) => { state.selected = name; }, remove: (name: string) => state.drafts.delete(name),
  merge: (_base: unknown, draft: unknown) => draft, flush: state.flush,
}) }));
const book = (content: string): WorldInfoDocument => ({ entries: { "1": { uid: 1, comment: "Entry", content, key: ["star"], custom: "preserve" } } });
beforeEach(() => { state.drafts.clear(); state.selected = ""; state.load.mockImplementation(async (name: string) => book(name)); state.save.mockResolvedValue(undefined); });
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); });
async function select(name: string, expected: string) {
  await act(async () => { window.dispatchEvent(new CustomEvent("mycompanion:world-editor", { detail: { name } })); });
  await waitFor(() => expect(screen.getByRole("textbox", { name: "内容" })).toHaveValue(expected));
}
async function mounted() { render(<WorldInfoPanel open online onClose={() => {}} />); await act(async () => {}); }

it("saves editable advanced matching and insertion fields without dropping imported fields", async () => {
  await mounted(); await select("A", "A");
  fireEvent.change(screen.getByRole("textbox", { name: "辅助关键词（每行一个）" }), { target: { value: "moon\nport" } });
  fireEvent.change(screen.getByRole("combobox", { name: "辅助关键词条件" }), { target: { value: "3" } });
  fireEvent.change(screen.getByRole("combobox", { name: "插入位置" }), { target: { value: "4" } });
  fireEvent.change(screen.getByRole("spinbutton", { name: "距最新消息的深度" }), { target: { value: "2" } });
  fireEvent.change(screen.getByRole("combobox", { name: "区分大小写" }), { target: { value: "yes" } });
  fireEvent.click(screen.getByRole("button", { name: "保存世界书" }));
  await waitFor(() => expect(state.save).toHaveBeenCalledOnce());
  expect(state.save.mock.calls[0]![1].entries[1]).toMatchObject({ custom: "preserve", keysecondary: ["moon", "port"], selectiveLogic: 3, position: 4, depth: 2, caseSensitive: true });
});

it("retains unsaved edits by book across switching and a new document mount without saving the book", async () => {
  await mounted(); await select("A", "A");
  fireEvent.change(screen.getByRole("textbox", { name: "内容" }), { target: { value: "A draft" } });
  await select("B", "B"); await select("A", "A draft");
  expect(state.save).not.toHaveBeenCalled(); expect(state.drafts.get("A").document.entries[1].custom).toBe("preserve");
  cleanup(); await mounted(); await screen.findByText("已恢复未保存的草稿；点击保存后才会用于对话。");
  expect(screen.getByRole("textbox", { name: "内容" })).toHaveValue("A draft");
});

it("does not let a late book response replace the newer selection or lose edits after a failed read", async () => {
  await mounted(); await select("A", "A");
  fireEvent.change(screen.getByRole("textbox", { name: "内容" }), { target: { value: "Keep" } });
  let resolve!: (value: WorldInfoDocument) => void;
  state.load.mockImplementationOnce(() => new Promise(value => { resolve = value; }));
  act(() => { window.dispatchEvent(new CustomEvent("mycompanion:world-editor", { detail: { name: "slow" } })); });
  await select("B", "B"); await act(async () => { resolve(book("slow")); });
  expect(screen.getByRole("textbox", { name: "内容" })).toHaveValue("B");
  state.load.mockRejectedValueOnce(new Error("offline"));
  await act(async () => { window.dispatchEvent(new CustomEvent("mycompanion:world-editor", { detail: { name: "broken" } })); });
  expect(screen.getByRole("alert")).toHaveTextContent("offline"); await select("A", "Keep");
});

it("retains a failed save and edits made during a successful save", async () => {
  await mounted(); await select("A", "A"); fireEvent.change(screen.getByRole("textbox", { name: "内容" }), { target: { value: "first" } });
  state.save.mockRejectedValueOnce(new Error("503")); fireEvent.click(screen.getByRole("button", { name: "保存世界书" }));
  await screen.findByText("503"); expect(state.drafts.get("A").document.entries[1].content).toBe("first");
  let resolve!: () => void; state.save.mockImplementationOnce(() => new Promise<void>(value => { resolve = value; }));
  fireEvent.click(screen.getByRole("button", { name: "保存世界书" }));
  fireEvent.change(screen.getByRole("textbox", { name: "内容" }), { target: { value: "second" } });
  await act(async () => { resolve(); });
  expect(screen.getByRole("button", { name: "保存世界书" })).toBeEnabled();
  expect(state.drafts.get("A").base.entries[1].content).toBe("first"); expect(state.drafts.get("A").document.entries[1].content).toBe("second");
});

it("canceling discard keeps the draft; confirmed discard removes it only after a successful read", async () => {
  await mounted(); await select("A", "A"); fireEvent.change(screen.getByRole("textbox", { name: "内容" }), { target: { value: "draft" } });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  fireEvent.click(screen.getByRole("button", { name: "放弃草稿" })); await act(async () => {});
  expect(screen.getByRole("textbox", { name: "内容" })).toHaveValue("draft");
  confirm.mockReturnValue(true); state.load.mockRejectedValueOnce(new Error("read failed"));
  fireEvent.click(screen.getByRole("button", { name: "放弃草稿" })); await screen.findByText("read failed"); expect(state.drafts.has("A")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "放弃草稿" })); await waitFor(() => expect(state.drafts.has("A")).toBe(false));
  expect(screen.getByRole("textbox", { name: "内容" })).toHaveValue("A");
});
