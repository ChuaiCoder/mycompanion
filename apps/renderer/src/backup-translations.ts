const english: Record<string, string> = {
  "备份与恢复": "Backup and restore",
  "保存角色、全部故事分支、记忆、世界书、扩展和设置。API Key 不包含在备份里，换电脑后需要重新填写。": "Save characters, every story branch, memories, world info, extensions and settings. API keys are excluded; enter them again on another computer.",
  "导出完整备份": "Export full backup", "选择备份文件": "Choose backup file",
  "已开始下载完整备份。": "The full backup download has started.",
  "备份文件超过 500 MiB，请选择较小的备份。": "The backup exceeds 500 MiB. Choose a smaller backup.",
  "无法读取这个 JSON 文件，请选择 MyCompanion 导出的备份。": "Could not read this JSON file. Choose a backup exported by MyCompanion.",
  "备份格式或版本不受支持，请选择 MyCompanion 完整备份文件。": "This backup format or version is unsupported. Choose a MyCompanion full backup.",
  "操作失败，请重试。": "The operation failed. Please retry.",
  "备份时间": "Backup date", "遇到已有内容时": "When content already exists",
  "恢复冲突处理": "Restore conflict handling",
  "保留现在的内容，跳过重复项": "Keep current content and skip duplicates",
  "用备份覆盖重复项": "Overwrite duplicates with the backup",
  "备份未通过检查，不能恢复。": "This backup failed validation and cannot be restored.",
  "恢复预览": "Restore preview", "内容": "Content", "新增": "New", "覆盖": "Overwrite", "跳过": "Skip", "冲突": "Conflict",
  "角色": "Characters", "故事": "Stories", "记忆": "Memories", "已有提示词插件": "Existing prompt plugins", "代码扩展": "Code extensions",
  "扩展设置": "Extension settings", "用户头像": "User avatars", "世界书": "World info", "世界书设置": "World info settings",
  "已归档角色的故事": "Archived characters' stories", "模型连接与任务": "Model connections and tasks",
  "冲突项也将以备份为准。": "Conflicting items will also use the backup.",
  "确认恢复": "Confirm restore", "恢复完成，正在重新加载数据…": "Restore complete. Reloading data…",
  "正在检查备份…": "Checking backup…", "取消": "Cancel", "完整性校验失败": "Checksum verification failed",
};
/** Translate application labels and known diagnostics without changing file
 * names, imported content or unknown server error details. */
export function backupText(language: string, value: string): string {
  return language.startsWith("en") && Object.hasOwn(english, value) ? english[value]! : value;
}
export function backupTotals(language: string, totals: { new: number; overwrite: number; skip: number }): string {
  const format = new Intl.NumberFormat(language.startsWith("en") ? "en-US" : "zh-CN");
  const added = format.format(totals.new), overwritten = format.format(totals.overwrite), skipped = format.format(totals.skip);
  return language.startsWith("en") ? `Add ${added}, overwrite ${overwritten}, skip ${skipped}.`
    : `将新增 ${added} 项、覆盖 ${overwritten} 项、跳过 ${skipped} 项。`;
}
