import { createRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { characterCardPreviewResponseSchema, characterDetailSchema, type CharacterDetail } from "@mycompanion/shared";
import i18n from "../i18n";
import { App } from "../App";
import { useCharacterImport } from "../hooks/useCharacterImport";
import { LibraryView, type LibraryViewProps } from "./LibraryView";

const id = "00000000-0000-4000-8000-000000000001", updatedAt = "2026-10-03T00:00:00.000Z";
const preview = characterCardPreviewResponseSchema.parse({
  format: "ccv2-json", specVersion: "2.0", name: "角色库", descriptionPreview: "用户人物设定", firstMessagePreview: "<p>角色原文 1000</p>",
  creator: "作者原文", characterVersion: "1", tags: ["标签原文"], alternateGreetingsCount: 1000, groupOnlyGreetingsCount: 0,
  lorebookEntryCount: 1, regexScriptCount: 1, assetCount: 0, importedAssetCount: 1000, importedScenarioCount: 2,
  lorebookEntries: [{ index: 0, name: "世界书", keys: ["关键词原文"], secondaryKeys: [], contentPreview: "场景原文", sourceEnabled: true,
    constant: false, selective: false, useRegex: false, insertionOrder: 1000, runtimeState: "stored_inactive" }],
  regexScripts: [{ index: 0, name: "正则规则", findRegexPreview: "/中文原文/g", replaceStringPreview: "替换原文", placements: ["user_input"],
    sourceDisabled: false, markdownOnly: false, promptOnly: false, runOnEdit: true, minDepth: null, maxDepth: null, runtimeState: "stored_disabled" }],
  extensionKeys: ["future"], unknownFieldPaths: ["data.extensions.未知路径"], compatibilityDefaultPaths: ["data.scenario"], warningCodes: ["extensions_present"],
});
const character = characterDetailSchema.parse({
  id, name: preview.name, description: preview.descriptionPreview, personality: "性格", scenario: "场景", firstMessage: preview.firstMessagePreview,
  alternateGreetings: [], alternateGreetingsCount: 1000, exampleDialogue: "", systemPrompt: "", postHistoryInstructions: "", creatorNotes: "",
  tags: ["世界书"], creator: "作者", characterVersion: "1", sourceFormat: "ccv2-json", sourceVersion: "2.0", rawExtensions: {}, unknownFieldPaths: [],
  regexEnabled: [], lorebookEnabled: [], lorebookEntryCount: 1, regexScriptCount: 1, lorebookEntries: preview.lorebookEntries, regexScripts: preview.regexScripts,
  deletedAt: null, createdAt: updatedAt, updatedAt,
});
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
function props(overrides: Partial<LibraryViewProps> = {}): LibraryViewProps {
  return { preview: null, selectedCharacter: null, draftFileName: null, characters: [], listError: null, importError: null, importErrorDetails: [], successMessage: null,
    isImporting: false, isSaving: false, isLoadingCharacter: false, regexPanelOpen: false, lorebookPanelOpen: false, previewHeadingRef: createRef(),
    onOpenFilePicker: vi.fn(), onSelectCharacter: vi.fn(), onEditCharacter: vi.fn(), onStartConversation: vi.fn(), onCommit: vi.fn(), onCancelImport: vi.fn(),
    onRegexPanelToggle: vi.fn(), onLorebookPanelToggle: vi.fn(), onOpenSettings: vi.fn(), ...overrides };
}
function ImportHarness() {
  const [saved, setSaved] = useState<CharacterDetail | null>(null);
  const flow = useCharacterImport({ onCommitted: setSaved });
  return <><input aria-label="Test card files" type="file" multiple ref={flow.fileInputRef} onChange={event => void flow.handleCardFile(event)} />
    <LibraryView {...props()} preview={flow.preview} selectedCharacter={saved} draftFileName={flow.draftFile?.name ?? null}
      importError={flow.importError} importErrorDetails={flow.importErrorDetails} successMessage={flow.successMessage}
      isImporting={flow.isImporting} isSaving={flow.isSaving} batchItems={flow.batchItems} previewHeadingRef={flow.previewHeadingRef}
      onOpenFilePicker={flow.openFilePicker} onCommit={() => void flow.handleCommit()} onCancelImport={flow.clearImportState}
      onSkipFile={() => void flow.handleSkipFile()} onRetryFile={id => void flow.handleRetryFile(id)}
      onOpenDuplicate={id => void flow.handleOpenDuplicate(id)} onReplaceDuplicate={(id, version) => void flow.handleCommit("replace", id, version)}
      onRefreshPreview={() => void flow.handleRefreshPreview()} /></>;
}
function cardFile(name = "卡片原文件.json") {
  return new File([JSON.stringify({ spec: "chara_card_v2", data: { name: "角色库", description: "世界书" } })], name, { type: "application/json" });
}
beforeEach(async () => { await i18n.changeLanguage("zh"); });
afterEach(async () => { cleanup(); await i18n.changeLanguage("zh"); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("keeps the three-step route and character content while English actions invoke the original callbacks", async () => {
  const base = props(); render(<LibraryView {...base} />);
  expect(screen.getByRole("heading", { name: "只需要三步" })).toBeInTheDocument();
  await act(() => i18n.changeLanguage("en"));
  expect(screen.getByRole("heading", { name: "Three simple steps" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Choose a character card/ })); expect(base.onOpenFilePicker).toHaveBeenCalledOnce();
  cleanup(); const selected = props({ selectedCharacter: character }); render(<LibraryView {...selected} />);
  expect(screen.getByRole("heading", { name: "角色库" })).toBeInTheDocument();
  expect(screen.getByText("用户人物设定")).toBeInTheDocument(); expect(screen.getByText("性格")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Step 2: Connect a model" })); expect(selected.onOpenSettings).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Start chatting" })); expect(selected.onStartConversation).toHaveBeenCalledOnce();
  expect(screen.getByRole("link", { name: "Export CHARX" })).toHaveAttribute("href", `/api/characters/${id}/export?format=charx`);
  cleanup(); vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline"))); render(<App />);
  await screen.findByText("Service unavailable");
  const input = screen.getByLabelText("Choose character card files"), click = vi.spyOn(input, "click").mockImplementation(() => {});
  // 默认落地为对话页，导入入口在侧边导航。
  fireEvent.click(screen.getByRole("button", { name: /Import character/ })); expect(click).toHaveBeenCalledOnce();
  await act(() => i18n.changeLanguage("zh"));
  expect(screen.getByLabelText("选择角色卡文件")).toBe(input); expect(click).toHaveBeenCalledOnce();
});

it("preserves the actual chosen file and duplicate version across language changes before an explicit replacement", async () => {
  const duplicate = { ...preview, duplicates: [{ id, name: "既有角色原名", updatedAt, match: "exact" }] };
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => response(url.includes("/commit") ? character : duplicate)); vi.stubGlobal("fetch", fetch);
  render(<ImportHarness />); const file = cardFile(); fireEvent.change(screen.getByLabelText("Test card files"), { target: { files: [file] } });
  await screen.findByRole("button", { name: "用当前卡片替换" });
  await act(() => i18n.changeLanguage("en"));
  expect(screen.getByRole("button", { name: "Import separate copy" })).toBeEnabled();
  expect(screen.getByText("卡片原文件.json")).toBeInTheDocument(); expect(screen.getByText("既有角色原名")).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(() => i18n.changeLanguage("zh")); await act(() => i18n.changeLanguage("en")); expect(fetch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Replace with this card" }));
  await screen.findByText("“角色库” is saved and available in your character list.");
  const [url, init] = fetch.mock.calls.find(([url]) => url.includes("/commit"))!;
  const actual = new URL(url, "http://fixture.test");
  expect(actual.searchParams.get("mode")).toBe("replace"); expect(actual.searchParams.get("targetId")).toBe(id);
  expect(actual.searchParams.get("expectedUpdatedAt")).toBe(updatedAt);
  expect(JSON.parse(String(init?.body))).toEqual({ filename: file.name, card: { spec: "chara_card_v2", data: { name: "角色库", description: "世界书" } } });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each(["copy", "open"])("uses the existing %s API path from the English import controls", async action => {
  await i18n.changeLanguage("en");
  const currentPreview = action === "open" ? { ...preview, duplicates: [{ id, name: "已有用户角色", updatedAt, match: "same-name" }] } : preview;
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => response(url.endsWith("/preview") ? currentPreview : character));
  vi.stubGlobal("fetch", fetch); render(<ImportHarness />); const file = cardFile();
  fireEvent.change(screen.getByLabelText("Test card files"), { target: { files: [file] } });
  fireEvent.click(await screen.findByRole("button", { name: action === "open" ? "Open existing character" : "Confirm import" }));
  await screen.findByText(action === "open" ? "Opened existing character “角色库”." : "“角色库” is saved and available in your character list.");
  expect(fetch).toHaveBeenCalledTimes(2);
  const [url, init] = fetch.mock.calls[1]!;
  expect(url).toBe(action === "open" ? `/api/characters/${id}` : "/api/characters/import/commit");
  if (action === "open") expect(init?.method).toBeUndefined();
  else {
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ filename: file.name, card: { spec: "chara_card_v2", data: { name: "角色库", description: "世界书" } } });
  }
});

it("retries a failed batch file through the real import hook, then cancels without committing", async () => {
  let fail = true; const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    expect(url).toContain("/preview");
    return fail ? response({ error: { code: "IMPORT_PREVIEW_FAILED", message: "角色卡预览失败，请重试这个文件。", details: ["未知服务详情 1000"] } }, 422) : response(preview);
  }); vi.stubGlobal("fetch", fetch); render(<ImportHarness />);
  fireEvent.change(screen.getByLabelText("Test card files"), { target: { files: [cardFile("失败一.json"), cardFile("失败二.json")] } });
  await waitFor(() => expect(screen.getAllByRole("button", { name: "重试此文件" })).toHaveLength(2));
  await act(() => i18n.changeLanguage("en"));
  expect(screen.getByRole("region", { name: "Batch import results" })).toHaveTextContent("Failed");
  expect(screen.getAllByText("Could not preview this character card. Retry this file.")).toHaveLength(3);
  expect(screen.getByText("未知服务详情 1000")).toBeInTheDocument(); expect(fetch).toHaveBeenCalledTimes(2);
  fail = false; fireEvent.click(screen.getAllByRole("button", { name: "Retry this file" })[0]!);
  await screen.findByRole("button", { name: "Confirm import" });
  expect(screen.getByRole("button", { name: "Skip this file" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel batch" }));
  expect(screen.queryByRole("button", { name: "Confirm import" })).not.toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("localizes asset counts and preview disclosures while preserving expanded state, HTML and imported names", async () => {
  const longDescription = "角色用户原文".repeat(60), data = { ...preview, descriptionPreview: longDescription };
  const base = props({ preview: data, draftFileName: "原文件 1000.charx" }); render(<LibraryView {...base} />);
  const disclosure = screen.getByText("展开完整简介").closest("details")!; disclosure.open = true;
  await act(() => i18n.changeLanguage("en"));
  expect(disclosure.open).toBe(true); expect(screen.getByText("Read the full description").closest("details")).toBe(disclosure);
  expect(screen.getByText(longDescription)).toBeInTheDocument(); expect(screen.getByText("原文件 1000.charx")).toBeInTheDocument();
  expect(screen.getByLabelText("HTML greeting source")).toHaveTextContent("<p>角色原文 1000</p>");
  expect(screen.getByText(/1,000 files recognized/)).toBeInTheDocument();
  expect(screen.getByText("Alternate greetings").closest(".metric")).toHaveTextContent("1,000");
  expect(screen.getByText("This card includes extension data. Review it before confirming the import.")).toBeInTheDocument();
  const extras = screen.getByRole("region", { name: "Character card extras" });
  expect(within(extras).getByText("关键词原文")).toBeInTheDocument(); expect(within(extras).getByText("User input")).toBeInTheDocument();
  expect(within(extras).getByText("/中文原文/g")).toBeInTheDocument(); expect(within(extras).getByText("世界书")).toBeInTheDocument();
  expect(base.onCommit).not.toHaveBeenCalled(); expect(base.onReplaceDuplicate).toBeUndefined();
  await act(() => i18n.changeLanguage("zh"));
  expect(screen.getByRole("button", { name: "确认导入" })).toBeInTheDocument(); expect(disclosure.open).toBe(true);
});
