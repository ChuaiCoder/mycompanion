import type { FastifyInstance } from "fastify";
import { characterDetailSchema, type CharacterDetail } from "@mycompanion/shared";

// 纯数据工厂：为不经过 HTTP 的 PromptManager/model-client 单元测试造一张最小角色卡。
export function productCardForTests(name: string): CharacterDetail {
  const time = new Date().toISOString();
  return { id: crypto.randomUUID(), name, description: "", personality: "", scenario: "", firstMessage: "", exampleDialogue: "",
    systemPrompt: "", postHistoryInstructions: "", creatorNotes: "", alternateGreetings: [], characterVersion: "", rawExtensions: {},
    lorebookEnabled: [], regexEnabled: [], tags: [], creator: "", sourceFormat: "ccv2-json", sourceVersion: "2.0", unknownFieldPaths: [],
    alternateGreetingsCount: 0, lorebookEntries: [], regexScripts: [], lorebookEntryCount: 0, regexScriptCount: 0,
    deletedAt: null, createdAt: time, updatedAt: time };
}

// 原生角色测试夹具：替代已删除的酒馆式 /api/characters/create、/api/characters/edit。
// 字段名保留酒馆风格（ch_name、first_mes……），内部走原生 import/commit + PUT 卡片接口，
// 让历史测试的改动量降到一行。
export interface TestCharacterInput {
  ch_name?: string;
  name?: string;
  first_mes?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  mes_example?: string;
  creator_notes?: string;
  system_prompt?: string;
  post_history_instructions?: string;
  alternate_greetings?: string[];
  tags?: string[];
  creator?: string;
  character_version?: string;
  extensions?: Record<string, unknown>;
}

function cardData(input: TestCharacterInput) {
  return {
    name: input.ch_name ?? input.name ?? "Test character",
    description: input.description ?? "",
    personality: input.personality ?? "",
    scenario: input.scenario ?? "",
    first_mes: input.first_mes ?? "",
    mes_example: input.mes_example ?? "",
    creator_notes: input.creator_notes ?? "",
    system_prompt: input.system_prompt ?? "",
    post_history_instructions: input.post_history_instructions ?? "",
    alternate_greetings: input.alternate_greetings ?? [],
    tags: input.tags ?? [],
    creator: input.creator ?? "Test",
    character_version: input.character_version ?? "",
    extensions: input.extensions ?? {},
  };
}

export async function createTestCharacter(app: FastifyInstance, input: TestCharacterInput): Promise<CharacterDetail> {
  const data = cardData(input);
  const response = await app.inject({
    method: "POST",
    url: "/api/characters/import/commit",
    payload: {
      filename: `${data.name}.json`,
      card: { spec: "chara_card_v2", spec_version: "2.0", data },
    },
  });
  if (response.statusCode !== 200 && response.statusCode !== 201) {
    throw new Error(`createTestCharacter failed: ${response.statusCode} ${response.body}`);
  }
  return characterDetailSchema.parse(response.json());
}

const EDIT_FIELD_MAPPING: Record<string, string> = {
  ch_name: "name", description: "description", personality: "personality", scenario: "scenario",
  first_mes: "first_mes", mes_example: "mes_example", creator_notes: "creator_notes",
  system_prompt: "system_prompt", post_history_instructions: "post_history_instructions",
};

export async function editTestCharacter(app: FastifyInstance, id: string, input: TestCharacterInput): Promise<CharacterDetail> {
  const exported = await app.inject({ method: "GET", url: `/api/characters/${encodeURIComponent(id)}/export?format=json` });
  if (exported.statusCode !== 200) throw new Error(`editTestCharacter export failed: ${exported.statusCode} ${exported.body}`);
  const card = exported.json<Record<string, unknown>>();
  const data = card.data as Record<string, unknown>;
  for (const [field, key] of Object.entries(EDIT_FIELD_MAPPING)) {
    if (Object.hasOwn(input, field)) data[key] = input[field as keyof TestCharacterInput];
  }
  for (const key of ["alternate_greetings", "tags"] as const) {
    if (Object.hasOwn(input, key)) data[key] = input[key];
  }
  if (input.extensions) data.extensions = { ...(data.extensions as object), ...input.extensions };
  // 与旧 edit 端点一致：替换主问候时清空备选问候（object-to-formdata 的空数组省略行为）。
  if (Object.hasOwn(input, "first_mes") && !Object.hasOwn(input, "alternate_greetings")) data.alternate_greetings = [];
  const response = await app.inject({
    method: "PUT",
    url: `/api/characters/${encodeURIComponent(id)}`,
    payload: { card },
  });
  if (response.statusCode !== 200) {
    throw new Error(`editTestCharacter PUT failed: ${response.statusCode} ${response.body}`);
  }
  return characterDetailSchema.parse(response.json());
}
