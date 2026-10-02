/**
 * Field mappings adapted from SillyTavern 1.19.0 importFromJson and
 * convertToV2/charaFormatData, AGPL-3.0-only, SillyTavern contributors.
 * See apps/local-service/character-assets-upstream.json. File identities and
 * runtime flags are managed by the desktop host, not upstream filesystem code.
 */
export function convertLegacyCharacterCard(input: unknown): { card: unknown; format: "tavern-v1-json" | "pygmalion-json" } | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string,unknown>;
  // A declared V2/V3 card must be validated as declared, never downgraded.
  if (raw.spec !== undefined) return null;
  const pygmalion = raw.name === undefined && typeof raw.char_name === "string";
  if (typeof raw.name !== "string" && !pygmalion) return null;
  const object = (value: unknown): Record<string,unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string,unknown> : {};
  const text = (value: unknown): string => typeof value === "string" ? value : "";
  const tags = typeof raw.tags === "string" ? raw.tags.split(",").map(value=>value.trim()).filter(Boolean) : raw.tags ?? [];
  const oldData = object(raw.data), extensions = { ...object(oldData.extensions), ...object(raw.extensions) };
  if (raw.talkativeness !== undefined) extensions.talkativeness = raw.talkativeness;
  if (raw.depth_prompt_prompt !== undefined || raw.depth_prompt_depth !== undefined || raw.depth_prompt_role !== undefined)
    extensions.depth_prompt = { ...object(extensions.depth_prompt), prompt:text(raw.depth_prompt_prompt), depth:raw.depth_prompt_depth ?? 4, role:raw.depth_prompt_role ?? "system" };
  const data = {
    ...oldData,
    name: pygmalion ? raw.char_name : raw.name,
    description: text(pygmalion ? raw.char_persona : raw.description),
    personality: pygmalion ? "" : text(raw.personality),
    scenario: text(pygmalion ? raw.world_scenario : raw.scenario),
    first_mes: text(pygmalion ? raw.char_greeting : raw.first_mes),
    mes_example: text(pygmalion ? raw.example_dialogue : raw.mes_example),
    creator_notes: text(raw.creatorcomment ?? raw.creator_notes),
    system_prompt:text(raw.system_prompt), post_history_instructions:text(raw.post_history_instructions),
    alternate_greetings: typeof raw.alternate_greetings === "string" ? [raw.alternate_greetings] : raw.alternate_greetings ?? [],
    tags, creator:text(raw.creator), character_version:text(raw.character_version), extensions,
    ...(raw.character_book !== undefined ? {character_book:raw.character_book} : {}),
  };
  // Retain the original root fields, including foreign application metadata.
  return {card:{...raw,spec:"chara_card_v2",spec_version:"2.0",data},format:pygmalion?"pygmalion-json":"tavern-v1-json"};
}
