import { zhKeyedMessages } from "./i18n-zh-messages";

/** Translate application labels and known diagnostics without changing file
 * names, imported content or unknown server error details.
 *
 * 静态文案已并入 i18n 的 messages 表（i18n-zh-messages.ts，中文原文即 key）；
 * 这里按传入的 language 直接查表，不依赖 i18next 的当前语言状态。 */
export function backupText(language: string, value: string): string {
  return language.startsWith("en") ? zhKeyedMessages[value]?.[1] ?? value : value;
}
export function backupTotals(language: string, totals: { new: number; overwrite: number; skip: number }): string {
  const format = new Intl.NumberFormat(language.startsWith("en") ? "en-US" : "zh-CN");
  const added = format.format(totals.new), overwritten = format.format(totals.overwrite), skipped = format.format(totals.skip);
  return language.startsWith("en") ? `Add ${added}, overwrite ${overwritten}, skip ${skipped}.`
    : `将新增 ${added} 项、覆盖 ${overwritten} 项、跳过 ${skipped} 项。`;
}
