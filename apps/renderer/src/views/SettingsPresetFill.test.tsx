import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderSettings } from "@mycompanion/shared";
import i18n from "../i18n";
import { SettingsView } from "./SettingsView";

// 真机复现：选中服务商后地址/模型却是空的。这里用一个受控的父组件模拟真实 App，
// 验证"选了预设之后输入框里真的有值"。

vi.mock("./PresetSettings", () => ({ PresetSettings: () => <p>p</p> }));
vi.mock("./BackupPanel", () => ({ BackupPanel: () => <p>b</p> }));
afterEach(async () => { cleanup(); await i18n.changeLanguage("zh"); });

function Harness() {
  const [provider, setProvider] = useState<ProviderSettings>({
    kind: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini",
    hasApiKey: true, temperature: 0.8, maxTokens: 1024, contextLimitTokens: 32768,
  });
  return <SettingsView
    provider={provider} apiKeyDraft="" isSavingProvider={false} runtimeError={null} providerNotice={null}
    onProviderField={(patch) => setProvider(current => ({ ...current, ...patch }))}
    onApiKeyDraft={vi.fn()} onSave={vi.fn()} onSaveAndTest={vi.fn()}
  />;
}

it("hides the editable address and protocol for a preset provider", () => {
  render(<Harness />);
  fireEvent.change(screen.getByRole("combobox", { name: "模型来源" }), { target: { value: "deepseek" } });
  // 预设服务商不再暴露地址与协议（也不额外显示端点说明，由下拉里的服务商名表达）。
  expect(document.getElementById("provider-base-url")).toBeNull();
  expect(screen.queryByRole("combobox", { name: "接口协议" })).toBeNull();
  // 模型名仍可编辑。
  expect((document.getElementById("provider-model") as HTMLInputElement).value).toBe("deepseek-flash");
});

it("asks for a key when the chosen provider needs one, and not for local Ollama", () => {
  render(<Harness />);
  // DeepSeek 必须有密钥：占位提示不能还写着"本地 Ollama 可以留空"。
  fireEvent.change(screen.getByRole("combobox", { name: "模型来源" }), { target: { value: "deepseek" } });
  const key = () => document.getElementById("provider-api-key") as HTMLInputElement;
  expect(key().placeholder).toContain("API Key");
  expect(key().placeholder).not.toContain("留空");
  fireEvent.change(screen.getByRole("combobox", { name: "模型来源" }), { target: { value: "ollama" } });
  expect(key().placeholder).toContain("留空");
});

it("shows the editable address and protocol again for a custom provider", () => {
  render(<Harness />);
  fireEvent.change(screen.getByRole("combobox", { name: "模型来源" }), { target: { value: "custom-anthropic" } });
  // 自定义必须能填，且地址留空由用户提供。
  const address = document.getElementById("provider-base-url") as HTMLInputElement;
  expect(address).not.toBeNull();
  expect(address.value).toBe("");
  expect((screen.getByRole("combobox", { name: "接口协议" }) as HTMLSelectElement).value).toBe("anthropic");
});

it("does not silently revoke readiness when a later edit happens", () => {
  // 真机顺序问题：拉取模型时若自动补了模型名，那次 onProviderField 会把
  // isConnectionReady 重置掉，于是刚拿到模型列表、"下一步"就消失了。
  const onConnectionReady = vi.fn();
  const onProviderField = vi.fn();
  render(<SettingsView
    provider={{ kind: "openai-compatible", baseUrl: "https://api.deepseek.com", model: "deepseek-flash", hasApiKey: true, temperature: 0.8, maxTokens: 1024, contextLimitTokens: 32768 }}
    apiKeyDraft="" isSavingProvider={false} runtimeError={null} providerNotice={null}
    onProviderField={onProviderField} onApiKeyDraft={vi.fn()} onSave={vi.fn()} onSaveAndTest={vi.fn()}
    isConnectionReady onConnectionReady={onConnectionReady} onContinue={vi.fn()}
  />);
  // 就绪状态由 props 决定；组件自身不能因为"用户改了某个字段"就把它撤销。
  expect(onConnectionReady).not.toHaveBeenCalled();
  fireEvent.change(document.getElementById("provider-model") as HTMLInputElement, { target: { value: "deepseek-v4-pro" } });
  expect(onProviderField).toHaveBeenCalledWith({ model: "deepseek-v4-pro" });
  // 编辑本身不应触发"连接已失效"这类反向副作用。
  expect(onConnectionReady).not.toHaveBeenCalled();
});

it("does not offer to continue after fetching models, because nothing was saved yet", async () => {
  // 「获取模型」只证明地址与密钥可用，并没有写库。以前它直接放行「下一步」，
  // 用户会带着未保存的配置进聊天、实际仍用旧设置。
  const listProviderModels = vi.spyOn(await import("../api"), "listProviderModels")
    .mockResolvedValue({ ok: true, models: ["fresh-model"], message: "读取到 1 个模型。" });
  const onContinue = vi.fn();
  const onSaveAndTest = vi.fn(async () => true);

  const emptyModel: ProviderSettings = {
    kind: "openai-compatible", baseUrl: "https://x.test/v1", model: "",
    hasApiKey: true, temperature: 0.8, maxTokens: 1024, contextLimitTokens: 32768,
  };
  function Parent() {
    const [provider, setProvider] = useState(emptyModel);
    const [ready, setReady] = useState(false);
    return <SettingsView
      provider={provider} apiKeyDraft="" isSavingProvider={false} runtimeError={null} providerNotice={null}
      onProviderField={(patch) => { setReady(false); setProvider(current => ({ ...current, ...patch })); }}
      onApiKeyDraft={vi.fn()} onSave={vi.fn()} onSaveAndTest={onSaveAndTest}
      isConnectionReady={ready} onConnectionReady={() => setReady(true)} onContinue={onContinue}
    />;
  }

  render(<Parent />);
  fireEvent.click(screen.getByRole("button", { name: "测试获取模型" }));
  const select = await screen.findByRole("combobox", { name: "模型名称" });
  await waitFor(() => expect((select as HTMLSelectElement).value).toBe("fresh-model"));
  // 模型已就绪，但还没保存 → 不能出现「下一步」。
  expect(screen.queryByRole("button", { name: "返回角色库" })).toBeNull();

  // 真正保存之后才放行，并且点了确实会走 onContinue。
  fireEvent.click(screen.getByRole("button", { name: "测试成功后保存" }));
  expect(onSaveAndTest).toHaveBeenCalled();
  const next = await screen.findByRole("button", { name: "返回角色库" });
  fireEvent.click(next);
  expect(onContinue).toHaveBeenCalled();
  listProviderModels.mockRestore();
});

it("revokes the continue offer again when a field is edited after saving", async () => {
  // 保存后改了配置就不能再直接进聊天（改的还没写库）。
  const onContinue = vi.fn();
  const settings: ProviderSettings = {
    kind: "openai-compatible", baseUrl: "https://x.test/v1", model: "m",
    hasApiKey: true, temperature: 0.8, maxTokens: 1024, contextLimitTokens: 32768,
  };
  function Parent() {
    const [provider, setProvider] = useState(settings);
    return <SettingsView
      provider={provider} apiKeyDraft="" isSavingProvider={false} runtimeError={null} providerNotice={null}
      onProviderField={(patch) => setProvider(current => ({ ...current, ...patch }))}
      onApiKeyDraft={vi.fn()} onSave={vi.fn()} onSaveAndTest={vi.fn(async () => true)}
      isConnectionReady onContinue={onContinue}
    />;
  }
  render(<Parent />);
  fireEvent.click(screen.getByRole("button", { name: "测试成功后保存" }));
  expect(await screen.findByRole("button", { name: "返回角色库" })).toBeVisible();
  fireEvent.change(document.getElementById("provider-model") as HTMLInputElement, { target: { value: "m2" } });
  expect(screen.queryByRole("button", { name: "返回角色库" })).toBeNull();
});
