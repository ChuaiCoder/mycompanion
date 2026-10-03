// Application-owned copy only. Imported prose, names, file paths and unknown
// diagnostics remain unchanged; language changes do not run import actions.
const english: Record<string, string> = {
  "角色库": "Characters", "角色导入助手": "Character import assistant", "上下文：": "Context: ",
  "世界书": "World info", "历史记录": "History", "新建导入": "New import", "查看具体问题": "View details",
  "批量导入结果": "Batch import results", "待检查": "Waiting to check", "正在检查": "Checking", "等待确认": "Awaiting confirmation",
  "失败": "Failed", "已导入": "Imported", "已打开既有角色": "Existing character opened", "已跳过": "Skipped", "重试此文件": "Retry this file",
  "请帮我检查并导入角色卡": "Check and import this character card",
  "检查完成。这张角色卡可以导入，人物设定、开场白、世界书和正则数据都已进入预览。": "This card is ready to import. Its character details, greeting, world info and regex rules are available in the preview.",
  "右侧列出了实际识别结果。确认后才会写入角色库，你也可以取消并重新选择文件。": "The panel shows what was recognized. Confirm to save it to your library, or cancel and choose another file.",
  "可以导入": "Ready to import", "兼容性检查": "Compatibility check",
  " 已载入。角色设定和扩展内容显示在右侧，你可以检查开场白并开始对话。": " is loaded. Review the character details, extensions and greeting in the panel, then start chatting.",
  "第 1 步已完成：角色数据可用": "Step 1 complete: character ready",
  "首次使用，先测试模型连接，再让角色回复。": "For your first chat, test a model connection so the character can reply.",
  "第 2 步：连接模型": "Step 2: Connect a model", "开始对话": "Start chatting",
  "导入喜欢的角色，直接开始故事。": "Import a character and start your story.",
  "我会先检查人物设定、世界书、正则和兼容性。你确认之前，不会写入永久数据。": "First, review the character details, world info, regex rules and compatibility. Nothing is saved until you confirm.",
  "支持的角色卡内容": "Supported character card content", "识别 V2 / V3": "Recognize V2 / V3", "保留世界书": "Keep world info", "导入正则脚本": "Import regex scripts",
  "正在读取角色卡…": "Reading character card…", "重新选择角色卡": "Choose another card", "选择一张角色卡": "Choose a character card", "选择角色卡文件": "Choose character card files",
  "PNG、JSON、YAML、CHARX 或 BYAF · 最大 20 MiB": "PNG, JSON, YAML, CHARX or BYAF · Up to 20 MiB",
  "兼容导入": "Compatible import", "支持 Character Card V2/V3 · 导入前始终预览": "Character Card V2/V3 · Always preview before importing",
  "当前位置": "Current location", "尚未保存": "Not saved yet", "✓ 已保存到本地": "✓ Saved locally", "本地工作区": "Local workspace", "导入预览 · ": "Import preview · ",
  "这张角色卡没有填写人物简介。": "This card has no character description.", "角色卡内容统计": "Character card statistics",
  "备用开场白": "Alternate greetings", "世界书条目": "World info entries", "正则规则": "Regex rules", "扩展字段": "Extension fields",
  "随卡资产": "Included assets", "随卡故事": "Included stories", "开场白预览": "Greeting preview", "角色卡附属内容": "Character card extras",
  "兼容性": "Compatibility", "格式检查通过，没有需要处理的警告。": "Format checks passed. There are no warnings to review.",
  "字段处理明细": "Field handling details", "原样保留的未知字段": "Unknown fields kept unchanged", "使用安全默认值": "Safe defaults applied",
  "已有角色匹配": "Existing character matches", "发现已有角色": "Existing character found",
  "可打开既有角色、导入独立副本，或用当前卡片替换。替换会保留既有故事和角色 ID。": "Open the existing character, import a separate copy, or replace it with this card. Replacement preserves its stories and character ID.",
  "相同卡片内容": "Identical card content", "名称相同": "Same name", "打开既有角色": "Open existing character", "用当前卡片替换": "Replace with this card",
  "重新检查角色匹配": "Check matches again", "正在保存…": "Saving…", "导入独立副本": "Import separate copy", "确认导入": "Confirm import", "跳过此文件": "Skip this file", "取消整批": "Cancel batch", "取消": "Cancel",
  "未填写人物简介。": "No character description.", "角色操作": "Character actions", "导出 JSON": "Export JSON", "导出 PNG": "Export PNG", "导出 CHARX": "Export CHARX",
  "JSON 不包含随卡附件。PNG 会保存内嵌资产，但资产路径受 PNG 文本块长度和 Latin-1 编码限制；完整迁移优先选择 CHARX。": "JSON excludes attachments. PNG keeps embedded assets, but asset paths are limited by PNG text chunk length and Latin-1 encoding. Choose CHARX for a complete transfer.",
  "角色设定": "Character details", "编辑角色": "Edit character", "性格": "Personality", "场景": "Scenario", "标签": "Tags", "未填写": "Not provided", "无": "None", "附属内容": "Extras", "已保存的附属内容": "Saved extras", "默认开场白": "Default greeting",
  "MYCOMPANION · 新手引导": "MYCOMPANION · Getting started", "只需要三步": "Three simple steps",
  "先导入角色，再连接模型。复杂设置可以稍后处理。": "Import a character, then connect a model. Advanced settings can wait.",
  "导入角色": "Import a character", "选择角色卡文件，先看完整预览。": "Choose a character card and review its full preview.",
  "连接模型": "Connect a model", "用自己的 API 服务完成连接检查。": "Test a connection to your API service.",
  "开始故事": "Start your story", "选择开场白，记忆和上下文由系统持续整理。": "Choose a greeting. The app keeps organizing memory and context as you chat.",
  "角色卡兼容": "Character card compatibility", "支持 Character Card V2/V3，包含世界书、备用开场白和常见正则扩展。": "Supports Character Card V2/V3, including world info, alternate greetings and common regex extensions.",
  "MYCOMPANION · 角色库": "MYCOMPANION · Characters", "我的角色": "My characters", "已保存角色": "Saved characters",
  "选择角色查看设定、世界书和正则，或开始新的故事。": "Choose a character to review its details, world info and regex rules, or start a new story.",
  "发现额外字段；系统会原样保留。": "Extra fields were found and will be kept unchanged.",
  "角色卡包含扩展数据，请在确认导入前检查。": "This card includes extension data. Review it before confirming the import.",
  "世界书会随角色保存，之后可在世界书面板中选择启用。": "World info is saved with the character. You can enable it in the world info panel.",
  "卡内正则会随角色保存，之后可在正则面板中选择启用。": "Regex rules are saved with the character. You can enable them in the regex panel.",
  "卡片声明的外部资产不会自动下载；PNG 或 CHARX 内嵌文件可随卡片导入。": "External assets listed in the card are not downloaded automatically. Files embedded in PNG or CHARX can be imported with the card.",
  "角色卡包含群聊开场白；单角色聊天暂不使用。": "This card includes group greetings, which are not used for single-character chat.",
  "部分社区卡字段缺失；系统将使用安全默认值，并保留原始数据。": "Some community card fields are missing. Safe defaults will be applied and the original data kept.",
  "旧格式会转换为 V2，原字段与未知字段保留；请检查预览。": "The older format will be converted to V2. Original and unknown fields are kept; review the preview.",
  "角色卡预览失败，请重试这个文件。": "Could not preview this character card. Retry this file.", "保存角色失败，请重试这个文件。": "Could not save this character. Retry this file.",
  "请选择要替换的既有角色。": "Choose the existing character to replace.", "无法打开既有角色，请重试。": "Could not open the existing character. Please retry.", "无法读取角色列表，请重试。": "Could not load the character list. Please retry.",
  "角色卡超过 20 MiB，无法导入。": "This character card exceeds 20 MiB and cannot be imported.",
  "这张 JPEG 图片没有检测到 CHARX 数据。请选择包含角色设定的卡片文件。": "No CHARX data was found in this JPEG image. Choose a card containing character data.",
  "无法识别这个文件。请选择有效的 PNG、JSON、YAML 或 CHARX 角色卡。": "This file was not recognized. Choose a valid PNG, JSON, YAML or CHARX character card.",
  "无法恢复之前的角色。": "Could not reopen the previous character.", "暂时无法读取角色列表。": "Could not load the character list.", "暂时无法读取角色详情。": "Could not load the character details.",
  "展开完整简介": "Read the full description", "HTML 开场白源码": "HTML greeting source",
  "卡内启用": "Enabled in card", "卡内停用": "Disabled in card", "（空内容）": "(Empty content)", "关键词": "Keywords", "触发": "Trigger", "常驻": "Always active", "正则关键词": "Regex keywords", "普通关键词": "Text keywords", "顺序": "Order",
  "已禁用": "Disabled", "（未提供查找表达式）": "(No search expression provided)", "卡内状态": "Card state", "停用": "Disabled", "启用": "Enabled", "作用阶段": "Stages", "未声明": "Not specified", "编辑时运行": "Run on edit", "是": "Yes", "否": "No",
  "显示文本（旧版）": "Display text (legacy)", "用户输入": "User input", "AI 输出": "AI output", "斜杠命令": "Slash commands", "推理内容": "Reasoning", "未知阶段": "Unknown stage",
};

export function libraryText(language: string, value: string): string {
  if (!language.startsWith("en")) {
    // Restrict formatting to application-generated count phrases. A number in
    // a character name or an unrecognized diagnostic remains original text.
    const counted = /^(?:逐文件导入 · \d+ \/ \d+|\d+ 项提醒|\d+ 世界书 · \d+ 正则|已保留 \d+ 条世界书和 \d+ 条正则规则|\d+ 项|（\d+）|\d+ 条 · (?:已保存，运行时未启用|导入后全部禁用))$/.test(value)
      || /^实际识别 \d+ 个(?:文件|故事)，/.test(value);
    return counted ? value.replace(/\d+/g, number => Number(number).toLocaleString("zh-CN")) : value;
  }
  if (Object.hasOwn(english, value)) return english[value]!;
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
