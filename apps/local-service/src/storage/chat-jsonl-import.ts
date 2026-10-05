import { randomUUID } from "node:crypto";
import type { RuntimeRepository } from "../persistence/runtime-repository.js";
import type { StoredCharacter } from "../character/character-repository.js";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
// Independent adapter for Tavern 1.19.0 JSONL and its Chub message shape. Parse
// every row before entering the existing atomic conversation restore path.
export function importChatJsonl(runtime: RuntimeRepository, character: StoredCharacter, bytes: Uint8Array, name: string): string {
  const lines = Buffer.from(bytes).toString("utf8").replace(/^\uFEFF/, "").split(/\r?\n/);
  while (lines.at(-1) === "") lines.pop();
  const records: unknown[] = lines.map(line => JSON.parse(line));
  const header = records.shift();
  if (!object(header) || !["user_name", "name", "chat_metadata"].some(key => Object.hasOwn(header, key))) throw new Error("Invalid JSONL chat header");
  if (header.chat_metadata !== undefined && !object(header.chat_metadata)) throw new Error("Invalid JSONL chat metadata");
  const id = randomUUID(), branchId = randomUUID(), now = new Date().toISOString();
  let parentMessageId: string | null = null;
  const messages = records.map((value, index) => {
    if (!object(value)) throw new Error(`Invalid JSONL message ${index + 1}`);
    const raw = structuredClone(value);
    if (object(raw.mes) && Object.hasOwn(raw.mes, "message")) raw.mes = raw.mes.message;
    if (Array.isArray(raw.swipes)) raw.swipes = raw.swipes.map(swipe => object(swipe) && Object.hasOwn(swipe, "message") ? swipe.message : swipe);
    if (typeof raw.mes !== "string") throw new Error(`Invalid JSONL message text ${index + 1}`);
    const messageId = randomUUID(), previous = parentMessageId;
    parentMessageId = messageId;
    const date = typeof raw.send_date === "string" ? Date.parse(raw.send_date) : NaN;
    return { id: messageId, branchId, parentMessageId: previous, role: raw.is_user ? "user" as const : "assistant" as const,
      content: raw.mes, status: "complete" as const, createdAt: Number.isFinite(date) ? new Date(date).toISOString() : now, extensionData: raw };
  });
  runtime.restoreConversation({ id, characterId: character.detail.id, characterName: character.detail.name,
    title: name.replace(/\.jsonl$/i, "") || "Imported chat", activeBranchId: branchId, createdAt: now, updatedAt: now,
    chatHeader: header, chatMetadata: object(header.chat_metadata) ? header.chat_metadata : {}, messages });
  return `${id}.jsonl`;
}
