import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { parseCharacterCardDocument } from "@mycompanion/character-card";
import { buildApp } from "./app.js";
import { CharacterRepository } from "./character/character-repository.js";
import { RuntimeRepository } from "./persistence/runtime-repository.js";

// 分支功能前的旧库：conversations.active_branch_id 由迁移补列，默认 ''。
// 空值会让 /api/conversations 的 UUID 校验整体 500（真实用户库复现），
// 迁移必须把空分支回填为以对话 ID 命名的根分支（与消息侧回填一致）。

type App = ReturnType<typeof buildApp>;
const resources: Array<{ app: App; database: DatabaseSync; path: string }> = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.app.close(); resource.database.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(resource.path + suffix, { force: true });
  }
});

function setupLegacyConversation() {
  const path = join(tmpdir(), `conversation-branch-backfill-${randomUUID()}.sqlite`);
  const app = buildApp({ databasePath: path }), database = new DatabaseSync(path);
  const resource = { app, database, path }; resources.push(resource);
  const runtime = new RuntimeRepository(database), characters = new CharacterRepository(database);
  const card = parseCharacterCardDocument({ spec: "chara_card_v2", spec_version: "2.0", data: {
    name: "Backfill fixture", description: "Original MyCompanion regression fixture", first_mes: "Opening", personality: "",
    scenario: "", mes_example: "", creator_notes: "", system_prompt: "", post_history_instructions: "", alternate_greetings: [],
    tags: [], creator: "MyCompanion", character_version: "1", extensions: {},
  } });
  const character = characters.import(card, "backfill.json").character;
  const conversation = runtime.createConversation(character);
  runtime.addMessage(conversation.id, "user", "Legacy user message");
  runtime.addMessage(conversation.id, "assistant", "Legacy reply");
  // 模拟旧库：分支列存在但从未回填。
  database.prepare("UPDATE conversations SET active_branch_id = '' WHERE id = ?").run(conversation.id);
  return { app, database, conversation };
}

it("backfills empty legacy active_branch_id so the conversation list validates", async () => {
  const { app, database, conversation } = setupLegacyConversation();
  // 重新打开仓库触发迁移（与真实重启路径一致）。
  const reopened = new RuntimeRepository(database);
  const listing = reopened.listConversations();
  expect(listing.total).toBe(1);
  expect(listing.items[0]?.id).toBe(conversation.id);
  expect(listing.items[0]?.activeBranchId).toBe(conversation.id);
  expect(listing.items[0]?.messageCount).toBe(3);

  const response = await app.inject({ method: "GET", url: "/api/conversations" });
  expect(response.statusCode).toBe(200);
  expect(response.json().items[0]?.activeBranchId).toBe(conversation.id);
});

it("backfill keeps branch content readable through the conversation detail", async () => {
  const { app, database, conversation } = setupLegacyConversation();
  new RuntimeRepository(database);
  const response = await app.inject({ method: "GET", url: `/api/conversations/${conversation.id}` });
  expect(response.statusCode).toBe(200);
  const detail = response.json();
  expect(detail.activeBranchId).toBe(conversation.id);
  expect(detail.messages.map((message: { content: string }) => message.content)).toEqual(["Opening", "Legacy user message", "Legacy reply"]);
});
