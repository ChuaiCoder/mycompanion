import type { CharacterExportCheckResponse } from "@mycompanion/shared";
import type { StoredCharacter } from "./character-repository.js";

/**
 * 角色导出兼容性检查（FR-DATA-001）。
 * 导出前说明目标格式无法可靠表示、或第三方工具可能无法识别的字段与风险。
 * - JSON 导出：还原原始 V2/V3 卡，第三方编辑器可读取；风险集中在被本系统改写过的运行时状态
 *   （世界书/正则的启用集是本地概念，不写入卡内）与未被上游识别的未知字段。
 * - PNG 导出：把整张卡塞进 PNG 的 tEXt chunk，部分查看器会丢弃未知/扩展 chunk。
 */
export function checkCharacterExport(
  stored: StoredCharacter,
  format: "json" | "png" | "charx",
): CharacterExportCheckResponse {
  const warnings: string[] = [];
  const { detail, rawCard } = stored;

  // 未知字段：导入时未识别、被原样保留的字段。第三方工具可能不认识。
  if (detail.unknownFieldPaths.length > 0) {
    warnings.push(
      `卡内 ${detail.unknownFieldPaths.length} 个字段未被本系统识别，导出后原样保留，第三方工具可能忽略：${detail.unknownFieldPaths.slice(0, 5).join("、")}${detail.unknownFieldPaths.length > 5 ? " 等" : ""}。`,
    );
  }

  // 扩展字段（世界书/正则等）：导出会随卡保留，但目标工具的启用语义可能不同。
  const extensions = detail.rawExtensions;
  if (Array.isArray(extensions.character_book) && extensions.character_book.length > 0) {
    warnings.push(
      `世界书 ${detail.lorebookEntryCount} 条会随卡导出；本系统的“运行时启用/停用”是本地状态，不会写入卡内，导入到其它工具后需重新启用。`,
    );
  }
  if (Array.isArray(extensions.regex_scripts) && extensions.regex_scripts.length > 0) {
    warnings.push(
      `正则 ${detail.regexScriptCount} 条会随卡导出；本系统的“运行时启用/停用”是本地状态，不会写入卡内，导入到其它工具后需重新启用。`,
    );
  }

  if (format === "png") {
    warnings.push(
      "PNG 导出将角色卡及已导入资产写入 tEXt chunk；部分图片查看器/上传渠道会丢弃未知或过大的 chunk，完整资产迁移建议使用 CHARX。长路径或非 Latin-1 资产名称无法写入 PNG 时会明确报错。",
    );
    // 头像本身会保留；无头像时用默认图，提示一下。
    if (!stored.sourcePng) {
      warnings.push("该角色没有原图头像，PNG 导出会使用默认占位图。");
    }
  }

  // Remote URIs remain metadata; stored asset transport depends on the format.
  const spec = String((rawCard as { spec?: unknown }).spec ?? "");
  if (spec.includes("v3")) {
    warnings.push(format === "charx" ? "CHARX 随卡携带已导入的资产文件；远程资产只保留 URI，不自动下载。"
      : format === "png" ? "PNG 随卡携带已导入资产 chunk；远程 URI 原样保留、不自动下载。完整文件归档优先使用 CHARX。"
      : "JSON 不携带另外存储的资产文件；需要完整资产时请选择 CHARX。远程资产 URI 原样保留。");
  }

  if (warnings.length === 0) {
    warnings.push("未发现兼容性风险，目标格式可以完整表示这张卡。");
  }

  return { characterId: detail.id, warnings: warnings.slice(0, 50) };
}
