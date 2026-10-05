import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { SettingsView, type SettingsViewProps } from "./SettingsView";
import { PROVIDER_PRESETS, findPreset } from "./provider-presets";
import * as api from "../api";

// 模型来源预设 + 「测试获取模型」。
// 关键点：预设只是数据，协议仍由 kind 决定；加服务商不需要动 schema。

vi.mock("./PresetSettings", () => ({ PresetSettings: () => <p>Preset editor</p> }));
vi.mock("./BackupPanel", () => ({ BackupPanel: () => <p>Backup editor</p> }));

afterEach(async () => { cleanup(); vi.restoreAllMocks(); await i18n.changeLanguage("zh"); });

const props = (overrides: Partial<SettingsViewProps> = {}): SettingsViewProps => ({
  provider: { kind: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", hasApiKey: true, temperature: 0.8, maxTokens: 1024, contextLimitTokens: 32768 },
  apiKeyDraft: "", isSavingProvider: false, runtimeError: null, providerNotice: null,
  onProviderField: vi.fn(), onApiKeyDraft: vi.fn(), onSave: vi.fn(), onSaveAndTest: vi.fn(), onContinue: vi.fn(),
  ...overrides,
});

it("offers DeepSeek, OpenAI, Anthropic, Gemini, local Ollama and two custom protocols", () => {
  render(<SettingsView {...props()} />);
  const source = screen.getByRole("combobox", { name: "模型来源" });
  const options = within(source).getAllByRole("option").map(node => node.textContent);
  expect(options).toEqual([
    "DeepSeek", "OpenAI", "Anthropic（Claude）", "Google Gemini", "本机 Ollama",
    "自定义（OpenAI 兼容）", "自定义（Anthropic 兼容）",
  ]);
});

it("fills the official address, model and protocol when a provider is chosen", () => {
  const onProviderField = vi.fn();
  render(<SettingsView {...props({ onProviderField })} />);
  fireEvent.change(screen.getByRole("combobox", { name: "模型来源" }), { target: { value: "deepseek" } });

  // 地址与默认模型来自官方文档，用户不必自己查；协议单独跟着预设走。
  expect(onProviderField).toHaveBeenCalledWith({ kind: "openai-compatible", baseUrl: "https://api.deepseek.com", model: "deepseek-flash" });
});

it("leaves the address empty for the custom protocols so the user fills their own", () => {
  const onProviderField = vi.fn();
  render(<SettingsView {...props({ onProviderField })} />);
  fireEvent.change(screen.getByRole("combobox", { name: "模型来源" }), { target: { value: "custom-anthropic" } });
  expect(onProviderField).toHaveBeenCalledWith({ kind: "anthropic", baseUrl: "", model: "" });
});

it("turns the fetched models into a real dropdown the user can pick from", async () => {
  const spy = vi.spyOn(api, "listProviderModels").mockResolvedValue({ ok: true, models: ["deepseek-flash", "deepseek-v4-pro"], message: "读取到 2 个模型。" });
  const onConnectionReady = vi.fn();
  const onProviderField = vi.fn();
  render(<SettingsView {...props({ onConnectionReady, onProviderField })} />);

  fireEvent.click(screen.getByRole("button", { name: "测试获取模型" }));
  const select = await screen.findByRole("combobox", { name: "模型名称" });

  // 两个模型都必须在同一个下拉里可选中（原生 datalist 做不到这点）。
  const options = within(select).getAllByRole("option").map(node => (node as HTMLOptionElement).value);
  expect(options).toEqual(["gpt-4o-mini", "deepseek-flash", "deepseek-v4-pro"]);
  fireEvent.change(select, { target: { value: "deepseek-v4-pro" } });
  expect(onProviderField).toHaveBeenCalledWith({ model: "deepseek-v4-pro" });
  // 拿到列表就证明密钥与地址可用，放行下一步。
  expect(onConnectionReady).toHaveBeenCalled();
  expect(spy).toHaveBeenCalledWith(expect.objectContaining({ kind: "openai-compatible", baseUrl: "https://api.openai.com/v1" }));
});

it("keeps the current model selectable when the provider does not list it", async () => {
  // 手填过或服务商改了列表：不能把当前模型静默丢掉。
  vi.spyOn(api, "listProviderModels").mockResolvedValue({ ok: true, models: ["other-model"], message: "读取到 1 个模型。" });
  render(<SettingsView {...props()} />);
  fireEvent.click(screen.getByRole("button", { name: "测试获取模型" }));
  const select = await screen.findByRole("combobox", { name: "模型名称" });
  const values = within(select).getAllByRole("option").map(node => (node as HTMLOptionElement).value);
  expect(values).toContain("gpt-4o-mini");
  expect(values).toContain("other-model");
});

it("passes the typed key to the fetch so it can be tested before saving", async () => {
  const spy = vi.spyOn(api, "listProviderModels").mockResolvedValue({ ok: true, models: [], message: "连接成功，但服务没有返回模型列表，请手动填写模型名。" });
  render(<SettingsView {...props({ apiKeyDraft: "sk-draft" })} />);
  fireEvent.click(screen.getByRole("button", { name: "测试获取模型" }));
  await waitFor(() => expect(spy).toHaveBeenCalled());
  expect(spy.mock.calls[0]![0]).toMatchObject({ apiKey: "sk-draft" });
});

it("reports a rejected key instead of pretending the models arrived", async () => {
  vi.spyOn(api, "listProviderModels").mockResolvedValue({ ok: false, models: [], message: "密钥被拒绝，请检查 API Key 是否正确、是否已启用。" });
  const onConnectionReady = vi.fn();
  render(<SettingsView {...props({ onConnectionReady })} />);

  fireEvent.click(screen.getByRole("button", { name: "测试获取模型" }));
  expect(await screen.findByText(/密钥被拒绝/)).toBeInTheDocument();
  expect(onConnectionReady).not.toHaveBeenCalled();
  // 失败时仍是输入框，没有"可选模型"的假象。
  expect(screen.queryByRole("combobox", { name: "模型名称" })).toBeNull();
  expect(document.getElementById("provider-model")).not.toBeNull();
});

it("forwards the request failure as a message instead of throwing", async () => {
  vi.spyOn(api, "listProviderModels").mockRejectedValue(new Error("网络不可用"));
  render(<SettingsView {...props()} />);
  fireEvent.click(screen.getByRole("button", { name: "测试获取模型" }));
  expect(await screen.findByText("网络不可用")).toBeInTheDocument();
});

it("auto-selects a model when the field is empty but the provider returned some", async () => {
  vi.spyOn(api, "listProviderModels").mockResolvedValue({ ok: true, models: ["first-model"], message: "读取到 1 个模型。" });
  const onProviderField = vi.fn();
  render(<SettingsView {...props({ provider: { kind: "openai-compatible", baseUrl: "https://x.test/v1", model: "", hasApiKey: true, temperature: 0.8, maxTokens: 1024, contextLimitTokens: 32768 }, onProviderField })} />);
  fireEvent.click(screen.getByRole("button", { name: "测试获取模型" }));
  await waitFor(() => expect(onProviderField).toHaveBeenCalledWith({ model: "first-model" }));
});

it("offers a placeholder option while no model is chosen yet", async () => {
  vi.spyOn(api, "listProviderModels").mockResolvedValue({ ok: true, models: ["first-model"], message: "读取到 1 个模型。" });
  render(<SettingsView {...props({ provider: { kind: "openai-compatible", baseUrl: "https://x.test/v1", model: "", hasApiKey: true, temperature: 0.8, maxTokens: 1024, contextLimitTokens: 32768 } })} />);
  fireEvent.click(screen.getByRole("button", { name: "测试获取模型" }));
  const select = await screen.findByRole("combobox", { name: "模型名称" });
  expect(within(select).getAllByRole("option").map(node => (node as HTMLOptionElement).value)).toEqual(["", "first-model"]);
});

it("infers the selected provider back from saved settings", () => {
  expect(findPreset({ kind: "openai-compatible", baseUrl: "https://api.deepseek.com" }).id).toBe("deepseek");
  expect(findPreset({ kind: "anthropic", baseUrl: "https://api.anthropic.com/v1" }).id).toBe("anthropic");
  expect(findPreset({ kind: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta" }).id).toBe("gemini");
  expect(findPreset({ kind: "ollama", baseUrl: "http://127.0.0.1:11434/v1" }).id).toBe("ollama");
  // 不认识的地址按协议落到自定义，用户仍能编辑。
  expect(findPreset({ kind: "openai-compatible", baseUrl: "https://unknown.example/v1" }).id).toBe("custom-openai");
  expect(findPreset({ kind: "anthropic", baseUrl: "https://unknown.example" }).id).toBe("custom-anthropic");
});

it("keeps every preset on a protocol the backend actually implements", () => {
  const kinds = new Set(["openai-compatible", "ollama", "anthropic", "gemini"]);
  for (const preset of PROVIDER_PRESETS) expect(kinds.has(preset.kind)).toBe(true);
  // 预设地址必须是 http(s)，否则用户点保存才报错。
  for (const preset of PROVIDER_PRESETS) {
    if (preset.baseUrl) expect(preset.baseUrl.startsWith("https://") || preset.baseUrl.startsWith("http://")).toBe(true);
  }
});
