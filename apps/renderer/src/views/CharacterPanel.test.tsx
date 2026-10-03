import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CharacterDetail } from "@mycompanion/shared";
import { CharacterPanel } from "./CharacterPanel";

const detail: CharacterDetail = {
  id: "00000000-0000-4000-8000-000000000001", name: "阿斯特", description: "制图师。",
  personality: "好奇", scenario: "工坊", firstMessage: "欢迎。", alternateGreetings: [],
  alternateGreetingsCount: 0, exampleDialogue: "", systemPrompt: "", postHistoryInstructions: "",
  creatorNotes: "", tags: ["original"], creator: "MyCompanion", characterVersion: "1.0",
  sourceFormat: "ccv2-json", sourceVersion: "2.0",
  rawExtensions: { custom_flag: { keep: true } }, unknownFieldPaths: [],
  regexEnabled: [], lorebookEnabled: [], lorebookEntryCount: 0, regexScriptCount: 0,
  lorebookEntries: [], regexScripts: [], deletedAt: null,
  avatar: "aster.png", createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z",
};
const rawCard = {
  spec: "chara_card_v2", spec_version: "2.0",
  data: {
    name: "阿斯特", description: "制图师。", personality: "好奇", scenario: "工坊", first_mes: "欢迎。",
    mes_example: "", creator_notes: "", system_prompt: "", post_history_instructions: "",
    alternate_greetings: ["另一句问候"], tags: ["original"], creator: "MyCompanion", character_version: "1.0",
    extensions: { custom_flag: { keep: true }, world: "图志" },
  },
};
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });

function stubFetch(putResponse: (body: string) => Response = body => response({ ...detail, name: JSON.parse(body).card.data.name })) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("/export?format=json")) return response(rawCard);
    if (url === "/api/worldinfo/list") return response({ world_names: ["图志", "星图"] });
    if (url === `/api/characters/${detail.id}` && init?.method === "PUT") return putResponse(String(init.body));
    return response({ error: { code: "NOT_FOUND", message: "missing" } }, 404);
  });
  vi.stubGlobal("fetch", fetch);
  return { calls };
}

it("loads the raw card, edits fields and saves through the native PUT with extensions preserved", async () => {
  const { calls } = stubFetch();
  const onSaved = vi.fn();
  render(<CharacterPanel open online character={detail} onSaved={onSaved} onClose={() => {}} />);
  await waitFor(() => expect(screen.getByLabelText("名称")).toHaveValue("阿斯特"));
  expect(screen.getByLabelText("主世界书")).toHaveValue("图志");
  fireEvent.change(screen.getByLabelText("名称"), { target: { value: "新名字" } });
  fireEvent.change(screen.getByLabelText("人物设定"), { target: { value: "改过的设定。" } });
  fireEvent.change(screen.getByLabelText("主世界书"), { target: { value: "星图" } });
  fireEvent.click(screen.getByRole("button", { name: "保存角色" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  const put = calls.find(({ url, init }) => url === `/api/characters/${detail.id}` && init?.method === "PUT")!;
  const body = JSON.parse(String(put.init!.body));
  expect(body.card.spec).toBe("chara_card_v2");
  expect(body.card.data).toMatchObject({ name: "新名字", description: "改过的设定。", alternate_greetings: ["另一句问候"] });
  // 未编辑的扩展键随卡往返保留；主世界书改绑星图。
  expect(body.card.data.extensions).toEqual({ custom_flag: { keep: true }, world: "星图",
    depth_prompt: { prompt: "", depth: 4, role: 0 } });
  expect(onSaved.mock.calls[0]![0].name).toBe("新名字");
  await screen.findByText("角色已保存。");
});

it("shows card save errors inline and never issues the write for an empty name", async () => {
  const { calls } = stubFetch(body => response({ error: { code: "INVALID_CHARACTER_CARD", message: "卡校验失败", details: ["data.name 不能为空"] } }, 422));
  render(<CharacterPanel open online character={detail} onSaved={() => {}} onClose={() => {}} />);
  await waitFor(() => expect(screen.getByLabelText("名称")).toHaveValue("阿斯特"));
  fireEvent.change(screen.getByLabelText("名称"), { target: { value: " " } });
  fireEvent.click(screen.getByRole("button", { name: "保存角色" }));
  await screen.findByText("角色名称不能为空。");
  expect(calls.some(({ init }) => init?.method === "PUT")).toBe(false);
  fireEvent.change(screen.getByLabelText("名称"), { target: { value: "阿斯特" } });
  fireEvent.click(screen.getByRole("button", { name: "保存角色" }));
  await screen.findByText(/卡校验失败；data\.name 不能为空/);
});

it("asks for a character when none is selected", () => {
  render(<CharacterPanel open online character={null} onSaved={() => {}} onClose={() => {}} />);
  expect(screen.getByText("请先在角色库选择角色。")).toBeInTheDocument();
});
