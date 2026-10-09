import { characterDetailSchema, type CharacterDetail } from "@mycompanion/shared";
import { fetchCharacter, readApiPayload } from "./api";
import i18n from "./i18n";
import { listWorldInfoNames } from "./world-info-api";

// 把角色随卡世界书复制成命名世界书并绑定到角色（服务端原子完成），
// 成功后由调用方刷新列表并选中新书。
export async function openCharacterWorldInfoEditor(character: CharacterDetail,
  isCurrent: () => boolean): Promise<string | null> {
  // Runtime enable switches can have changed without reselecting the card.
  const latest = await fetchCharacter(character.id);
  if (!isCurrent()) return null;
  const primary = latest.rawExtensions.world;
  const bound = typeof primary === "string" && (await listWorldInfoNames()).includes(primary);
  let name: string | null = null;
  if (!bound) {
    name = window.prompt(i18n.t("给世界书取一个名称。保存后会绑定到当前角色，原始随卡内容和启用状态会保留。"), i18n.t("{{name}}的世界书", { name: latest.name }));
    if (name === null || !isCurrent()) return null;
  }
  const response = await fetch(`/api/characters/${encodeURIComponent(latest.id)}/worldinfo/edit`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedUpdatedAt: latest.updatedAt, ...(name === null ? {} : { name }) }),
  });
  const result = await readApiPayload(response) as { character?: unknown; name?: unknown };
  characterDetailSchema.parse(result.character);
  if (typeof result.name !== "string") throw new Error("世界书名称无效，请重新打开。");
  return isCurrent() ? result.name : null;
}
