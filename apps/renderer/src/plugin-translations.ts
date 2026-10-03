// Translate application-owned copy only. Extension names, Git refs, resource
// paths, compatibility prose and unknown runtime diagnostics stay unchanged.
const english: Record<string, string> = {
  "扩展中心": "Extension center", "插件": "Extensions",
  "粘贴扩展的 Git 仓库地址进行安装；再次输入同一地址可更新。启用后按 SillyTavern 前端扩展权限运行，可访问宿主页面 DOM、事件、同源 API 和外部网络。": "Paste an extension's Git repository URL to install it. Use the same URL to update it. Enabled extensions run with SillyTavern frontend permissions and can access the host DOM, events, same-origin APIs and external networks.",
  "扩展仓库地址": "Extension repository URL", "分支或标签（可选）": "Branch or tag (optional)",
  "分支 / 标签": "Branch / tag", "安装分支或标签": "Install branch or tag",
  "留空使用仓库默认分支": "Leave blank for the repository's default branch",
  "正在处理…": "Processing…", "安装 / 更新": "Install / update", "还没有安装扩展。": "No extensions installed yet.",
  "默认分支": "Default branch", "有可用更新或已选择其他版本": "An update is available or another version is selected",
  "已是最新版本": "Up to date", "当前分支或标签已不存在，请选择其他版本": "This branch or tag no longer exists. Choose another version.",
  "分支与标签": "Branches and tags", "选择版本": "Choose version", "当前版本": "Current version",
  "（已不存在）": " (no longer available)", "当前分支 / 标签": "Current branch / tag", "标签": "Tag", "分支": "Branch",
  "兼容性说明": "Compatibility notes", "应用已安装版本": "Apply installed version", "正在检查…": "Checking…",
  "检查更新": "Check for updates", "正在更新…": "Updating…", "切换版本": "Switch version", "更新": "Update",
  "设置": "Settings", "停用": "Disable", "启用": "Enable", "卸载": "Uninstall", "未知作者": "Unknown author",
  "安装时间": "Installed", "检查时间": "Checked",
};
const statuses: Record<string, string> = {
  "已启用": "Enabled", "已停用": "Disabled", "正在启动…": "Starting…", "正在加载…": "Loading…",
  "扩展已运行": "Extension running", "已安装，启用后可运行": "Installed; enable to run",
  "已更新，启用后可运行": "Updated; enable to run",
};
const errors: Record<string, string> = {
  "无法更改插件状态。": "Could not change the plugin state.", "无法卸载插件。": "Could not uninstall the plugin.",
  "无法检查扩展更新。": "Could not check for extension updates.", "旧版本的更新钩子执行失败。": "The previous version's update hook failed.",
  "扩展更新失败。": "The extension update failed.", "无法保存草稿并重载扩展。": "Could not save drafts and reload extensions.",
  "SillyTavern 扩展安装失败。": "Could not install the SillyTavern extension.",
  "无法更改代码扩展状态。": "Could not change the extension state.", "无法卸载代码扩展。": "Could not uninstall the extension.",
  "无法保存扩展贡献。": "Could not save extension contributions.",
};
const errorPrefixes: Record<string, string> = {
  "新版本已安装，扩展重载未完成：": "The new version is installed, but extension reload did not finish: ",
  "加载失败：": "Load failed: ", "快捷回复失败：": "Quick reply failed: ", "聊天保存失败：": "Chat save failed: ",
  "扩展事件失败：": "Extension event failed: ", "角色加载失败：": "Character load failed: ",
  "保存扩展贡献失败：": "Extension contribution save failed: ", "扩展贡献保存失败：": "Extension contribution save failed: ",
  "扩展钩子失败：": "Extension hook failed: ", "扩展设置保存失败：": "Extension settings save failed: ",
};

export function pluginText(language: string, value: string): string {
  return language.startsWith("en") && Object.hasOwn(english, value) ? english[value]! : value;
}
export function pluginDiagnostic(language: string, value: string): string {
  if (!language.startsWith("en")) return value;
  if (Object.hasOwn(statuses, value)) return statuses[value]!;
  if (Object.hasOwn(errors, value)) return errors[value]!;
  for (const [prefix, translated] of Object.entries(errorPrefixes)) {
    if (value.startsWith(prefix)) return translated + value.slice(prefix.length);
  }
  const event = /^扩展事件失败（([^\r\n]*)）：([\s\S]*)$/.exec(value);
  return event ? `Extension event failed (${event[1]}): ${event[2]}` : value;
}
export function pluginRefLabel(language: string, name: string): string {
  return language.startsWith("en") ? `Branch or tag for ${name}` : `${name} 的分支或标签`;
}
export function pluginFileCount(language: string, count: number): string {
  const value = count.toLocaleString(language.startsWith("en") ? "en-US" : "zh-CN");
  return language.startsWith("en") ? `${value} file${count === 1 ? "" : "s"}` : `${value} 个文件`;
}
export function pluginDate(language: string, value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(language.startsWith("en") ? "en-US" : "zh-CN");
}
