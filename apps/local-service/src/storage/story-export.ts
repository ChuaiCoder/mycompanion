import type {
  ChatMessage,
  ConversationDetail,
  MemoryRecord,
  StageSummary,
  StoryExportJson,
} from "@mycompanion/shared";
import { storyExportJsonSchema } from "@mycompanion/shared";

/**
 * 故事导出（FR-DATA-002）。
 * - Markdown：人类可读的当前分支对话（含阶段摘要与故事记忆）。
 * - JSON：机器可读，包含完整消息树（全部分支，含 branchId/parentMessageId 链接）、
 *   当前分支、角色引用与时间信息。API Key 单独加密存储，不进入故事数据。
 */

export function buildStoryExportJson(input: {
  conversation: ConversationDetail;
  allBranchMessages: ChatMessage[];
  stageSummary?: StageSummary;
  memories: MemoryRecord[];
}): StoryExportJson {
  const { conversation, allBranchMessages, stageSummary, memories } = input;
  return storyExportJsonSchema.parse({
    format: "mycompanion-story",
    formatVersion: 1,
    conversation: {
      id: conversation.id,
      characterId: conversation.characterId,
      characterName: conversation.characterName,
      title: conversation.title,
      activeBranchId: conversation.activeBranchId,
      ...(conversation.chatMetadata === undefined ? {} : { chatMetadata: conversation.chatMetadata }),
      ...(conversation.chatHeader === undefined ? {} : { chatHeader: conversation.chatHeader }),
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    },
    messages: allBranchMessages.map((message) => ({
      id: message.id,
      branchId: message.branchId,
      parentMessageId: message.parentMessageId,
      role: message.role,
      content: message.content,
      status: message.status,
      ...(message.extensionData === undefined ? {} : { extensionData: message.extensionData }),
      createdAt: message.createdAt,
    })),
    stageSummary: stageSummary?.content ?? null,
    // 只导出故事作用域记忆（FR-MEM-003）：角色共享/用户全局记忆不属于单个故事。
    memories: memories
      .filter((memory) => memory.scope === "story" && memory.conversationId === conversation.id)
      .map((memory) => ({
        id: memory.id,
        type: memory.type,
        content: memory.content,
        importance: memory.importance,
        status: memory.status,
        pinned: memory.pinned,
        createdAt: memory.createdAt,
      })),
  });
}

function escapeMarkdownLine(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function buildStoryExportMarkdown(input: {
  conversation: ConversationDetail;
  branchMessages: ChatMessage[];
  stageSummary?: StageSummary;
  memories: MemoryRecord[];
}): string {
  const { conversation, branchMessages, stageSummary, memories } = input;
  const lines: string[] = [];
  lines.push(`# ${conversation.title}`);
  lines.push("");
  lines.push(`- 角色：${conversation.characterName}（${conversation.characterId}）`);
  lines.push(`- 当前分支：${conversation.activeBranchId}`);
  lines.push(`- 故事创建时间：${conversation.createdAt}`);
  lines.push(`- 故事最后更新：${conversation.updatedAt}`);
  lines.push(`- 导出时间：${new Date().toISOString()}`);
  if (stageSummary) {
    lines.push("");
    lines.push("## 阶段摘要");
    lines.push("");
    lines.push(escapeMarkdownLine(stageSummary.content));
  }
  const storyMemories = memories.filter(
    (memory) => memory.scope === "story" && memory.conversationId === conversation.id,
  );
  if (storyMemories.length > 0) {
    lines.push("");
    lines.push("## 故事记忆");
    lines.push("");
    for (const memory of storyMemories) {
      lines.push(`- [${memory.type}${memory.status !== "active" ? `/${memory.status}` : ""}${memory.pinned ? "（固定）" : ""}] ${escapeMarkdownLine(memory.content).replace(/\n/g, " ")}`);
    }
  }
  lines.push("");
  lines.push("## 对话");
  lines.push("");
  for (const message of branchMessages) {
    const label = message.role === "user" ? "你" : conversation.characterName;
    const status =
      message.status === "failed" ? "（生成失败）"
      : message.status === "stopped" ? "（已停止）"
      : message.status === "streaming" ? "（生成中）"
      : "";
    lines.push(`**${label}**${status}`);
    lines.push("");
    lines.push(escapeMarkdownLine(message.content));
    lines.push("");
  }
  lines.push(`<!-- mycompanion-story export, format-version 1, exported ${new Date().toISOString()} -->`);
  return lines.join("\n");
}
