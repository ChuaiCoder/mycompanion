import { useState } from "react";

import type { InstalledPlugin } from "@mycompanion/shared";

import { ApiRequestError, setPluginEnabled, uninstallPlugin } from "../api";

// 声明式插件（纯数据，/api/plugins）：启停与卸载。SillyTavern 代码扩展已移除。
export function usePlugins(deps: {
  setRuntimeError: (message: string | null) => void;
}) {
  const { setRuntimeError } = deps;
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);

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

  return {
    plugins,
    setPlugins,
    activeCommands,
    handlePluginToggle,
    handlePluginUninstall,
  };
}
