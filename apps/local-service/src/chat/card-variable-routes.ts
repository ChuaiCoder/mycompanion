import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import {
  cardVariableMutationRequestSchema,
  cardVariablesResponseSchema,
  type CardVariablesResponse,
} from "@mycompanion/shared";
import { CardVariableStore } from "./card-variable-store.js";
import { sendError } from "../http-errors.js";

/**
 * 卡片脚本的变量接口（本应用自己的实现，与宏引擎的变量路径相互独立）。
 *
 * GET 返回合并视图与各级原始视图；POST 应用一次写入。
 * 能力黑名单由渲染端的能力桥负责，这里只保证数据语义正确。
 */
export function registerCardVariableRoutes(app: FastifyInstance, database: DatabaseSync): void {
  const store = new CardVariableStore(database);
  const conversationExists = (id: string): boolean =>
    database.prepare("SELECT 1 FROM conversations WHERE id = ? AND deleted_at IS NULL").get(id) !== undefined;

  const buildResponse = (conversationId: string): CardVariablesResponse => cardVariablesResponseSchema.parse({
    variables: store.readMerged(conversationId, { type: "chat", messageId: "latest" }),
    scopes: {
      global: store.readScope(conversationId, { type: "global" }),
      chat: store.readScope(conversationId, { type: "chat" }),
      character: store.readScope(conversationId, { type: "character" }),
      preset: store.readScope(conversationId, { type: "preset" }),
      message: store.readScope(conversationId, { type: "message" }),
    },
  });

  app.get<{ Params: { id: string } }>("/api/conversations/:id/variables", async (request, reply) => {
    if (!conversationExists(request.params.id)) {
      return sendError(reply, 404, "CONVERSATION_NOT_FOUND", "故事不存在。");
    }
    return reply.header("Cache-Control", "no-store").send(buildResponse(request.params.id));
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/conversations/:id/variables", async (request, reply) => {
    const conversationId = request.params.id;
    if (!conversationExists(conversationId)) {
      return sendError(reply, 404, "CONVERSATION_NOT_FOUND", "故事不存在。");
    }
    const parsed = cardVariableMutationRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_REQUEST", "变量写入请求无效。");
    // 写入：mutation 的 messageId 已是 string | undefined（schema 不接受 "latest"），
    // 省略时由存储层解析为当前激活分支的最后一条消息。
    try {
      store.commit(conversationId, parsed.data.mutation);
    } catch (error) {
      return sendError(reply, 409, "VARIABLE_WRITE_FAILED", error instanceof Error ? error.message : "变量写入失败。");
    }
    return buildResponse(conversationId);
  });
}
