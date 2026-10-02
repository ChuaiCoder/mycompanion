import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

const host = vi.hoisted(() => ({ start: vi.fn(), flush: vi.fn(), callHook: vi.fn(), reload: vi.fn() }));
vi.mock("./ExtensionHost", () => ({
  loadExtensionHost: async () => host,
  flushLoadedExtensionHost: () => host.flush(),
  useExtensionHost: () => {},
  reloadForExtensions: host.reload,
}));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); sessionStorage.clear(); });

describe("desktop extension workflow", () => {
  it("updates an enabled extension through the same URL and reloads after its update hook", async () => {
    const plugin = { kind: "sillytavern-js", id: "test-extension", displayName: "Test extension",
      version: "1.0", author: "Test", license: "MIT", js: "index.js", css: null,
      enabled: true, installedAt: "2026-09-24T00:00:00.000Z", fileCount: 2,
      totalBytes: 128, warnings: [], sourceUrl: "https://example.com/test-extension" };
    const fetchMock = vi.fn(async (url: string) => {
      const payload = url === "/api/health"
        ? { status: "ok", service: "mycompanion-local-service", version: "0.2.0" }
        : url === "/api/code-plugins" ? { items: [plugin], total: 1 }
        : url === "/api/code-plugins/install-url" ? { ...plugin, version: "1.1" }
        : { items: [], total: 0 };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^插件/ }));
    await screen.findByText("Test extension");
    fireEvent.change(screen.getByRole("textbox", { name: "扩展仓库地址" }),
      { target: { value: "https://example.com/test-extension" } });
    fireEvent.click(screen.getByRole("button", { name: "安装 / 更新" }));
    await waitFor(() => expect(host.reload).toHaveBeenCalledTimes(1));
    expect(host.callHook).toHaveBeenCalledWith("test-extension", "update");
    expect(host.flush).toHaveBeenCalledTimes(2);
    expect(host.callHook.mock.invocationCallOrder[0]!).toBeLessThan(host.flush.mock.invocationCallOrder[1]!);
    expect(host.flush.mock.invocationCallOrder[1]!).toBeLessThan(host.reload.mock.invocationCallOrder[0]!);
  });

  it("installs by URL, retains real mounts across navigation, and flushes hooks before reloading", async () => {
    let installed = false;
    const plugin = {
      kind: "sillytavern-js", id: "test-extension", displayName: "Test extension",
      version: "1.0", author: "Test", license: "MIT", js: "index.js", css: null,
      enabled: false, installedAt: "2026-09-24T00:00:00.000Z", fileCount: 2,
      totalBytes: 128, warnings: [],
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      let payload: unknown = { items: [], total: 0 };
      if (url === "/api/health") payload = { status: "ok", service: "mycompanion-local-service", version: "0.2.0" };
      if (url === "/api/code-plugins") payload = { items: installed ? [plugin] : [], total: installed ? 1 : 0 };
      if (url === "/api/code-plugins/install-url") { installed = true; payload = plugin; }
      if (url === "/api/code-plugins/test-extension/enabled") {
        plugin.enabled = JSON.parse(String(init?.body)).enabled;
        payload = plugin;
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^插件/ }));
    expect(screen.queryByText("安装 ZIP")).not.toBeInTheDocument();
    expect(screen.queryByText("安装 JSON")).not.toBeInTheDocument();
    expect(screen.queryByText("安装示例")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "扩展仓库地址" }), { target: { value: "https://example.com/test-extension" } });
    fireEvent.click(screen.getByRole("button", { name: "安装 / 更新" }));
    await screen.findByText("Test extension");
    expect(fetchMock).toHaveBeenCalledWith("/api/code-plugins/install-url", expect.objectContaining({
      body: JSON.stringify({ url: "https://example.com/test-extension", branch: "" }),
    }));
    const chat = document.getElementById("chat");
    const settings = document.getElementById("extensions_settings");
    expect(chat).not.toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "启用" }));
    await waitFor(() => expect(host.reload).toHaveBeenCalledTimes(1));
    expect(host.callHook).toHaveBeenCalledWith("test-extension", "enable");
    expect(host.callHook.mock.invocationCallOrder[0]).toBeLessThan(host.flush.mock.invocationCallOrder.at(-1)!);
    expect(host.flush.mock.invocationCallOrder.at(-1)).toBeLessThan(host.reload.mock.invocationCallOrder[0]!);
    expect(JSON.parse(sessionStorage.getItem("mycompanion.extension-resume")!)).toMatchObject({ view: "plugins", input: "" });
    const list = screen.getByText("Test extension", { selector: "li strong" }).closest("li")!;
    fireEvent.click(within(list).getByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭扩展设置" }));
    fireEvent.click(screen.getByRole("button", { name: "故事" }));
    expect(document.getElementById("chat")).toBe(chat);
    fireEvent.click(screen.getByRole("button", { name: /^插件/ }));
    expect(document.getElementById("extensions_settings")).toBe(settings);
    fireEvent.click(screen.getByRole("button", { name: "停用" }));
    await waitFor(() => expect(host.reload).toHaveBeenCalledTimes(2));
    expect(host.callHook).toHaveBeenLastCalledWith("test-extension", "disable");
    expect(fetchMock).toHaveBeenCalledWith("/api/code-plugins/test-extension/enabled", expect.objectContaining({ body: JSON.stringify({ enabled: false }) }));
    fireEvent.click(screen.getByRole("button", { name: "卸载" }));
    await waitFor(() => expect(host.reload).toHaveBeenCalledTimes(3));
    expect(host.callHook).toHaveBeenLastCalledWith("test-extension", "delete");
  });
});

const firstRevision = "1".repeat(40), nextRevision = "2".repeat(40);
const gitPlugin = () => ({ kind: "sillytavern-js", id: "test-extension", displayName: "Test extension", version: "1.0", author: "Test", license: "MIT", js: "index.js", css: null, enabled: true, installedAt: "2026-09-24T00:00:00.000Z", fileCount: 2, totalBytes: 128, warnings: [], sourceUrl: "https://example.com/test-extension", sourceRef: "refs/heads/main", sourceRevision: firstRevision });
const checkedPlugin = (revision = nextRevision) => ({ sourceUrl: "https://example.com/test-extension", sourceRef: "refs/heads/main", installedRevision: firstRevision, remoteRevision: revision, state: revision === firstRevision ? "up_to_date" : "update_available", defaultRef: "refs/heads/main", refs: [{ ref: "refs/heads/main", name: "main", kind: "branch", revision }, { ref: "refs/tags/v1", name: "v1", kind: "tag", revision: firstRevision }], checkedAt: "2026-10-02T00:00:00.000Z" });
const response = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
async function pluginPage(handler: (url: string, init?: RequestInit) => Promise<Response | undefined>) {
  const plugin = gitPlugin();
  const request = vi.fn(async (url: string, init?: RequestInit) => await handler(url, init) ?? response(url === "/api/health" ? { status: "ok", service: "mycompanion-local-service", version: "0.2.1" } : url === "/api/code-plugins" ? { items: [plugin], total: 1 } : { items: [], total: 0 }));
  vi.stubGlobal("fetch", request); render(<App />); fireEvent.click(screen.getByRole("button", { name: /^插件/ })); await screen.findByText("Test extension"); return request;
}

describe("extension Git version controls", () => {
  it("checks without modifying installation, and can switch to a tag sharing the installed commit", async () => {
    const request = await pluginPage(async url => url.endsWith("/check-update") ? response(checkedPlugin(firstRevision)) : url.endsWith("/update") ? response({ ...gitPlugin(), sourceRef: "refs/tags/v1" }) : undefined);
    fireEvent.click(screen.getByRole("button", { name: "检查更新" })); await screen.findByText("已是最新版本");
    expect(screen.getByRole("button", { name: "更新" })).toBeDisabled(); expect(host.callHook).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("combobox", { name: "Test extension 的分支或标签" }), { target: { value: "refs/tags/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "切换版本" }));
    await waitFor(() => expect(host.reload).toHaveBeenCalledTimes(1));
    expect(request).toHaveBeenCalledWith("/api/code-plugins/test-extension/update", expect.objectContaining({ body: JSON.stringify({ expectedRevision: firstRevision, branch: "refs/tags/v1" }) }));
    expect(host.start.mock.invocationCallOrder[0]).toBeLessThan(host.callHook.mock.invocationCallOrder[0]!);
    expect(host.callHook).toHaveBeenCalledWith("test-extension", "update");
    expect(host.flush.mock.invocationCallOrder.at(-1)).toBeLessThan(host.reload.mock.invocationCallOrder[0]!);
  });

  it("updates the checked revision on the existing branch and waits for the old runtime hook before reload", async () => {
    const request = await pluginPage(async url => url.endsWith("/check-update") ? response(checkedPlugin()) : url.endsWith("/update") ? response({ ...gitPlugin(), sourceRevision: nextRevision, version: "1.1" }) : undefined);
    fireEvent.click(screen.getByRole("button", { name: "检查更新" })); await screen.findByText("有可用更新或已选择其他版本");
    fireEvent.click(screen.getByRole("button", { name: "更新" })); await waitFor(() => expect(host.reload).toHaveBeenCalledTimes(1));
    expect(request).toHaveBeenCalledWith("/api/code-plugins/test-extension/update", expect.objectContaining({ body: JSON.stringify({ expectedRevision: firstRevision }) }));
    expect(host.callHook).toHaveBeenCalledWith("test-extension", "update");
    expect(host.flush).toHaveBeenCalledTimes(2);
    expect(host.flush.mock.invocationCallOrder[0]).toBeLessThan(host.callHook.mock.invocationCallOrder[0]!);
    expect(host.callHook.mock.invocationCallOrder[0]).toBeLessThan(host.flush.mock.invocationCallOrder[1]!);
  });

  it("preserves the visible old version and enabled runtime when an update fails, then allows retry", async () => {
    let failed = true;
    await pluginPage(async url => url.endsWith("/check-update") ? response(checkedPlugin()) : url.endsWith("/update") ? failed ? response({ error: { code: "EXTENSION_UPDATE_FAILED", message: "Remote temporarily unavailable" } }, 422) : response({ ...gitPlugin(), sourceRevision: nextRevision }) : undefined);
    fireEvent.click(screen.getByRole("button", { name: "检查更新" })); await screen.findByText("有可用更新或已选择其他版本");
    fireEvent.click(screen.getByRole("button", { name: "更新" })); await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("Remote temporarily unavailable"); expect(screen.getByTitle(firstRevision)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "停用" })).toBeEnabled(); expect(host.reload).not.toHaveBeenCalled(); expect(host.callHook).not.toHaveBeenCalled();
    failed = false; fireEvent.click(screen.getByRole("button", { name: "更新" })); await waitFor(() => expect(host.reload).toHaveBeenCalledTimes(1));
  });

  it("refreshes a 409 version conflict and requires another check before updating", async () => {
    let changed = false;
    await pluginPage(async url => url.endsWith("/check-update") ? response(checkedPlugin()) : url.endsWith("/update") ? (changed = true, response({ error: { code: "EXTENSION_CHANGED", message: "Version changed, check again" } }, 409)) : url === "/api/code-plugins" && changed ? response({ items: [{ ...gitPlugin(), sourceRevision: nextRevision }], total: 1 }) : undefined);
    fireEvent.click(screen.getByRole("button", { name: "检查更新" })); await screen.findByText("有可用更新或已选择其他版本");
    fireEvent.click(screen.getByRole("button", { name: "更新" })); await screen.findByTitle(nextRevision);
    expect(screen.queryByRole("button", { name: "更新" })).not.toBeInTheDocument(); expect(screen.getByRole("button", { name: "检查更新" })).toBeEnabled(); expect(host.reload).not.toHaveBeenCalled();
  });

  it("shows an unavailable current ref, permits another ref and keeps check failures inline", async () => {
    let failed = false;
    await pluginPage(async url => url.endsWith("/check-update") ? failed ? response({ error: { code: "UPDATE_CHECK_FAILED", message: "Cannot reach Git remote" } }, 422) : response({ ...checkedPlugin(), sourceRef: "refs/heads/deleted", remoteRevision: null, state: "ref_missing" }) : undefined);
    fireEvent.click(screen.getByRole("button", { name: "检查更新" })); await screen.findByText("当前分支或标签已不存在，请选择其他版本");
    expect(screen.getByRole("button", { name: "更新" })).toBeDisabled();
    fireEvent.change(screen.getByRole("combobox", { name: "Test extension 的分支或标签" }), { target: { value: "refs/heads/main" } }); expect(screen.getByRole("button", { name: "切换版本" })).toBeEnabled();
    failed = true; fireEvent.click(screen.getByRole("button", { name: "检查更新" })); await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("Cannot reach Git remote"); expect(screen.getByTitle(firstRevision)).toBeInTheDocument(); expect(host.reload).not.toHaveBeenCalled();
  });

  it("passes the optional install ref through the single URL form", async () => {
    const request = await pluginPage(async url => url.endsWith("/install-url") ? response({ ...gitPlugin(), enabled: false, sourceRef: "refs/tags/v1" }) : undefined);
    fireEvent.change(screen.getByRole("textbox", { name: "扩展仓库地址" }), { target: { value: "https://example.com/test-extension" } });
    fireEvent.change(screen.getByRole("textbox", { name: "安装分支或标签" }), { target: { value: "refs/tags/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "安装 / 更新" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("/api/code-plugins/install-url", expect.objectContaining({ body: JSON.stringify({ url: "https://example.com/test-extension", branch: "refs/tags/v1" }) })));
    expect(screen.queryByText("安装 ZIP")).not.toBeInTheDocument(); expect(screen.queryByText("安装 JSON")).not.toBeInTheDocument();
  });

  it("keeps an installed update visible when its old hook fails, then flushes drafts before applying it", async () => {
    host.callHook.mockResolvedValue(false);
    await pluginPage(async url => url.endsWith("/check-update") ? response(checkedPlugin()) : url.endsWith("/update") ? response({ ...gitPlugin(), sourceRevision: nextRevision }) : undefined);
    fireEvent.click(screen.getByRole("button", { name: "检查更新" })); await screen.findByText("有可用更新或已选择其他版本");
    fireEvent.click(screen.getByRole("button", { name: "更新" })); await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("新版本已安装"); expect(screen.getByTitle(nextRevision)).toBeInTheDocument(); expect(host.reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "应用已安装版本" })); await waitFor(() => expect(host.reload).toHaveBeenCalledTimes(1));
    expect(host.callHook).toHaveBeenCalledTimes(1); expect(host.flush.mock.invocationCallOrder.at(-1)).toBeLessThan(host.reload.mock.invocationCallOrder[0]!);
    host.callHook.mockReset();
  });

  it("does not revive a late check after the same URL has installed a newer revision", async () => {
    let resolveCheck!: (value: Response) => void;
    const pendingCheck = new Promise<Response>(resolve => { resolveCheck = resolve; });
    await pluginPage(async url => url.endsWith("/check-update") ? pendingCheck : url.endsWith("/install-url") ? response({ ...gitPlugin(), sourceRevision: nextRevision }) : undefined);
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    fireEvent.change(screen.getByRole("textbox", { name: "扩展仓库地址" }), { target: { value: "https://example.com/test-extension" } });
    fireEvent.click(screen.getByRole("button", { name: "安装 / 更新" })); await screen.findByTitle(nextRevision);
    resolveCheck(response(checkedPlugin())); await waitFor(() => expect(screen.getByRole("button", { name: "检查更新" })).toBeEnabled());
    expect(screen.queryByRole("button", { name: "更新" })).not.toBeInTheDocument(); expect(screen.getByTitle(nextRevision)).toBeInTheDocument();
  });

  it.each(["HEAD", "main"])("resolves legacy source ref %s without misreporting it as deleted or changing it during an update", async sourceRef => {
    const request = await pluginPage(async url => url === "/api/code-plugins" ? response({ items: [{ ...gitPlugin(), sourceRef }], total: 1 }) : url.endsWith("/check-update") ? response({ ...checkedPlugin(), sourceRef }) : url.endsWith("/update") ? response({ ...gitPlugin(), sourceRef, sourceRevision: nextRevision }) : undefined);
    fireEvent.click(screen.getByRole("button", { name: "检查更新" })); await screen.findByText("有可用更新或已选择其他版本");
    expect(screen.queryByText("当前分支或标签已不存在，请选择其他版本")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Test extension 的分支或标签" })).toHaveValue(sourceRef);
    fireEvent.click(screen.getByRole("button", { name: "更新" })); await waitFor(() => expect(host.reload).toHaveBeenCalledTimes(1));
    expect(request).toHaveBeenCalledWith("/api/code-plugins/test-extension/update", expect.objectContaining({ body: JSON.stringify({ expectedRevision: firstRevision }) }));
  });
});
