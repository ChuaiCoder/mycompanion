// Translate application-owned copy only. Plugin names, versions and unknown
// runtime diagnostics stay unchanged.
//
// 静态文案已并入 i18n 的 messages 表（i18n-zh-messages.ts，中文原文即 key）；
// 这里按传入的 language 直接查表，不依赖 i18next 的当前语言状态。
import { zhKeyedMessages } from "./i18n-zh-messages";

export function pluginText(language: string, value: string): string {
  return language.startsWith("en") ? zhKeyedMessages[value]?.[1] ?? value : value;
}
export function pluginDiagnostic(language: string, value: string): string {
  return pluginText(language, value);
}
