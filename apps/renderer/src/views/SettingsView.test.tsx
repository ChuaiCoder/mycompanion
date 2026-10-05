import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsView, type SettingsViewProps } from "./SettingsView";
import i18n from "../i18n";
vi.mock("./PresetSettings", () => ({ PresetSettings: () => <p>Preset editor</p> }));
vi.mock("./BackupPanel", () => ({ BackupPanel: () => <p>Backup editor</p> }));
afterEach(async () => { cleanup(); vi.clearAllMocks(); await i18n.changeLanguage("zh"); });
const props = (overrides: Partial<SettingsViewProps> = {}): SettingsViewProps => ({ provider: { kind: "ollama", baseUrl: "http://localhost:11434/v1", model: "fixture", hasApiKey: false, temperature: 0.8, maxTokens: 1024, contextLimitTokens: 32768 }, apiKeyDraft: "", isSavingProvider: false, runtimeError: null, providerNotice: null, onProviderField: vi.fn(), onApiKeyDraft: vi.fn(), onSave: vi.fn(async () => true), onSaveAndTest: vi.fn(async () => true), onContinue: vi.fn(), selectedCharacterName: "旅人", ...overrides });
it("starts with folded advanced settings and offers a tested-model-to-story next step", async () => {
  const value = props(); render(<SettingsView {...value} isConnectionReady />);
  expect(screen.getByRole("spinbutton", { name: "Temperature", hidden: true })).not.toBeVisible();
  // 保存是异步的：必须等它真正成功，才会放行「下一步」。
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "测试成功后保存" })); });
  expect(value.onSaveAndTest).toHaveBeenCalledOnce(); expect(value.onSave).not.toHaveBeenCalled();
  const next = await screen.findByRole("button", { name: "第 3 步：开始对话" });
  fireEvent.click(next); expect(value.onContinue).toHaveBeenCalledOnce();
});

it("does not mark saved when the save handler swallows the failure and resolves", async () => {
  // 真实情况：useProviderSettings 内部 try/catch 吞掉异常后**正常 resolve**，
  // 所以"await 保存"并不足以判断成功——调用方必须能拿到明确的成败信号。
  // 这里用一个模拟"吞掉失败后正常返回"的处理器，确认界面不会误标已保存。
  const swallowing = vi.fn(async () => { /* 失败但静默 resolve */ });
  render(<SettingsView {...props({ onSaveAndTest: swallowing })} isConnectionReady />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "测试成功后保存" })); });
  expect(swallowing).toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "第 3 步：开始对话" })).toBeNull();
});
it("revokes the saved state when the API key is edited after a successful save", async () => {
  // 改密钥也是改配置：旧密钥的验证结果与"已保存"都不能继续代表眼前的配置。
  // 以前密钥走的是 onApiKeyDraft，不经过 changeField，两个失效计数器都不动，
  // 于是保存成功后再改密钥，「下一步」仍然可用 → 带着未保存的新密钥进聊天。
  const onApiKeyDraft = vi.fn();
  render(<SettingsView {...props({ onApiKeyDraft })} isConnectionReady />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "测试成功后保存" })); });
  expect(await screen.findByRole("button", { name: "第 3 步：开始对话" })).toBeVisible();

  fireEvent.change(document.getElementById("provider-api-key") as HTMLInputElement, { target: { value: "sk-new-key" } });
  expect(onApiKeyDraft).toHaveBeenCalledWith("sk-new-key");
  // 关键：新密钥还没保存，不能再提供"开始对话"。
  expect(screen.queryByRole("button", { name: "第 3 步：开始对话" })).toBeNull();
});

it("does not mark saved when the key changes while the save is still in flight", async () => {
  // 在途保存用的是旧密钥：回来时不能把结果算到新密钥头上。
  let releaseSave: (() => void) | undefined;
  const pending = new Promise<boolean>(resolve => { releaseSave = () => resolve(true); });
  render(<SettingsView {...props({ onSaveAndTest: () => pending })} isConnectionReady />);
  fireEvent.click(screen.getByRole("button", { name: "测试成功后保存" }));

  // 保存还没回来就改了密钥。
  fireEvent.change(document.getElementById("provider-api-key") as HTMLInputElement, { target: { value: "sk-changed" } });
  await act(async () => { releaseSave?.(); await Promise.resolve(); });

  // 旧密钥的"成功"不能放行新配置。
  expect(screen.queryByRole("button", { name: "第 3 步：开始对话" })).toBeNull();
});

it("keeps model errors in the same task and moves focus to the field that can correct them", () => {
  render(<SettingsView {...props()} runtimeError="Model missing" providerIssue={{ code: "MODEL_NOT_FOUND", field: "model", suggestion: "Choose an installed model", retryable: false }} />);
  // 未获取模型列表时模型字段是输入框；修正按钮必须把焦点移到它上面。
  expect(screen.getByText("Choose an installed model")).toBeVisible(); fireEvent.click(screen.getByRole("button", { name: "修改模型" })); expect(document.getElementById("provider-model")).toHaveFocus();
});
it("renders real English connection instructions and accessible labels when the language changes", async () => {
  render(<SettingsView {...props()} />);
  await act(async () => { await i18n.changeLanguage("en"); });
  expect(screen.getByRole("heading", { name: "Let your character reply" })).toBeVisible();
  // 本机 Ollama 的地址可能是 localhost / 127.0.0.1 / 自定义端口，因此仍可编辑。
  expect(screen.getByRole("textbox", { name: "Service address" })).toHaveValue("http://localhost:11434/v1");
  expect(screen.getByRole("button", { name: "Test, then save" })).toBeVisible();
  expect(document.documentElement.lang).toBe("en");
});
