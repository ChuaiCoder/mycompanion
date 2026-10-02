import { parse as parseYaml } from "yaml";
import { CharacterCardParseError, parseCharacterCardDocument, type ParsedCharacterCard } from "@mycompanion/character-card";

/** Mapping adapted from fixed SillyTavern importFromYaml (AGPL-3.0-only). */
export function parseCharacterCardYaml(text: string): ParsedCharacterCard {
  let document: unknown;
  try { document = parseYaml(text,{uniqueKeys:true,maxAliasCount:100}); }
  catch (error) { throw new CharacterCardParseError("YAML 角色卡无法解析。",[error instanceof Error?error.message:String(error)]); }
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new CharacterCardParseError("YAML 角色卡必须是包含 name 的对象。");
  const raw=document as Record<string,unknown>;
  const card=raw.spec === undefined ? {...raw,description:raw.context??raw.description??"",first_mes:raw.greeting??raw.first_mes??""} : raw;
  const parsed=parseCharacterCardDocument(card);
  parsed.preview.format="tavern-yaml";
  return parsed;
}
