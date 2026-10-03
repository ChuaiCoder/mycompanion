import { characterDetailSchema, type CharacterDetail } from "@mycompanion/shared";
import { fetchCharacter } from "./api";
import { loadExtensionHost } from "./ExtensionHost";
import type { WorldInfoRuntime } from "./world-info-runtime";

export async function openCharacterWorldInfoEditor(character: CharacterDetail, runtime: WorldInfoRuntime,
  isCurrent: () => boolean): Promise<string | null> {
  // Runtime enable switches can have changed without reselecting the card.
  const latest = await fetchCharacter(character.id);
  if (!isCurrent()) return null;
  const primary = latest.rawExtensions.world;
  const bound = typeof primary === "string" && runtime.world_names.includes(primary);
  let name: string | null = null;
  if (!bound) {
    const path = "/scripts/popup.js";
    const { Popup } = await import(/* @vite-ignore */ path);
    name = await Popup.show.input("编辑随卡世界书", "给世界书取一个名称。保存后会绑定到当前角色，原始随卡内容和启用状态会保留。", `${latest.name}的世界书`);
    if (name === null || !isCurrent()) return null;
  }
  const response = await fetch(`/api/characters/${encodeURIComponent(latest.id)}/worldinfo/edit`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedUpdatedAt: latest.updatedAt, ...(name === null ? {} : { name }) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.error?.message === "string" ? result.error.message : "无法打开角色世界书，请重试。");
  const updated = characterDetailSchema.parse(result.character);
  if (typeof result.name !== "string") throw new Error("世界书名称无效，请重新打开。");
  await runtime.updateWorldInfoList();
  await loadExtensionHost();
  const path = "/plugin-runtime/characters.js";
  const characters = await import(/* @vite-ignore */ path);
  // getOneCharacter merges remote changes with existing host/editor drafts.
  await characters.getOneCharacter(updated.avatar);
  return isCurrent() ? result.name : null;
}
