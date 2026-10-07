import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { loadSharedExtensionSettings, saveSharedExtensionSettings } from "./extension-settings";

const messages = {
  "nav.import": ["导入角色卡", "Import character"], "nav.reading": ["正在读取角色卡…", "Reading character…"],
  "nav.library": ["角色库", "Characters"], "nav.chat": ["故事", "Stories"], "nav.plugins": ["插件", "Extensions"], "nav.memory": ["记忆", "Memory"], "nav.settings": ["设置", "Settings"],
  "service.checking": ["检查模型连接中", "Checking model"], "service.online": ["模型已连接", "Model connected"], "service.offline": ["模型未连接", "Model unavailable"],
  "language.label": ["界面语言", "Interface language"], "language.intro": ["切换后立即生效，并记住你的选择。", "Applies immediately and is remembered."], "language.failed": ["语言偏好保存失败，请重试切换语言。", "Could not save the language preference. Please try switching again."],
  "settings.step": ["第 2 步 · 连接模型", "Step 2 · Connect a model"], "settings.title": ["让角色可以回复", "Let your character reply"],
  "settings.roleReady": ["角色“{{name}}”已准备好。", "Your character “{{name}}” is ready."], "settings.importFirst": ["导入角色后可以回到这里连接模型。", "After importing a character, come here to connect a model."],
  "settings.intro": ["选择服务商、确认模型名称和密钥；其余参数已有推荐值。", "Pick a provider, then confirm the model name and key. Recommended values are ready for the other settings."],
  "settings.source": ["模型来源", "Model source"], "settings.online": ["在线模型 / OpenAI 兼容服务", "Online / OpenAI compatible service"], "settings.local": ["本机 Ollama", "Local Ollama"],
  "settings.address": ["服务地址", "Service address"], "settings.model": ["模型名称", "Model name"], "settings.key": ["API Key / 服务密钥", "API key"],
  "settings.ollamaHelp": ["先启动 Ollama，并下载需要使用的模型。默认地址适用于本机安装。", "Start Ollama and download a model first. The default address is for a local installation."],
  "settings.onlineHelp": ["使用服务商提供的 OpenAI 兼容地址，通常以 /v1 结尾。默认地址适用于 OpenAI。", "Use your provider's OpenAI compatible address, usually ending in /v1. The default address is for OpenAI."],
  "settings.existingKey": ["相同服务地址留空可使用已保存密钥", "Leave blank to use the saved key for the same service"], "settings.optionalKey": ["本地 Ollama 可以留空", "Optional for local Ollama"],
  "settings.requiredKey": ["粘贴服务商给你的 API Key", "Paste the API key from your provider"],
  "settings.protocol": ["接口协议", "API protocol"], "settings.sourceChoose": ["请选择服务商…", "Choose a provider…"],
  "settings.fetchModels": ["测试获取模型", "Fetch models"], "settings.fetchingModels": ["正在获取模型…", "Fetching models…"],
  "settings.modelChoose": ["请选择模型…", "Choose a model…"],
  "settings.modelsFailed": ["获取模型列表失败，请检查地址与密钥。", "Could not fetch the model list. Check the address and key."],
  "settings.keyHelp": ["密钥由 Windows 安全存储加密保存。连接测试会让所选模型生成一条简短回复，可能产生少量服务费用。", "Windows secure storage encrypts your key. The test requests a short reply from the selected model and may use a small amount of credit."],
  "settings.advanced": ["高级生成参数", "Advanced generation settings"], "settings.temperature": ["Temperature", "Temperature"], "settings.maxTokens": ["最大输出 Token", "Maximum output tokens"], "settings.context": ["模型上下文上限（Token 预算）", "Context limit (token budget)"],
  "settings.recommended": ["使用推荐参数", "Use recommended values"], "settings.save": ["直接保存设置", "Save settings"], "settings.test": ["测试成功后保存", "Test, then save"], "settings.testing": ["正在测试连接…", "Testing connection…"],
  "settings.next": ["第 3 步：开始对话", "Step 3: Start chatting"], "settings.back": ["返回角色库", "Back to characters"], "settings.loading": ["正在读取模型设置…", "Loading model settings…"], "settings.presets": ["聊天预设与提示词设置", "Chat presets and prompts"],
  "settings.fixKey": ["修改密钥", "Edit key"], "settings.fixModel": ["修改模型", "Edit model"], "settings.fixAddress": ["检查服务地址", "Check service address"],
  "settings.pageIntro": ["连接模型、管理生成参数与应用数据。日常聊天只需完成“连接模型”一张卡片。", "Connect a model, manage generation settings and app data. Everyday chat only needs the connection card."],
  "conversation.delete": ["删除故事“{{title}}”", "Delete story “{{title}}”"],
  "conversation.deleteConfirm": ["删除故事", "Delete story"],
  "conversation.deletePrompt": ["删除？", "Delete?"],
  "conversation.deleteConfirmAction": ["删除", "Delete"],
  "conversation.deleteCancel": ["取消", "Cancel"],
  "conversation.deleting": ["删除中…", "Deleting…"],
  "conversation.select": ["批量管理", "Select"],
  "conversation.selectExit": ["完成", "Done"],
  "conversation.selectAll": ["全选", "Select all"],
  "conversation.selectNone": ["取消全选", "Clear"],
  "conversation.selectToggle": ["选择故事“{{title}}”", "Select story “{{title}}”"],
  "conversation.selectedCount": ["已选 {{count}} 个", "{{count}} selected"],
  "conversation.deleteSelected": ["删除所选", "Delete selected"],
  "conversation.deleteSelectedConfirm": ["删除这些故事？", "Delete these stories?"],
  "conversation.deleteSelectedBody": ["将删除 {{count}} 个故事，之后可从“已删除”中恢复。", "{{count}} stories will be deleted; they can be restored from deleted."],
  "conversation.deleteSelectedDone": ["已删除 {{count}} 个故事。", "Deleted {{count}} stories."],
  "conversation.deleteNoneSelected": ["请先选择要删除的故事。", "Select at least one story first."],
} as const;
const resources = Object.fromEntries(["zh", "en"].map((language, index) => [language, { translation: Object.fromEntries(Object.entries(messages).map(([key, value]) => [key, value[index]])) }]));
void i18next.use(initReactI18next).init({ lng: "zh", fallbackLng: "zh", resources, initAsync: false, keySeparator: false, interpolation: { escapeValue: false } });
i18next.on("languageChanged", language => {
  const normalized = language === "en" ? "en" : "zh";
  document.documentElement.lang = normalized === "en" ? "en" : "zh-CN";
  window.dispatchEvent(new CustomEvent("mycompanion:language-changed", { detail: { language: normalized === "en" ? "en-US" : "zh-CN" } }));
});
document.documentElement.lang = "zh-CN";
export type UiLanguage = "zh" | "en";
let pending: Promise<void> | undefined, preferenceRevision = 0;
export function initializeUiLanguage(): Promise<void> {
  return pending ??= (async () => {
    const token = preferenceRevision;
    const settings = await loadSharedExtensionSettings();
    const preferences = settings.__mycompanion_preferences as { language?: unknown } | undefined;
    if (token === preferenceRevision && (preferences?.language === "zh" || preferences?.language === "en")) await i18next.changeLanguage(preferences.language);
    else if (preferenceRevision) await persistUiLanguage();
  })().catch(error => { pending = undefined; throw error; });
}
async function persistUiLanguage() {
  const settings = await loadSharedExtensionSettings().catch(() => undefined);
  if (!settings) return;
  const preferences = settings.__mycompanion_preferences ??= {};
  (preferences as Record<string, unknown>).language = i18next.language === "en" ? "en" : "zh";
  await saveSharedExtensionSettings();
}
export async function changeUiLanguage(language: UiLanguage): Promise<void> {
  preferenceRevision++; await i18next.changeLanguage(language); await initializeUiLanguage(); await persistUiLanguage();
}
export const uiLocale = () => i18next.language === "en" ? "en-US" : "zh-CN";
export default i18next;
