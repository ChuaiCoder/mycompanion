// Translate application-owned copy only. Plugin names, versions and unknown
// runtime diagnostics stay unchanged.
const english: Record<string, string> = {
  "扩展中心": "Extension center", "插件": "Extensions",
  "声明式插件是纯数据的提示词插件：声明注入的提示词与斜杠命令，不包含可执行代码。可在此启用、停用或卸载。":
    "Declarative plugins are data-only prompt plugins: they declare injected prompts and slash commands without executable code. Enable, disable or uninstall them here.",
  "还没有安装插件。": "No plugins installed yet.",
  "停用": "Disable", "启用": "Enable", "卸载": "Uninstall", "未知作者": "Unknown author",
};
const statuses: Record<string, string> = {
  "已启用": "Enabled", "已停用": "Disabled",
};
const errors: Record<string, string> = {
  "无法更改插件状态。": "Could not change the plugin state.", "无法卸载插件。": "Could not uninstall the plugin.",
};

export function pluginText(language: string, value: string): string {
  return language.startsWith("en") && Object.hasOwn(english, value) ? english[value]! : value;
}
export function pluginDiagnostic(language: string, value: string): string {
  if (!language.startsWith("en")) return value;
  if (Object.hasOwn(statuses, value)) return statuses[value]!;
  if (Object.hasOwn(errors, value)) return errors[value]!;
  return value;
}
