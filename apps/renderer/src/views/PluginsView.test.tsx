import { useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InstalledPlugin } from "@mycompanion/shared";
import i18n from "../i18n";
import { listPlugins } from "../api";
import { usePlugins } from "../hooks/usePlugins";
import { PluginsView, type PluginsViewProps } from "./PluginsView";

const plugin: InstalledPlugin = { schemaVersion: 1, id: "prompt-pack", name: "提示词包", version: "1.2", description: "用户正文", author: "",
  license: "MIT", permissions: ["command:register"], contributes: { commands: [{ name: "recap", description: "摘要", prompt: "总结故事" }] },
  enabled: true, installedAt: "2026-10-03T00:00:00.000Z" };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
function props(overrides: Partial<PluginsViewProps> = {}): PluginsViewProps {
  return { plugins: [plugin], runtimeError: null, onPluginToggle: vi.fn(), onPluginUninstall: vi.fn(), ...overrides };
}
function PluginHarness() {
  const [error, setError] = useState<string | null>(null);
  const flow = usePlugins({ setRuntimeError: setError });
  return <PluginsView plugins={flow.plugins} runtimeError={error}
    onPluginToggle={value => void flow.handlePluginToggle(value)} onPluginUninstall={id => void flow.handlePluginUninstall(id)} />;
}
beforeEach(async () => { await i18n.changeLanguage("zh"); });
afterEach(async () => { cleanup(); await i18n.changeLanguage("zh"); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });

it("toggles and uninstalls a declarative plugin through the native REST endpoints", async () => {
  let current = { ...plugin };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/plugins" && !init?.method) return response({ items: [current], total: 1 });
    if (url === `/api/plugins/${plugin.id}/enabled`) { current = { ...current, enabled: JSON.parse(String(init?.body)).enabled }; return response(current); }
    if (url === `/api/plugins/${plugin.id}`) return response({ deleted: true });
    return response({ items: [], total: 0 });
  });
  vi.stubGlobal("fetch", fetch);
  function Harness() {
    const [error, setError] = useState<string | null>(null);
    const flow = usePlugins({ setRuntimeError: setError });
    useEffect(() => { void listPlugins().then(result => flow.setPlugins(result.items)); }, []);
    return <PluginsView plugins={flow.plugins} runtimeError={error}
      onPluginToggle={value => void flow.handlePluginToggle(value)} onPluginUninstall={id => void flow.handlePluginUninstall(id)} />;
  }
  render(<Harness />);
  await screen.findByText("提示词包", { selector: "strong" });
  fireEvent.click(screen.getByRole("button", { name: "停用" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/plugins/${plugin.id}/enabled`, expect.objectContaining({ body: JSON.stringify({ enabled: false }) })));
  await screen.findByRole("button", { name: "启用" });
  fireEvent.click(screen.getByRole("button", { name: "卸载" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/plugins/${plugin.id}`, expect.objectContaining({ method: "DELETE" })));
  await screen.findByText("还没有安装插件。");
});

it("invokes the original callbacks and translates copy without touching plugin data", async () => {
  const base = props({ runtimeError: "无法更改插件状态。" });
  render(<PluginsView {...base} />);
  await act(() => i18n.changeLanguage("en"));
  expect(screen.getByText("提示词包", { selector: "strong" })).toBeInTheDocument();
  expect(screen.getByText("v1.2 · Unknown author · MIT")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Could not change the plugin state.");
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  const row = screen.getByText("提示词包", { selector: "strong" }).closest("li")!;
  fireEvent.click(screen.getByRole("button", { name: "Disable" }));
  expect(base.onPluginToggle).toHaveBeenCalledWith(plugin);
  fireEvent.click(screen.getByRole("button", { name: "Uninstall" }));
  expect(base.onPluginUninstall).toHaveBeenCalledWith(plugin.id);
  expect(row).toBeInTheDocument();
});

it("shows the empty state and command-capable plugins stay listed for the chat hint", async () => {
  render(<PluginHarness />);
  await screen.findByText("还没有安装插件。");
  expect(screen.getByText(/声明式插件/)).toBeInTheDocument();
});
