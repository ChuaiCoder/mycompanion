export const POWER_USER_SETTINGS_KEY = "__mycompanion_power_user";

export const personaDescriptionPositions = {
  IN_PROMPT: 0, AFTER_CHAR: 1, TOP_AN: 2, BOTTOM_AN: 3, AT_DEPTH: 4, NONE: 9,
} as const;

export interface PersonaDescription {
  content: string;
  position: number;
  depth: number;
  role: number;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function getPersonaUserName(settings: Record<string, unknown>, chatMetadata: Record<string, unknown> = {}): string {
  const source = record(settings[POWER_USER_SETTINGS_KEY]);
  const personas = record(source?.personas);
  const locked = typeof chatMetadata.persona === "string" && personas?.[chatMetadata.persona] ? chatMetadata.persona : "";
  const selected = locked || (typeof source?.__selected_persona === "string" ? source.__selected_persona : "") ||
    (typeof source?.default_persona === "string" ? source.default_persona : "");
  return typeof personas?.[selected] === "string" && personas[selected].trim() ? personas[selected] as string : "User";
}

export function getPersonaDescription(settings: Record<string, unknown>, chatMetadata: Record<string, unknown> = {}): PersonaDescription | null {
  const stored = settings[POWER_USER_SETTINGS_KEY];
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
  const source = stored as Record<string, unknown>;
  const personas = record(source.personas);
  const locked = typeof chatMetadata.persona === "string" && personas?.[chatMetadata.persona] ? chatMetadata.persona : "";
  const selected = locked || (typeof source.__selected_persona === "string" ? source.__selected_persona : "") ||
    (typeof source.default_persona === "string" ? source.default_persona : "");
  const descriptor = record(record(source.persona_descriptions)?.[selected]);
  const content = selected
    ? typeof descriptor?.description === "string" ? descriptor.description.trim() : ""
    : typeof source.persona_description === "string" ? source.persona_description.trim() : "";
  if (!content) return null;
  const number = (value: unknown, fallback: number): number => value === undefined || value === null ? fallback : Number(value);
  const position = number(descriptor?.position ?? source.persona_description_position, personaDescriptionPositions.IN_PROMPT);
  const depth = number(descriptor?.depth ?? source.persona_description_depth, 2);
  const role = number(descriptor?.role ?? source.persona_description_role, 0);
  if (![0, 1, 2, 3, 4, 9].includes(position) || !Number.isInteger(depth) || depth < 0 || depth > 10000 || ![0, 1, 2].includes(role)) {
    throw new Error("用户人设描述的位置、深度或角色设置无效。");
  }
  // ST 1.19.0 setPersonaDescription migrates the deprecated AFTER_CHAR value.
  return { content, position: position === personaDescriptionPositions.AFTER_CHAR ? personaDescriptionPositions.IN_PROMPT : position, depth, role };
}
