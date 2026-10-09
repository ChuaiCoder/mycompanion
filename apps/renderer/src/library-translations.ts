// Application-owned copy only. Imported prose, names, file paths and unknown
// diagnostics remain unchanged; language changes do not run import actions.
//
// 静态文案已并入 i18n 的 messages 表（i18n-zh-messages.ts，中文原文即 key）。
// 本文件只剩两类动态逻辑：zh 侧的数字本地化格式化，以及 en 侧的计数模板。
// 查表直接按传入的 language 取列，不依赖 i18next 的当前语言状态。
import { zhKeyedMessages } from "./i18n-zh-messages";

export function libraryText(language: string, value: string): string {
  if (!language.startsWith("en")) {
    // Restrict formatting to application-generated count phrases. A number in
    // a character name or an unrecognized diagnostic remains original text.
    const counted = /^(?:逐文件导入 · \d+ \/ \d+|\d+ 项提醒|\d+ 世界书 · \d+ 正则|已保留 \d+ 条世界书和 \d+ 条正则规则|\d+ 项|（\d+）|\d+ 条 · (?:已保存，运行时未启用|导入后全部禁用))$/.test(value)
      || /^实际识别 \d+ 个(?:文件|故事)，/.test(value);
    return counted ? value.replace(/\d+/g, number => Number(number).toLocaleString("zh-CN")) : value;
  }
  const translated = zhKeyedMessages[value]?.[1];
  if (translated !== undefined) return translated;
  const format = new Intl.NumberFormat("en-US");
  const number = (value: string) => format.format(Number(value));
  let match = /^逐文件导入 · (\d+) \/ (\d+)$/.exec(value);
  if (match) return `Import files · ${number(match[1]!)} / ${number(match[2]!)}`;
  match = /^(\d+) 项提醒$/.exec(value);
  if (match) return `${number(match[1]!)} warning${match[1] === "1" ? "" : "s"}`;
  match = /^(\d+) 世界书 · (\d+) 正则$/.exec(value);
  if (match) return `${number(match[1]!)} world info · ${number(match[2]!)} regex rules`;
  match = /^已保留 (\d+) 条世界书和 (\d+) 条正则规则$/.exec(value);
  if (match) return `Kept ${number(match[1]!)} world info entries and ${number(match[2]!)} regex rules`;
  match = /^实际识别 (\d+) 个文件，确认后将随卡保存，包含未引用的辅助文件。CHARX 导出和完整备份会保留这些文件；外部地址不会自动下载。$/.exec(value);
  if (match) return `${number(match[1]!)} files recognized, including unreferenced supporting files. They will be saved with the card after confirmation and included in CHARX exports and full backups. External addresses are not downloaded automatically.`;
  match = /^实际识别 (\d+) 个故事，确认导入后会保留消息和回复分支，可在故事列表中打开。$/.exec(value);
  if (match) return `${number(match[1]!)} stories recognized. Importing preserves their messages and reply branches; open them from the story list.`;
  match = /^(\d+) 项$/.exec(value);
  if (match) return `${number(match[1]!)} item${match[1] === "1" ? "" : "s"}`;
  match = /^（(\d+)）$/.exec(value);
  if (match) return ` (${number(match[1]!)})`;
  match = /^(\d+) 条 · 已保存，运行时未启用$/.exec(value);
  if (match) return `${number(match[1]!)} entries · Saved, not enabled at runtime`;
  match = /^(\d+) 条 · 导入后全部禁用$/.exec(value);
  if (match) return `${number(match[1]!)} rules · All disabled after import`;
  match = /^“([\s\S]*)”已保存，可以从角色列表继续使用。$/.exec(value);
  if (match) return `“${match[1]}” is saved and available in your character list.`;
  match = /^已打开既有角色“([\s\S]*)”。$/.exec(value);
  if (match) return `Opened existing character “${match[1]}”.`;
  match = /^未知阶段 (.+)$/.exec(value);
  if (match) return `Unknown stage ${match[1]}`;
  match = /^角色卡预览失败（HTTP (\d+)）。$/.exec(value);
  if (match) return `Could not preview this character card (HTTP ${match[1]}).`;
  match = /^请求失败（HTTP (\d+)）。$/.exec(value);
  if (match) return `Request failed (HTTP ${match[1]}).`;
  return value;
}
