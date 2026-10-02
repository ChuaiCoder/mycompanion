import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsView, type SettingsViewProps } from "./SettingsView";
import i18n from "../i18n";
vi.mock("./PresetSettings", () => ({ PresetSettings: () => <p>Preset editor</p> }));
vi.mock("./BackupPanel", () => ({ BackupPanel: () => <p>Backup editor</p> }));
afterEach(async () => { cleanup(); vi.clearAllMocks(); await i18n.changeLanguage("zh"); });
const props = (): SettingsViewProps => ({ provider: { kind: "ollama", baseUrl: "http://localhost:11434/v1", model: "fixture", hasApiKey: false, temperature: 0.8, maxTokens: 1024, contextLimitTokens: 32768 }, apiKeyDraft: "", isSavingProvider: false, runtimeError: null, providerNotice: null, onProviderField: vi.fn(), onApiKeyDraft: vi.fn(), onSave: vi.fn(), onSaveAndTest: vi.fn(), onContinue: vi.fn(), selectedCharacterName: "旅人" });
it("starts with folded advanced settings and offers a tested-model-to-story next step", () => {
  const value = props(); render(<SettingsView {...value} isConnectionReady />);
  expect(screen.getByRole("spinbutton", { name: "Temperature", hidden: true })).not.toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "测试成功后保存" })); expect(value.onSaveAndTest).toHaveBeenCalledOnce(); expect(value.onSave).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "第 3 步：开始对话" })); expect(value.onContinue).toHaveBeenCalledOnce();
});
it("keeps model errors in the same task and moves focus to the field that can correct them", () => {
  render(<SettingsView {...props()} runtimeError="Model missing" providerIssue={{ code: "MODEL_NOT_FOUND", field: "model", suggestion: "Choose an installed model", retryable: false }} />);
  expect(screen.getByText("Choose an installed model")).toBeVisible(); fireEvent.click(screen.getByRole("button", { name: "修改模型" })); expect(screen.getByRole("textbox", { name: "模型名称" })).toHaveFocus();
});
it("renders real English connection instructions and accessible labels when the language changes", async () => {
  render(<SettingsView {...props()} />);
  await act(async () => { await i18n.changeLanguage("en"); });
  expect(screen.getByRole("heading", { name: "Let your character reply" })).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Service address" })).toHaveValue("http://localhost:11434/v1");
  expect(screen.getByRole("button", { name: "Test, then save" })).toBeVisible();
  expect(document.documentElement.lang).toBe("en");
});
