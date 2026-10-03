import multipart from "@fastify/multipart";
import deepmerge from "@fastify/deepmerge";
import sanitize from "sanitize-filename";
import { createRequire } from "node:module";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { CharacterCardParseError, encodeCharacterCardPng, parseCharacterCardDocument, type CharacterCard } from "@mycompanion/character-card";
import { toExtensionChatState, type WorldInfoDocument } from "@mycompanion/shared";
import type { CharacterRepository, StoredCharacter } from "./character-repository.js";
import type { RuntimeRepository } from "./runtime-repository.js";
import { mainIconPath, characterAssetContentType } from "./character-archive.js";
import { importChatJsonl } from "./chat-jsonl-import.js";

const merge = deepmerge({ mergeArray: () => (_target, source) => structuredClone(source) });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, fallback = ""): string => typeof value === "string" ? value : fallback;
function invalid(message: string): never { throw Object.assign(new Error(message), { statusCode: 400 }); }
function jsonObject(value: unknown, label: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = typeof value === "string" ? JSON.parse(value) : value; } catch { return invalid(`${label} is not valid JSON`); }
  if (!object(parsed)) return invalid(`${label} must be an object`);
  return parsed;
}

// This projection exposes effective runtime switches, without throwing away the
// original card's unknown metadata. The SQL identity never comes from a path.
export function toTavernCharacter(stored: StoredCharacter, chat?: string) {
  const card = structuredClone(stored.rawCard), detail = stored.detail;
  delete card.json_data;
  const data = card.data;
  if (Array.isArray(data.extensions.regex_scripts)) data.extensions.regex_scripts = data.extensions.regex_scripts.map((rule: unknown, index: number) => {
    if (!object(rule)) return rule;
    const state = detail.regexEnabled.find(item => item.order === (rule.order ?? index));
    return state ? { ...rule, disabled: state.disabled } : rule;
  });
  data.character_book?.entries.forEach((entry, index) => { entry.enabled = detail.lorebookEnabled[index]?.enabled ?? false; });
  const result = {
    ...card, id: detail.id, avatar: detail.avatar ?? `${detail.id}.png`, name: data.name,
    description: data.description, personality: data.personality, scenario: data.scenario,
    first_mes: data.first_mes, mes_example: data.mes_example, creatorcomment: data.creator_notes,
    tags: data.tags, talkativeness: data.extensions.talkativeness ?? 0.5, fav: data.extensions.fav ?? false,
    chat: chat ?? text(card.chat, detail.id), create_date: text(card.create_date, detail.createdAt),
    date_added: Date.parse(detail.createdAt), date_last_chat: 0,
  };
  // json_data is a form snapshot, not recursively persisted into the card.
  return { ...result, json_data: JSON.stringify(card) };
}

function characterBook(name: string, book: WorldInfoDocument) {
  const aliases: Record<string, string> = {
    scanDepth: "scan_depth", matchWholeWords: "match_whole_words", caseSensitive: "case_sensitive",
    ignoreBudget: "ignore_budget", excludeRecursion: "exclude_recursion", preventRecursion: "prevent_recursion",
    delayUntilRecursion: "delay_until_recursion", outletName: "outlet_name", groupOverride: "group_override",
    groupWeight: "group_weight", useGroupScoring: "use_group_scoring", automationId: "automation_id",
    displayIndex: "display_index", matchPersonaDescription: "match_persona_description",
    matchCharacterDescription: "match_character_description", matchCharacterPersonality: "match_character_personality",
    matchCharacterDepthPrompt: "match_character_depth_prompt", matchScenario: "match_scenario", matchCreatorNotes: "match_creator_notes",
  };
  return { ...(object(book.originalData) ? book.originalData : {}), name, entries: Object.entries(book.entries).map(([key, entry]) => ({
    id: entry.uid ?? key, keys: entry.key ?? [], secondary_keys: entry.keysecondary ?? [], content: entry.content ?? "",
    comment: entry.comment ?? "", constant: entry.constant ?? false, selective: entry.selective ?? true,
    insertion_order: entry.order ?? 100, enabled: entry.disable !== true, use_regex: true,
    position: entry.position === 0 ? "before_char" : "after_char",
    extensions: { ...(object(entry.extensions) ? entry.extensions : {}),
      ...Object.fromEntries(Object.entries(entry).filter(([field]) => field !== "extensions").map(([field, value]) => [aliases[field] ?? field, value])) },
  })) };
}

async function readForm(request: FastifyRequest): Promise<{ fields: Record<string, unknown>; image?: Uint8Array; filename?: string }> {
  if (!request.isMultipart()) return { fields: jsonObject(request.body, "Character form") };
  const fields: Record<string, unknown> = Object.create(null);
  let image: Uint8Array | undefined, filename: string | undefined, total = 0;
  for await (const part of request.parts()) {
    if (part.type === "file") {
      const bytes = await part.toBuffer(); total += bytes.byteLength;
      if (part.fieldname !== "avatar" || image) invalid("Unexpected avatar upload");
      // Browsers include an empty file part for an unselected file input.
      if (bytes.length) image = bytes;
      filename = part.filename;
    } else {
      if (part.valueTruncated) invalid("Character field was truncated");
      total += Buffer.byteLength(typeof part.value === "string" ? part.value : JSON.stringify(part.value));
      const arrayKey = /^(alternate_greetings|tags)(?:\[\d*\])?$/.exec(part.fieldname)?.[1];
      if (arrayKey) {
        const values = fields[arrayKey] as unknown[] | undefined;
        const items = part.fieldname === "tags" && typeof part.value === "string"
          ? part.value.split(",").map(item => item.trim()).filter(Boolean) : [part.value];
        fields[arrayKey] = [...(values ?? []), ...items];
      } else {
        if (Object.hasOwn(fields, part.fieldname)) invalid(`Duplicate field: ${part.fieldname}`);
        fields[part.fieldname] = part.value;
      }
    }
    if (total > 500 * 1024 * 1024) throw Object.assign(new Error("Character upload is too large"), { statusCode: 413 });
  }
  return { fields, ...(image ? { image } : {}), ...(filename ? { filename } : {}) };
}

function makeCard(fields: Record<string, unknown>, runtime: RuntimeRepository, old?: StoredCharacter): CharacterCard {
  const base = old?.rawCard ?? { spec: "chara_card_v2", spec_version: "2.0", data: {
    name: "", description: "", personality: "", scenario: "", first_mes: "", mes_example: "", creator_notes: "",
    system_prompt: "", post_history_instructions: "", alternate_greetings: [], tags: [], creator: "", character_version: "", extensions: {},
  } };
  const card = structuredClone(fields.json_data === undefined ? base : jsonObject(fields.json_data, "json_data"));
  if (!object(card.data)) invalid("Character data is missing");
  delete card.json_data;
  const data = card.data;
  const mapping = { ch_name: "name", description: "description", personality: "personality", scenario: "scenario", first_mes: "first_mes",
    mes_example: "mes_example", creator_notes: "creator_notes", system_prompt: "system_prompt", post_history_instructions: "post_history_instructions",
    creator: "creator", character_version: "character_version" };
  for (const [field, key] of Object.entries(mapping)) if (Object.hasOwn(fields, field)) {
    if (typeof fields[field] !== "string") invalid(`${field} must be a string`);
    data[key] = fields[field];
  }
  if (!text(data.name).trim() || data.name === ".") invalid("Character name is empty");
  for (const key of ["tags", "alternate_greetings"]) if (Object.hasOwn(fields, key)) {
    const value = fields[key];
    data[key] = Array.isArray(value) ? value : typeof value === "string" ? key === "tags" ? value.split(",").map(item => item.trim()).filter(Boolean) : [value] : invalid(`${key} must be an array`);
  }
  // object-to-formdata omits empty arrays when the helper replaces greetings.
  if (Object.hasOwn(fields, "first_mes") && !Object.hasOwn(fields, "alternate_greetings")) data.alternate_greetings = [];
  const extensions = fields.extensions === undefined ? jsonObject(data.extensions ?? {}, "extensions")
    : fields.json_data === undefined ? jsonObject(fields.extensions, "extensions")
      : merge(jsonObject(data.extensions ?? {}, "extensions"), jsonObject(fields.extensions, "extensions"));
  data.extensions = extensions;
  if (Object.hasOwn(fields, "fav")) extensions.fav = fields.fav === true || fields.fav === "true";
  if (Object.hasOwn(fields, "talkativeness")) {
    const value = Number(fields.talkativeness); if (!Number.isFinite(value)) invalid("Invalid talkativeness"); extensions.talkativeness = value;
  }
  if (Object.hasOwn(fields, "world")) {
    if (typeof fields.world !== "string") invalid("world must be a string");
    extensions.world = fields.world;
    if (!fields.world && old?.rawCard.data.extensions.world) delete data.character_book;
    else { const book = runtime.worldInfo.get(fields.world); if (book) data.character_book = characterBook(fields.world, book); }
  }
  for (const field of ["chat", "create_date"]) if (typeof fields[field] === "string") card[field] = fields[field];
  // Keep legacy top-level fields consistent when the imported card included them.
  for (const key of ["name", "description", "personality", "scenario", "first_mes", "mes_example", "tags"]) if (Object.hasOwn(card, key)) card[key] = data[key];
  if (Object.hasOwn(card, "creatorcomment")) card.creatorcomment = data.creator_notes;
  return parseCharacterCardDocument(card).card;
}

export function registerCharacterCompatibility(app: FastifyInstance, characters: CharacterRepository, runtime: RuntimeRepository): void {
  const lodash = createRequire(import.meta.url)("lodash") as { set(object: object, path: string, value: unknown): void };
  app.post<{ Body: { avatar_url: string; key: string; value: unknown } }>("/api/characters/extension-field", {
    bodyLimit: 500 * 1024 * 1024,
    schema: { body: { type: "object", required: ["avatar_url", "key", "value"], properties: { avatar_url: {type:"string"}, key: {type:"string",minLength:1} } } },
  }, async (request, reply) => {
    const stored = characters.getByAvatar(request.body.avatar_url);
    if (!stored) return reply.status(404).send({error:"Character not found"});
    const card = structuredClone(stored.rawCard);
    lodash.set(card.data.extensions, request.body.key, request.body.value);
    const regexFromCard = request.body.key === "regex_scripts" || request.body.key.startsWith("regex_scripts.") || request.body.key.startsWith("regex_scripts[");
    characters.update(stored.detail.id, card, {regexFromCard});
    return {ok:true};
  });
  app.register(async scoped => {
    await scoped.register(multipart, { limits: { fileSize: 500 * 1024 * 1024, fieldSize: 500 * 1024 * 1024, files: 1, fields: 1000, parts: 1001 } });
    scoped.setErrorHandler((error, _request, reply) => {
      const failure = error as Error & { statusCode?: number };
      return reply.code(error instanceof CharacterCardParseError ? 400 : failure.statusCode ?? 500).send({ error: { message: failure.message } });
    });
    const snapshot = (stored: StoredCharacter) => toTavernCharacter(stored, runtime.listConversations().items.find(item => item.characterId === stored.detail.id)?.id);
    scoped.post("/api/characters/all", async (_request, reply) => {
      const chats = new Map<string, string>();
      for (const conversation of runtime.listConversations().items) if (!chats.has(conversation.characterId)) chats.set(conversation.characterId, conversation.id);
      return reply.header("Cache-Control", "no-store").send(characters.list().items.map(item => toTavernCharacter(characters.getStored(item.id)!, chats.get(item.id))));
    });
    const byAvatar = (body: unknown) => {
      const fields = jsonObject(body, "Character request");
      if (typeof fields.avatar_url !== "string") return invalid("avatar_url is required");
      return characters.getByAvatar(fields.avatar_url);
    };
    scoped.post("/api/characters/get", async (request, reply) => {
      const stored = byAvatar(request.body);
      return stored ? reply.header("Cache-Control", "no-store").send(snapshot(stored)) : reply.code(404).send({ error: "Character not found" });
    });
    for (const action of ["create", "edit"] as const) scoped.post(`/api/characters/${action}`, { bodyLimit: 500 * 1024 * 1024 }, async (request, reply) => {
      const { fields, image } = await readForm(request);
      const previous = action === "edit" ? byAvatar(fields) : undefined;
      if (action === "edit" && !previous) return reply.code(404).send({ error: "Character not found" });
      const card = makeCard(fields, runtime, previous);
      if (image) encodeCharacterCardPng(card, image); // Validate before changing any row.
      if (action === "create") {
        const name = sanitize(text(fields.file_name, card.data.name)).replace(/\.png$/i, "");
        if (!name) return invalid("Character filename is empty");
        const avatar = characters.allocateAvatar(name);
        runtime.retainedChats.createWithRetainedChats(avatar, () => {
          const result = characters.import({ ...parseCharacterCardDocument(card), avatar, ...(image ? { sourcePng: image } : {}) }, "");
          // A character created through the editor follows the submitted switches.
          return characters.update(result.character.id, card, { regexFromCard: true, lorebookFromCard: true })!.detail;
        });
        return reply.type("text/plain").send(avatar);
      }
      const extensions = fields.extensions === undefined ? undefined : jsonObject(fields.extensions, "extensions");
      characters.update(previous!.detail.id, card, { ...(image ? { sourcePng: image } : {}),
        regexFromCard: !!extensions && Object.hasOwn(extensions, "regex_scripts"),
        lorebookFromCard: Object.hasOwn(fields, "world") || Object.hasOwn(fields, "json_data"),
      });
      return reply.type("text/plain").send("OK");
    });
    scoped.post("/api/characters/delete", async (request, reply) => {
      const stored = byAvatar(request.body), fields = jsonObject(request.body, "Character deletion");
      if (!stored) return reply.code(400).send({ error: "Character not found" });
      runtime.retainedChats.removeCharacter(stored.detail.id, stored.detail.avatar!, fields.delete_chats === true || fields.delete_chats === 1 || fields.delete_chats === "1");
      return reply.type("text/plain").send("OK");
    });
    scoped.get<{ Querystring: { type?: string; file?: string } }>("/thumbnail", async (request, reply) => {
      const stored = request.query.type === "avatar" ? characters.getByAvatar(request.query.file ?? "") : undefined;
      if (stored) {
        const path = mainIconPath(stored.rawCard), asset = path ? characters.assets.get(stored.detail.id,path) : undefined;
        if (asset) return reply.type(characterAssetContentType(path!)).header("Cache-Control","no-store").send(asset);
      }
      return stored ? reply.type("image/png").header("Cache-Control", "no-store").send(Buffer.from(encodeCharacterCardPng(stored.rawCard, stored.sourcePng)))
        : reply.code(404).send({ error: "Avatar not found" });
    });
    scoped.post("/api/characters/chats", async (request, reply) => {
      const stored = byAvatar(request.body);
      if (!stored) return reply.code(404).send({ error: "Character not found" });
      return runtime.listConversations().items.filter(item => item.characterId === stored.detail.id).map(item => ({
        file_name: `${item.id}.jsonl`, file_id: item.id, chat_name: item.title, mes: item.lastMessagePreview,
        chat_items: item.messageCount, last_mes: item.updatedAt,
      }));
    });
    scoped.post("/api/chats/get", async (request, reply) => {
      const stored = byAvatar(request.body), body = jsonObject(request.body, "Chat request");
      const conversation = runtime.getConversation(text(body.file_name).replace(/\.jsonl$/, ""));
      if (!stored || !conversation || conversation.characterId !== stored.detail.id) return reply.code(404).send({ error: "Chat not found" });
      const state = toExtensionChatState(conversation);
      const header = conversation.chatHeader && Object.keys(conversation.chatHeader).length
        ? { ...conversation.chatHeader, ...(Object.hasOwn(conversation.chatHeader, "chat_metadata") || Object.keys(state.metadata).length ? { chat_metadata: state.metadata } : {}) }
        : { user_name: "User", character_name: stored.detail.name, create_date: conversation.createdAt, chat_metadata: state.metadata };
      return [header, ...state.messages];
    });
    scoped.post("/api/chats/import", { bodyLimit: 500 * 1024 * 1024 }, async (request, reply) => {
      const { fields, image, filename } = await readForm(request);
      if (!image || typeof fields.avatar_url !== "string") return reply.code(400).send({ error: true });
      const stored = characters.getByAvatar(fields.avatar_url);
      if (!stored) return reply.code(404).send({ error: true });
      if (fields.file_type !== "jsonl") return reply.code(400).send({ error: true, message: "Only JSONL chat import is supported" });
      try {
        const fileName = importChatJsonl(runtime, stored, image, filename ?? "import.jsonl");
        return { res: true, fileNames: [fileName] };
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof Error && error.message.startsWith("Invalid JSONL")) return { error: true };
        throw error;
      }
    });
  });
}
