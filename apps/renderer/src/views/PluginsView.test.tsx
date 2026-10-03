import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CodePlugin, CodePluginUpdateCheck, InstalledPlugin } from "@mycompanion/shared";
import i18n from "../i18n";
import { usePlugins } from "../hooks/usePlugins";
import { PluginsView, type PluginsViewProps } from "./PluginsView";

const host = vi.hoisted(() => ({ start: vi.fn(), flush: vi.fn(), callHook: vi.fn(), reload: vi.fn(), world: vi.fn() }));
vi.mock("../ExtensionHost", () => ({ loadExtensionHost: async () => host, reloadForExtensions: host.reload }));
vi.mock("../world-editor-drafts", () => ({ flushWorldEditorDrafts: host.world }));
const revision = "1".repeat(40), nextRevision = "2".repeat(40);
const plugin: CodePlugin = { kind: "sillytavern-js", id: "test-extension", displayName: "分支与标签", version: "1.0", author: "未知作者",
  license: "MIT", js: "dist/原文-1000.js", css: "dist/原文-1000.css", enabled: true, installedAt: "2026-10-03T00:00:00.000Z",
  fileCount: 1000, totalBytes: 4096, warnings: ["第三方正文 1000：分支与标签"], sourceUrl: "https://github.com/example/plugin",
  sourceRef: "refs/heads/main", sourceRevision: revision };
const checked: CodePluginUpdateCheck = { sourceUrl: plugin.sourceUrl!, sourceRef: plugin.sourceRef!, installedRevision: revision,
  remoteRevision: nextRevision, state: "update_available", defaultRef: plugin.sourceRef!, checkedAt: "2026-10-03T01:00:00.000Z",
  refs: [{ ref: "refs/heads/main", name: "main", kind: "branch", revision: nextRevision },
    { ref: "refs/tags/标签-1000", name: "标签-1000", kind: "tag", revision }] };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function props(overrides: Partial<PluginsViewProps> = {}): PluginsViewProps {
  return { plugins: [], codePlugins: [plugin], isInstallingFromUrl: false, pluginUrl: "", pluginRef: "", isChangingPlugins: false,
    codePluginChecks: {}, codePluginRefs: {}, codePluginErrors: {}, codePluginPendingReload: {}, codePluginOperations: {}, codePluginStatus: {},
    runtimeError: null, onPluginUrl: vi.fn(), onPluginRef: vi.fn(), onInstallFromUrl: vi.fn(), onPluginToggle: vi.fn(), onPluginUninstall: vi.fn(),
    onCodePluginToggle: vi.fn(), onCodePluginUninstall: vi.fn(), onCodePluginCheckUpdate: vi.fn(), onCodePluginRef: vi.fn(),
    onCodePluginUpdate: vi.fn(), onCodePluginReload: vi.fn(), onOpenPlugin: vi.fn(), ...overrides };
}
function PluginHarness() {
  const [error, setError] = useState<string | null>(null);
  const flow = usePlugins({ workspaceView: "plugins", conversationId: undefined, chatInput: "未提交草稿", setRuntimeError: setError });
  return <PluginsView {...props()} plugins={flow.plugins} codePlugins={flow.codePlugins} pluginUrl={flow.pluginUrl} pluginRef={flow.pluginRef}
    isInstallingFromUrl={flow.isInstallingFromUrl} isChangingPlugins={flow.isChangingPlugins} codePluginChecks={flow.codePluginChecks}
    codePluginRefs={flow.codePluginRefs} codePluginErrors={flow.codePluginErrors} codePluginPendingReload={flow.codePluginPendingReload}
    codePluginOperations={flow.codePluginOperations} codePluginStatus={flow.codePluginStatus} runtimeError={error}
    onPluginUrl={flow.setPluginUrl} onPluginRef={flow.setPluginRef} onInstallFromUrl={() => void flow.handleInstallFromUrl()}
    onPluginToggle={value => void flow.handlePluginToggle(value)} onPluginUninstall={id => void flow.handlePluginUninstall(id)}
    onCodePluginToggle={value => void flow.handleCodePluginToggle(value)} onCodePluginUninstall={id => void flow.handleCodePluginUninstall(id)}
    onCodePluginCheckUpdate={value => void flow.handleCodePluginCheckUpdate(value)} onCodePluginRef={flow.handleCodePluginRef}
    onCodePluginUpdate={value => void flow.handleCodePluginUpdate(value)} onCodePluginReload={id => void flow.handleCodePluginReload(id)}
    onOpenPlugin={flow.setOpenedPluginId} />;
}
beforeEach(async () => { await i18n.changeLanguage("zh"); host.start.mockResolvedValue(undefined); host.flush.mockResolvedValue(undefined); host.world.mockResolvedValue(undefined); });
afterEach(async () => { cleanup(); await i18n.changeLanguage("zh"); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); sessionStorage.clear(); });

it("installs through the original Git URL/ref callback and retains inputs and disclosure while language changes during the request", async () => {
  const install = deferred<Response>();
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => url.endsWith("install-url") ? install.promise : response({ items: [], total: 0 }));
  vi.stubGlobal("fetch", fetch); render(<PluginHarness />);
  await act(() => i18n.changeLanguage("en"));
  fireEvent.change(screen.getByRole("textbox", { name: "Extension repository URL" }), { target: { value: plugin.sourceUrl } });
  const disclosure = screen.getByText("Branch or tag (optional)").closest("details")!; disclosure.open = true;
  fireEvent.change(screen.getByRole("textbox", { name: "Install branch or tag" }), { target: { value: "refs/tags/标签-1000" } });
  fireEvent.click(screen.getByRole("button", { name: "Install / update" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/code-plugins/install-url", expect.objectContaining({
    body: JSON.stringify({ url: plugin.sourceUrl, branch: "refs/tags/标签-1000" }),
  })));
  await act(() => i18n.changeLanguage("zh"));
  expect(screen.getByRole("textbox", { name: "扩展仓库地址" })).toHaveValue(plugin.sourceUrl);
  expect(screen.getByRole("textbox", { name: "安装分支或标签" })).toHaveValue("refs/tags/标签-1000");
  expect(screen.getByRole("button", { name: "正在处理…" })).toBeDisabled(); expect(disclosure.open).toBe(true);
  expect(fetch.mock.calls.filter(([url]) => url.endsWith("install-url"))).toHaveLength(1);
  await act(async () => { install.resolve(response({ ...plugin, enabled: false })); await install.promise; });
  await screen.findByText("已安装，启用后可运行");
  await act(() => i18n.changeLanguage("en"));
  expect(screen.getByText("Installed; enable to run")).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Extension repository URL" })).toHaveValue("");
  expect(screen.getByRole("textbox", { name: "Install branch or tag" })).toHaveValue("");
  expect(screen.queryByRole("button", { name: /JSON|ZIP|example|confirm/i })).not.toBeInTheDocument();
  expect(host.reload).not.toHaveBeenCalled();
});

it("keeps the real update check, chosen tag and open controls across language changes before the explicit version callback", async () => {
  const check = deferred<Response>();
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => url.endsWith("/check-update") ? check.promise
    : url.endsWith("/update") ? response({ ...plugin, sourceRef: "refs/tags/标签-1000" }) : response({ items: [plugin], total: 1 }));
  vi.stubGlobal("fetch", fetch); render(<PluginHarness />); await screen.findByText(plugin.displayName, { selector: "strong" });
  const notes = screen.getByText("兼容性说明").closest("details")!; notes.open = true;
  fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/code-plugins/test-extension/check-update", expect.any(Object)));
  await act(() => i18n.changeLanguage("en"));
  expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled(); expect(notes.open).toBe(true);
  expect(screen.getByText(plugin.warnings[0]!)).toBeInTheDocument(); expect(host.callHook).not.toHaveBeenCalled();
  await act(async () => { check.resolve(response(checked)); await check.promise; });
  const picker = await screen.findByRole("combobox", { name: `Branch or tag for ${plugin.displayName}` });
  const versions = picker.closest("details")!; versions.open = true;
  fireEvent.change(picker, { target: { value: "refs/tags/标签-1000" } });
  await act(() => i18n.changeLanguage("zh")); await act(() => i18n.changeLanguage("en"));
  expect(picker).toHaveValue("refs/tags/标签-1000"); expect(versions.open).toBe(true); expect(notes.open).toBe(true);
  expect(fetch.mock.calls.filter(([url]) => url.endsWith("/check-update"))).toHaveLength(1);
  expect(fetch.mock.calls.some(([url]) => url.endsWith("/update"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Switch version" }));
  await waitFor(() => expect(host.reload).toHaveBeenCalledOnce());
  expect(fetch).toHaveBeenCalledWith("/api/code-plugins/test-extension/update", expect.objectContaining({
    body: JSON.stringify({ expectedRevision: revision, branch: "refs/tags/标签-1000" }),
  }));
  expect(host.callHook).toHaveBeenCalledWith(plugin.id, "update");
  expect(host.callHook.mock.invocationCallOrder[0]).toBeLessThan(host.flush.mock.invocationCallOrder.at(-1)!);
  expect(host.flush.mock.invocationCallOrder.at(-1)).toBeLessThan(host.reload.mock.invocationCallOrder[0]!);
});

it("uses the real disable and uninstall hooks from English controls without a new confirmation", async () => {
  const disable = deferred<Response>();
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => url.endsWith("/enabled") ? disable.promise
    : url === `/api/code-plugins/${plugin.id}` ? response({ deleted: true }) : response({ items: [plugin], total: 1 }));
  vi.stubGlobal("fetch", fetch); render(<PluginHarness />); await screen.findByText(plugin.displayName, { selector: "strong" });
  await act(() => i18n.changeLanguage("en")); fireEvent.click(screen.getByRole("button", { name: "Disable" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/code-plugins/${plugin.id}/enabled`, expect.objectContaining({ body: JSON.stringify({ enabled: false }) })));
  await act(() => i18n.changeLanguage("zh")); expect(screen.getByRole("button", { name: "停用" })).toBeDisabled();
  await act(async () => { disable.resolve(response({ ...plugin, enabled: false })); await disable.promise; });
  await waitFor(() => expect(host.reload).toHaveBeenCalledOnce());
  await act(() => i18n.changeLanguage("en")); expect(screen.getByRole("button", { name: "Enable" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Uninstall" }));
  await waitFor(() => expect(host.reload).toHaveBeenCalledTimes(2));
  expect(fetch).toHaveBeenCalledWith(`/api/code-plugins/${plugin.id}`, expect.objectContaining({ method: "DELETE" }));
  expect(host.callHook.mock.calls).toEqual([[plugin.id, "disable"], [plugin.id, "delete"]]);
  expect(JSON.parse(sessionStorage.getItem("mycompanion.extension-resume")!)).toMatchObject({ view: "plugins", input: "未提交草稿" });
});

it("formats counts and dates while keeping extension prose, names, refs and unknown status intact, and invokes the original settings/reload callbacks", async () => {
  const base = props({ codePluginChecks: { [plugin.id]: checked }, codePluginStatus: { [plugin.id]: "第三方状态 1000：已启用" },
    runtimeError: "聊天保存失败：第三方原文 1000", codePluginPendingReload: { [plugin.id]: true } });
  render(<PluginsView {...base} />);
  const notes = screen.getByText("兼容性说明").closest("details")!; notes.open = true;
  await act(() => i18n.changeLanguage("en"));
  expect(screen.getByText(plugin.displayName, { selector: "strong" })).toBeInTheDocument();
  expect(screen.getByText("v1.0 · 未知作者 · MIT")).toBeInTheDocument();
  expect(screen.getByText(plugin.warnings[0]!)).toBeInTheDocument();
  expect(screen.getByText("第三方状态 1000：已启用")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Chat save failed: 第三方原文 1000");
  expect(screen.getByText(/1,000 files/)).toBeInTheDocument();
  const installed = document.querySelector(`time[datetime="${plugin.installedAt}"]`)!;
  const checkTime = document.querySelector(`time[datetime="${checked.checkedAt}"]`)!;
  expect(installed).toHaveTextContent(new Date(plugin.installedAt).toLocaleString("en-US"));
  expect(checkTime).toHaveTextContent(new Date(checked.checkedAt).toLocaleString("en-US"));
  expect(screen.getByRole("option", { name: `Tag · 标签-1000 · ${revision.slice(0, 10)}` })).toHaveValue("refs/tags/标签-1000");
  expect(notes.open).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Settings" })); expect(base.onOpenPlugin).toHaveBeenCalledWith(plugin.id);
  fireEvent.click(screen.getByRole("button", { name: "Apply installed version" })); expect(base.onCodePluginReload).toHaveBeenCalledWith(plugin.id);
  await act(() => i18n.changeLanguage("zh")); expect(installed).toHaveTextContent(new Date(plugin.installedAt).toLocaleString("zh-CN"));
  expect(notes.open).toBe(true); expect(base.onCodePluginUpdate).not.toHaveBeenCalled();
});

it("preserves a missing ref and unknown error while translating failed-reload feedback and retaining existing legacy management", async () => {
  const legacy: InstalledPlugin = { schemaVersion: 1, id: "legacy-plugin", name: "插件", version: "1", description: "用户正文", author: "", license: "MIT",
    permissions: [], contributes: { commands: [] }, enabled: false, installedAt: plugin.installedAt };
  const base = props({ plugins: [legacy], codePluginChecks: { [plugin.id]: { ...checked, sourceRef: "refs/heads/未知分支" } },
    codePluginRefs: { [plugin.id]: "refs/heads/未知分支" }, codePluginErrors: { [plugin.id]: "新版本已安装，扩展重载未完成：未知错误 1000" } });
  render(<PluginsView {...base} />); await act(() => i18n.changeLanguage("en"));
  expect(screen.getByRole("option", { name: "refs/heads/未知分支 (no longer available)" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Update" })).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("The new version is installed, but extension reload did not finish: 未知错误 1000");
  const row = screen.getByText("插件", { selector: "strong" }).closest("li")!;
  expect(within(row).getByText("v1 · Unknown author · MIT")).toBeInTheDocument();
  fireEvent.click(within(row).getByRole("button", { name: "Enable" })); expect(base.onPluginToggle).toHaveBeenCalledWith(legacy);
  fireEvent.click(within(row).getByRole("button", { name: "Uninstall" })); expect(base.onPluginUninstall).toHaveBeenCalledWith(legacy.id);
  expect(screen.queryByRole("button", { name: /JSON|ZIP|example|confirm/i })).not.toBeInTheDocument();
});
