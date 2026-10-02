import { useEffect, useRef, useState } from "react";

import type { CodePlugin, CodePluginContribution, CodePluginUpdateCheck, InstalledPlugin } from "@mycompanion/shared";

import {
  ApiRequestError,
  checkCodePluginUpdate,
  installCodePluginFromUrl,
  listCodePlugins,
  saveCodePluginContributions,
  setCodePluginEnabled,
  setPluginEnabled,
  uninstallCodePlugin,
  uninstallPlugin,
  updateCodePlugin,
} from "../api";
import { loadExtensionHost, reloadForExtensions } from "../ExtensionHost";
import { persistExtensionResume, type WorkspaceView } from "./useExtensionResume";
import { flushWorldEditorDrafts } from "../world-editor-drafts";
import { resolvePluginRef } from "../plugin-version-utils";

// 插件与 SillyTavern 代码扩展：启停/卸载/URL 安装，扩展变更后暂存界面状态并整页刷新。
export function usePlugins(deps: {
  workspaceView: WorkspaceView;
  conversationId: string | undefined;
  chatInput: string;
  setRuntimeError: (message: string | null) => void;
}) {
  const { workspaceView, conversationId, chatInput, setRuntimeError } = deps;
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  const [codePlugins, setCodePlugins] = useState<CodePlugin[]>([]);
  const [openedPluginId, setOpenedPluginId] = useState<string | null>(null);
  const [pluginUrl, setPluginUrl] = useState("");
  const [pluginRef, setPluginRef] = useState("");
  const [isInstallingFromUrl, setIsInstallingFromUrl] = useState(false);
  const [codePluginStatus, setCodePluginStatus] = useState<Record<string, string>>({});
  const [codePluginChecks, setCodePluginChecks] = useState<Record<string, CodePluginUpdateCheck>>({});
  const [codePluginRefs, setCodePluginRefs] = useState<Record<string, string>>({});
  const [codePluginErrors, setCodePluginErrors] = useState<Record<string, string>>({});
  const [codePluginPendingReload, setCodePluginPendingReload] = useState<Record<string, boolean>>({});
  const [codePluginOperations, setCodePluginOperations] = useState<Record<string, "checking" | "updating" | "changing">>({});
  const pendingOperations = useRef(new Set<string>());
  const changing = useRef(false);
  const currentPlugins = useRef(codePlugins);
  currentPlugins.current = codePlugins;
  const listRevision = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const revision = listRevision.current;
    void listCodePlugins(controller.signal)
      .then((result) => { if (revision === listRevision.current) setCodePlugins(result.items); })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const activeCommands = plugins
    .filter((plugin) => plugin.enabled && plugin.permissions.includes("command:register"))
    .flatMap((plugin) => plugin.contributes.commands);

  const handlePluginToggle = async (plugin: InstalledPlugin): Promise<void> => {
    setRuntimeError(null);
    try {
      const updated = await setPluginEnabled(plugin.id, !plugin.enabled);
      setPlugins((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (error) {
      setRuntimeError(error instanceof ApiRequestError ? error.message : "无法更改插件状态。");
    }
  };

  const handlePluginUninstall = async (id: string): Promise<void> => {
    setRuntimeError(null);
    try {
      await uninstallPlugin(id);
      setPlugins((current) => current.filter((plugin) => plugin.id !== id));
    } catch (error) {
      setRuntimeError(error instanceof ApiRequestError ? error.message : "无法卸载插件。");
    }
  };

  const restartExtensions = (): void => {
    persistExtensionResume({ view: workspaceView, conversationId, input: chatInput });
    reloadForExtensions();
  };
  const prepareExtensionChange = async (id: string, hook: string): Promise<void> => {
    await flushWorldEditorDrafts();
    const host = await loadExtensionHost();
    await host.start();
    await host.callHook(id, hook);
    await host.flush();
  };

  const finishOperation = (id: string): void => {
    pendingOperations.current.delete(id);
    setCodePluginOperations(current => { const next = { ...current }; delete next[id]; return next; });
  };
  const invalidateCheck = (id: string): void => {
    setCodePluginChecks(current => { const next = { ...current }; delete next[id]; return next; });
    setCodePluginRefs(current => { const next = { ...current }; delete next[id]; return next; });
  };

  const handleCodePluginCheckUpdate = async (plugin: CodePlugin): Promise<void> => {
    if (pendingOperations.current.has(plugin.id) || changing.current) return;
    pendingOperations.current.add(plugin.id);
    setCodePluginOperations(current => ({ ...current, [plugin.id]: "checking" }));
    setCodePluginErrors(current => ({ ...current, [plugin.id]: "" }));
    const revision = listRevision.current;
    try {
      const checked = await checkCodePluginUpdate(plugin.id);
      if (revision !== listRevision.current) return;
      const latest = currentPlugins.current.find(item => item.id === plugin.id);
      if (!latest || latest.sourceRevision !== checked.installedRevision || latest.sourceRef !== plugin.sourceRef || latest.sourceUrl !== checked.sourceUrl) return;
      setCodePluginChecks(current => ({ ...current, [plugin.id]: checked }));
      setCodePluginRefs(current => ({ ...current, [plugin.id]: checked.sourceRef }));
    } catch (error) {
      if (revision !== listRevision.current) return;
      invalidateCheck(plugin.id);
      setCodePluginErrors(current => ({ ...current, [plugin.id]: error instanceof Error ? error.message : "无法检查扩展更新。" }));
    } finally { finishOperation(plugin.id); }
  };

  const handleCodePluginRef = (id: string, ref: string): void => {
    setCodePluginRefs(current => ({ ...current, [id]: ref }));
  };

  const handleCodePluginUpdate = async (plugin: CodePlugin): Promise<void> => {
    const checked = codePluginChecks[plugin.id];
    if (!checked || checked.installedRevision !== plugin.sourceRevision || pendingOperations.current.has(plugin.id) || changing.current) return;
    const ref = codePluginRefs[plugin.id] ?? checked.sourceRef;
    if (!resolvePluginRef(checked, ref)) return;
    changing.current = true; pendingOperations.current.add(plugin.id);
    setCodePluginOperations(current => ({ ...current, [plugin.id]: "updating" }));
    setCodePluginErrors(current => ({ ...current, [plugin.id]: "" }));
    setRuntimeError(null);
    let installed = false;
    try {
      await flushWorldEditorDrafts();
      const host = await loadExtensionHost();
      await host.start(); await host.flush();
      const updated = await updateCodePlugin(plugin.id, checked.installedRevision, ref !== checked.sourceRef ? ref : undefined);
      installed = true; listRevision.current++;
      setCodePlugins(current => current.map(item => item.id === updated.id ? updated : item));
      invalidateCheck(plugin.id);
      if (updated.enabled) {
        if (await host.callHook(plugin.id, "update") === false) throw new Error("旧版本的更新钩子执行失败。");
        await host.flush();
        restartExtensions();
      } else setCodePluginStatus(current => ({ ...current, [plugin.id]: "已更新，启用后可运行" }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "扩展更新失败。";
      setCodePluginErrors(current => ({ ...current, [plugin.id]: installed ? "新版本已安装，扩展重载未完成：" + message : message }));
      if (installed) setCodePluginPendingReload(current => ({ ...current, [plugin.id]: true }));
      if (error instanceof ApiRequestError && error.code === "EXTENSION_CHANGED") {
        invalidateCheck(plugin.id);
        try { const latest = await listCodePlugins(); listRevision.current++; setCodePlugins(latest.items); } catch { /* Preserve the visible version when refresh is temporarily unavailable. */ }
      }
    } finally { changing.current = false; finishOperation(plugin.id); }
  };

  const handleCodePluginReload = async (id: string): Promise<void> => {
    if (changing.current || pendingOperations.current.has(id)) return;
    changing.current = true; pendingOperations.current.add(id);
    setCodePluginOperations(current => ({ ...current, [id]: "changing" }));
    try {
      await flushWorldEditorDrafts(); const host = await loadExtensionHost(); await host.flush();
      restartExtensions();
    } catch (error) {
      setCodePluginErrors(current => ({ ...current, [id]: error instanceof Error ? error.message : "无法保存草稿并重载扩展。" }));
    } finally { changing.current = false; finishOperation(id); }
  };

  const handleInstallFromUrl = async (): Promise<void> => {
    const url = pluginUrl.trim();
    if (!url || isInstallingFromUrl || changing.current) return;
    changing.current = true;
    setIsInstallingFromUrl(true);
    setRuntimeError(null);
    let installed: CodePlugin | undefined;
    try {
      const host = await loadExtensionHost();
      await flushWorldEditorDrafts();
      await host.start(); await host.flush();
      const plugin = await installCodePluginFromUrl(url, pluginRef.trim());
      installed = plugin;
      listRevision.current++;
      invalidateCheck(plugin.id);
      setCodePlugins((current) => [plugin, ...current.filter((item) => item.id !== plugin.id)]);
      if (codePlugins.some(item => item.id === plugin.id && item.enabled)) {
        if (await host.callHook(plugin.id, "update") === false) throw new Error("旧版本的更新钩子执行失败。");
        await host.flush();
        restartExtensions();
        return;
      }
      setCodePluginStatus((current) => ({ ...current, [plugin.id]: "已安装，启用后可运行" }));
      setPluginUrl("");
      setPluginRef("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "SillyTavern 扩展安装失败。";
      if (installed) {
        setCodePluginErrors(current => ({ ...current, [installed!.id]: "新版本已安装，扩展重载未完成：" + message }));
        setCodePluginPendingReload(current => ({ ...current, [installed!.id]: true }));
      } else setRuntimeError(message);
    } finally {
      setIsInstallingFromUrl(false);
      changing.current = false;
    }
  };

  const handleCodePluginToggle = async (plugin: CodePlugin): Promise<void> => {
    if (changing.current || pendingOperations.current.has(plugin.id)) return;
    changing.current = true; pendingOperations.current.add(plugin.id);
    setCodePluginOperations(current => ({ ...current, [plugin.id]: "changing" }));
    setRuntimeError(null);
    try {
      await prepareExtensionChange(plugin.id, plugin.enabled ? "disable" : "enable");
      const updated = await setCodePluginEnabled(plugin.id, !plugin.enabled);
      listRevision.current++;
      setCodePlugins((current) => current.map((item) => item.id === updated.id ? updated : item));
      setCodePluginStatus((current) => ({
        ...current,
        [plugin.id]: updated.enabled ? "正在启动…" : "已停用",
      }));
      restartExtensions();
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "无法更改代码扩展状态。");
    } finally { changing.current = false; finishOperation(plugin.id); }
  };

  const handleCodePluginUninstall = async (id: string): Promise<void> => {
    if (changing.current || pendingOperations.current.has(id)) return;
    changing.current = true; pendingOperations.current.add(id);
    setCodePluginOperations(current => ({ ...current, [id]: "changing" }));
    setRuntimeError(null);
    try {
      await prepareExtensionChange(id, "delete");
      await uninstallCodePlugin(id);
      listRevision.current++;
      invalidateCheck(id);
      setCodePlugins((current) => current.filter((plugin) => plugin.id !== id));
      restartExtensions();
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "无法卸载代码扩展。");
    } finally { changing.current = false; finishOperation(id); }
  };

  const handleCodePluginContributions = async (
    id: string,
    contribution: CodePluginContribution,
  ): Promise<void> => {
    try {
      await saveCodePluginContributions(id, contribution);
    } catch (error) {
      setCodePluginStatus((current) => ({
        ...current,
        [id]: error instanceof ApiRequestError ? error.message : "无法保存扩展贡献。",
      }));
      throw error;
    }
  };

  const handleCodePluginStatus = (id: string, status: string): void => {
    setCodePluginStatus((current) => current[id] === status ? current : { ...current, [id]: status });
  };

  return {
    plugins,
    setPlugins,
    codePlugins,
    setCodePlugins,
    openedPluginId,
    setOpenedPluginId,
    pluginUrl,
    setPluginUrl,
    pluginRef,
    setPluginRef,
    isInstallingFromUrl,
    codePluginStatus,
    codePluginChecks,
    codePluginRefs,
    codePluginErrors,
    codePluginPendingReload,
    codePluginOperations,
    isChangingPlugins: isInstallingFromUrl || Object.values(codePluginOperations).some(operation => operation !== "checking"),
    activeCommands,
    handlePluginToggle,
    handlePluginUninstall,
    handleInstallFromUrl,
    handleCodePluginToggle,
    handleCodePluginUninstall,
    handleCodePluginContributions,
    handleCodePluginStatus,
    handleCodePluginCheckUpdate,
    handleCodePluginRef,
    handleCodePluginUpdate,
    handleCodePluginReload,
  };
}
