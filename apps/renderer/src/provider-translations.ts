const zh = {
  connections: "保存的模型连接", current: "聊天使用", advanced: "更多连接与任务模型", intro: "日常聊天只需要一个连接。可为摘要、记忆提取和语义检索分别选择模型。",
  edit: "编辑连接", new: "新增连接", name: "连接名称", address: "服务地址", model: "模型名称", source: "接口类型", online: "OpenAI 兼容接口", local: "Ollama 本地模型", anthropic: "Claude 原生接口", gemini: "Gemini 原生接口",
  key: "API Key", existingKey: "已保存；留空保留", optionalKey: "按服务商要求填写", clearKey: "移除已保存的密钥", save: "保存连接", remove: "删除连接", removing: "删除后相关任务恢复默认；当前聊天会切换到其他已保存连接。",
  tasks: "任务使用的模型", summary: "阶段摘要", extraction: "记忆提取", embedding: "语义检索 (Embedding)", sameChat: "使用聊天连接", keyword: "仅使用关键词检索", embeddingHelp: "Embedding 需要专用向量模型。未选择或请求失败时使用关键词检索，聊天继续正常运行。",
  saved: "连接已保存。", assigned: "任务模型已更新。", deleted: "连接已删除，任务已重新分配。", loading: "正在读取模型连接…", failed: "无法更新模型连接，请重试。", testChat: "测试聊天", testEmbedding: "测试 Embedding", selected: "当前聊天连接", temperature: "温度", response: "回复 token 上限", context: "上下文 token 上限",
};
const en: Record<keyof typeof zh, string> = {
  connections: "Saved model connections", current: "Chat connection", advanced: "More connections and task models", intro: "One connection is enough for chat. You can choose separate models for summaries, memory extraction, and semantic retrieval.",
  edit: "Edit connection", new: "Add connection", name: "Connection name", address: "API address", model: "Model name", source: "API type", online: "OpenAI compatible", local: "Local Ollama", anthropic: "Native Claude API", gemini: "Native Gemini API",
  key: "API Key", existingKey: "Saved; leave blank to keep", optionalKey: "As required by your provider", clearKey: "Remove saved key", save: "Save connection", remove: "Delete connection", removing: "Linked tasks will return to their defaults. Chat will switch to another saved connection.",
  tasks: "Task models", summary: "Stage summary", extraction: "Memory extraction", embedding: "Semantic retrieval (Embedding)", sameChat: "Use chat connection", keyword: "Keyword retrieval only", embeddingHelp: "Embedding needs a dedicated vector model. Unconfigured or failed requests use keyword retrieval; chat continues.",
  saved: "Connection saved.", assigned: "Task models updated.", deleted: "Connection deleted and tasks reassigned.", loading: "Loading model connections…", failed: "Could not update the model connection. Please retry.", testChat: "Test chat", testEmbedding: "Test Embedding", selected: "Current chat connection", temperature: "Temperature", response: "Reply token limit", context: "Context token limit",
};
export const providerCopy = (language: string): Record<keyof typeof zh, string> => language.startsWith("en") ? en : zh;
