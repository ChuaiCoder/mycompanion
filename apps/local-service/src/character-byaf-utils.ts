import { CharacterCardParseError, encodeCharacterCardPng, parseCharacterCardDocument } from "@mycompanion/character-card";

// Project-owned 1px PNG; no upstream application image is copied.
export const defaultByafPortrait = Buffer.from(encodeCharacterCardPng(parseCharacterCardDocument({ name: "BYAF" }).card));
export function byafDate(value: unknown): string {
  if (value === undefined || value === null || value === "") return "1970-01-01T00:00:00.000Z";
  const numeric = typeof value === "number" || typeof value === "string" && /^\d+$/.test(value);
  const date = new Date(numeric ? Number(value) : String(value));
  if (!Number.isFinite(date.getTime())) throw new CharacterCardParseError("BYAF 消息包含无效时间。", [String(value)]);
  return date.toISOString();
}
export function byafChatStartDate(scenario: { messages?: Array<{ createdAt?: unknown; outputs?: Array<{ createdAt?: unknown }> }> }): string {
  const first = scenario.messages?.[0];
  return byafDate(first?.createdAt ?? first?.outputs?.[0]?.createdAt);
}
