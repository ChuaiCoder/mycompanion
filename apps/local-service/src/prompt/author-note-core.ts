import type { ExtensionPrompt } from "@mycompanion/shared";

export interface AuthorNoteState {
  active: boolean;
  prompt: ExtensionPrompt | null;
}

/** Shared by native prompt assembly and the browser compatibility module. */
export function buildAuthorNotePrompt(
  metadata: Record<string, unknown>,
  settings: Record<string, unknown>,
  userTurns: number,
): AuthorNoteState {
  const note = settings.note && typeof settings.note === "object" && !Array.isArray(settings.note)
    ? settings.note as Record<string, unknown> : {};
  const number = (value: unknown, fallback: number): number => {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : fallback;
  };
  const interval = number(metadata.note_interval ?? note.defaultInterval, 1);
  const active = interval > 0 && userTurns > 0 && userTurns % interval === 0;
  if (!active) return { active: false, prompt: null };
  const value = String(metadata.note_prompt ?? note.default ?? "");
  const position = number(metadata.note_position ?? note.defaultPosition, 1);
  const depth = number(metadata.note_depth ?? note.defaultDepth, 4);
  const role = number(metadata.note_role ?? note.defaultRole, 0);
  if (![-1, 0, 1, 2].includes(position) || depth < 0 || depth > 10000 || ![0, 1, 2].includes(role)) {
    throw new Error("Author's Note 的位置、深度或角色设置无效。");
  }
  return { active: true, prompt: {
    key: "2_floating_prompt", value, position: position as ExtensionPrompt["position"],
    depth, role: role as ExtensionPrompt["role"], scan: Boolean(note.allowWIScan),
  } };
}
