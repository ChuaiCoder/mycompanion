import i18next from "i18next";
import { initReactI18next } from "react-i18next";

const messages = {
  "nav.import": ["导入角色卡", "Import character"], "nav.reading": ["正在读取角色卡…", "Reading character…"],
  "nav.library": ["角色库", "Characters"], "nav.chat": ["故事", "Stories"], "nav.plugins": ["插件", "Extensions"], "nav.memory": ["记忆", "Memory"], "nav.settings": ["设置", "Settings"],
  "service.checking": ["检查服务中", "Checking service"], "service.online": ["服务已连接", "Service connected"], "service.offline": ["服务未连接", "Service unavailable"],
  "language.label": ["界面语言", "Interface language"], "language.failed": ["语言偏好保存失败，请重试切换语言。", "Could not save the language preference. Please try switching again."],
  "settings.step": ["第 2 步 · 连接模型", "Step 2 · Connect a model"], "settings.title": ["让角色可以回复", "Let your character reply"],
  "settings.roleReady": ["角色“{{name}}”已准备好。", "Your character “{{name}}” is ready."], "settings.importFirst": ["导入角色后可以回到这里连接模型。", "After importing a character, come here to connect a model."],
  "settings.intro": ["填写服务地址、模型名称和密钥；其余参数已有推荐值。", "Enter the service address, model name and key. Recommended values are ready for the other settings."],
  "settings.source": ["模型来源", "Model source"], "settings.online": ["在线模型 / OpenAI 兼容服务", "Online / OpenAI compatible service"], "settings.local": ["本机 Ollama", "Local Ollama"],
  "settings.address": ["服务地址", "Service address"], "settings.model": ["模型名称", "Model name"], "settings.key": ["API Key / 服务密钥", "API key"],
  "settings.ollamaHelp": ["先启动 Ollama，并下载需要使用的模型。默认地址适用于本机安装。", "Start Ollama and download a model first. The default address is for a local installation."],
  "settings.onlineHelp": ["使用服务商提供的 OpenAI 兼容地址，通常以 /v1 结尾。默认地址适用于 OpenAI。", "Use your provider's OpenAI compatible address, usually ending in /v1. The default address is for OpenAI."],
  "settings.existingKey": ["相同服务地址留空可使用已保存密钥", "Leave blank to use the saved key for the same service"], "settings.optionalKey": ["本地 Ollama 可以留空", "Optional for local Ollama"],
  "settings.keyHelp": ["密钥由 Windows 安全存储加密保存。连接测试会让所选模型生成一条简短回复，可能产生少量服务费用。", "Windows secure storage encrypts your key. The test requests a short reply from the selected model and may use a small amount of credit."],
  "settings.advanced": ["高级生成参数", "Advanced generation settings"], "settings.temperature": ["Temperature", "Temperature"], "settings.maxTokens": ["最大输出 Token", "Maximum output tokens"], "settings.context": ["模型上下文上限（Token 预算）", "Context limit (token budget)"],
  "settings.recommended": ["使用推荐参数", "Use recommended values"], "settings.save": ["直接保存设置", "Save settings"], "settings.test": ["测试成功后保存", "Test, then save"], "settings.testing": ["正在测试连接…", "Testing connection…"],
  "settings.next": ["第 3 步：开始对话", "Step 3: Start chatting"], "settings.back": ["返回角色库", "Back to characters"], "settings.loading": ["正在读取模型设置…", "Loading model settings…"], "settings.presets": ["聊天预设与提示词设置", "Chat presets and prompts"],
  "settings.fixKey": ["修改密钥", "Edit key"], "settings.fixModel": ["修改模型", "Edit model"], "settings.fixAddress": ["检查服务地址", "Check service address"],
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
type Settings = { extension_settings: Record<string, unknown>; loadExtensionSettings(): Promise<void>; saveSettings(): Promise<void> };
let settings: Settings | undefined, pending: Promise<void> | undefined, preferenceRevision = 0;
export function initializeUiLanguage(): Promise<void> {
  return pending ??= (async () => {
    const token = preferenceRevision, path = "/plugin-runtime/settings.js";
    settings = await import(/* @vite-ignore */ path) as Settings; await settings.loadExtensionSettings();
    const preferences = settings.extension_settings.__mycompanion_preferences as { language?: unknown } | undefined;
    if (token === preferenceRevision && (preferences?.language === "zh" || preferences?.language === "en")) await i18next.changeLanguage(preferences.language);
    else if (preferenceRevision) await persistUiLanguage();
  })().catch(error => { pending = undefined; throw error; });
}
async function persistUiLanguage() {
  if (!settings) return;
  const preferences = settings.extension_settings.__mycompanion_preferences ??= {};
  (preferences as Record<string, unknown>).language = i18next.language === "en" ? "en" : "zh";
  await settings.saveSettings();
}
export async function changeUiLanguage(language: UiLanguage): Promise<void> {
  preferenceRevision++; await i18next.changeLanguage(language); await initializeUiLanguage(); await persistUiLanguage();
}
export const uiLocale = () => i18next.language === "en" ? "en-US" : "zh-CN";
export default i18next;
