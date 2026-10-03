import type { TokenAccounting } from "@mycompanion/shared";

const tokenReasons: Record<TokenAccounting["reasons"][number], readonly [string, string]> = {
  "message-framing": ["消息框架和角色标记为估算，提供商可能采用不同的计算方式。", "Message framing and role markers are estimated; your provider may count them differently."],
  "unknown-model": ["模型的分词规则未知，文本使用兼容估算。", "This model's tokenizer is unknown; text uses a compatibility estimate."],
  "unsupported-text-encoding": ["此文本分词方式尚未支持，使用兼容估算。", "This text encoding is not supported; a compatibility estimate is used."],
  "image-rule-estimate": ["图片按兼容规则估算，实际值由提供商决定。", "Images use a compatibility estimate; the provider determines the actual count."],
  "unknown-image-size": ["部分图片尺寸未知，图片计数不完整。", "Some image dimensions are unknown; image counts are incomplete."],
  "unknown-image-model": ["此模型的图片计数规则未知。", "This model's image counting rules are unknown."],
  "audio-not-counted": ["音频尚未计入本地估算。", "Audio is not included in the local estimate."],
  "unsupported-content-part": ["部分内容类型尚未计入本地估算。", "Some content types are not included in the local estimate."],
  "tool-schema-estimate": ["工具定义按兼容规则估算。", "Tool definitions use a compatibility estimate."],
  "response-format-estimate": ["响应格式定义按兼容规则估算。", "Response format definitions use a compatibility estimate."],
};
export const tokenReasonText = (reason: TokenAccounting["reasons"][number], language: string) => tokenReasons[reason][language.startsWith("en") ? 1 : 0];

const memoryEnglish: Record<string, string> = {
  "重试读取记忆": "Retry loading memories", "无法读取阶段摘要，请重试。": "Could not load the story summary. Please retry.", "重试读取阶段摘要": "Retry loading the summary", "最终提示词预算裁剪，未发送到模型。": "Removed to fit the final prompt budget; not sent to the model.",
  "记忆": "Memory", "事实": "Fact", "状态": "State", "目标": "Goal", "关系": "Relationship",
  "本故事": "This story", "角色共享": "Shared by character", "用户全局": "All stories", "生效中": "Active", "待确认": "Needs review", "已被取代": "Superseded", "已停用": "Disabled", "来源不可达": "Source unavailable",
  "重复表述": "Duplicate", "互相矛盾": "Conflicting", "状态随时间变化": "Changed over time", "独立事实": "Independent fact", "关系未确定": "Relationship uncertain",
  "按范围筛选": "Filter by scope", "按类型筛选": "Filter by type", "按状态筛选": "Filter by status", "全部范围": "All scopes", "全部类型": "All types", "全部状态": "All statuses",
  "系统会自动从对话中提取值得记住的信息（写入“本故事”范围），并可在相关对话出现时注入提示词。分支回滚会使来源不可达的记忆暂停注入，回到原分支自动恢复。": "The app extracts useful information into this story's memory and recalls it in relevant conversations. Memories with unavailable sources pause when you change branches and resume on their original branch.",
  "重要度": "Importance", "固定": "Pin", "取消固定": "Unpin", "采用并替代关联记忆": "Accept and replace related memories", "恢复这条记忆": "Restore this memory", "停用": "Disable", "启用": "Enable", "恢复上一版本": "Restore previous version", "删除": "Delete", "编辑记忆": "Edit memory", "编辑": "Edit", "保存": "Save", "取消": "Cancel",
  "已由你手动更正或采用，自动提取会保留这条记忆。": "You corrected or accepted this memory. Automatic extraction will preserve it.",
  "尚未用于对话。采用后，关联的生效记忆会保留为被替代版本。": "Not used in chat yet. Accepting it keeps related active memories as superseded versions.",
  " · 已固定": " · Pinned", " · 人工更正": " · Corrected", "关联记忆不在当前列表，可切换筛选查看。": "The related memory is outside this list. Change the filters to view it.", "原提取依据中的变化原文：": "Change quoted from the original evidence: ",
  "这个故事还没有记忆；继续对话后会自动提取。": "This story has no memories yet. They are extracted as you keep chatting.",
  "无法读取记忆，请重试。": "Could not load memories. Please retry.", "正在读取记忆…": "Loading memories…", "无法更新记忆，请重试。": "Could not update this memory. Please retry.", "无法恢复上一版本，请重试。": "Could not restore the previous version. Please retry.", "无法删除记忆，请重试。": "Could not delete this memory. Please retry.",
  "记忆检索测试失败，请重试。": "Memory retrieval failed. Please retry.", "无法更改自动摘要开关，请重试。": "Could not change automatic summaries. Please retry.", "无法保存摘要，请重试。": "Could not save the summary. Please retry.", "无法恢复摘要上一版本，请重试。": "Could not restore the previous summary. Please retry.",
  "检索测试器": "Test memory retrieval", "对示例文本跑一次检索，看看哪些记忆会被注入，不会修改真实聊天。": "Test which memories would be included for sample text. This does not change your chat.", "检索测试文本": "Retrieval test text", "我们现在在哪里？": "Where are we now?", "正在检索…": "Retrieving…", "运行检索": "Run retrieval", "还没有可检索的记忆。": "No memories are available for retrieval yet.", "（无内容）": "(No content)", "已注入": "Included", "未注入": "Not included", "得分": "Score", "注入内容：": "Included content: ", "（本轮没有注入）": "(No memories included)",
  "阶段摘要": "Story summary", "自动摘要：": "Automatic summaries: ", "开": "On", "关": "Off", "摘要压缩较早的剧情以节省上下文；摘要失败不会阻塞聊天。": "Summaries compress earlier events to save context. A failed summary does not interrupt chat. ", "尚未生成；对话足够长后自动生成。": "Not created yet. A summary is generated when the conversation is long enough.", "来源已改变，需重新生成或校正；这份摘要暂不用于对话。": "The source changed. Regenerate or correct this summary; it is not currently used in chat.", "阶段摘要内容": "Story summary content", "保存摘要": "Save summary",
  "这条记忆从以下对话提取；可查看原文后使用“编辑”更正。": "This memory was extracted from the messages below. Read them and use Edit to make corrections.", "来源不在当前分支；打开仍存在的来源分支可查看原文。": "The source is on another branch. Open its available branch to read the original message.", "已被另一条记忆取代：": "Replaced by another memory: ", "替代记忆不在当前列表中，可切换状态筛选查看。": "The replacement is outside this list. Change the status filter to view it.", "上次内容：": "Previous content: ", "未记录来源消息。": "No source messages were recorded.", "来源无法访问：": "Source unavailable: ", "正在读取来源…": "Loading sources…", "来源故事：": "Source story: ", "用户": "User", "跳到原始消息": "Go to original message", "来源消息已删除或不可访问。": "The source message was deleted or is unavailable.", "无法读取来源故事。": "Could not load the source story.", "故事不存在。": "The story does not exist.",
  "高级检索诊断": "Advanced retrieval diagnostics", "本次检索方式": "Retrieval method", "关键词与向量": "Keywords and vectors", "关键词": "Keywords", "向量模型": "Embedding model", "索引进度": "Index progress", "相似度阈值": "Similarity threshold",
  "Embedding 配置或凭据不可用，已使用关键词检索。": "Embedding settings or credentials are unavailable. Keywords were used.", "未指定 Embedding 模型，已使用关键词检索。": "No embedding model is assigned. Keywords were used.", "没有待检索的普通记忆；固定记忆使用独立预算。": "No ordinary memories need retrieval. Pinned memories use a separate budget.", "当前提供商不支持 Embedding，已使用关键词检索。": "This provider does not support embeddings. Keywords were used.", "Embedding 索引失败；本次预览使用关键词且不写入索引。": "Embedding indexing failed. This preview uses keywords and does not write the index.", "Embedding 索引失败，正在重试；本轮使用关键词检索。": "Embedding indexing failed and is retrying. This turn uses keywords.", "语义索引尚未建立；本次预览使用关键词且不写入索引。": "The semantic index is not ready. This preview uses keywords and does not write the index.", "正在建立语义索引，本轮使用关键词检索。": "The semantic index is being built. This turn uses keywords.", "Embedding 请求失败，本轮已降级为关键词检索。": "The embedding request failed. This turn falls back to keywords.",
  "来源消息不再可达（分支回滚），暂停注入；回到原分支可恢复。": "The source is unavailable on this branch. This memory is paused until you return to its original branch.", "已被新记忆取代，保留历史不再注入。": "Replaced by a newer memory; kept in history and not included.", "已停用。": "Disabled.", "待确认记录，不自动注入（FR-MEM-004）。": "This memory needs your review and is not included automatically.", "本轮上下文未命中记忆内容。": "This turn's context did not match the memory.", "用户固定记忆：无需关键词命中，使用独立预算。": "Pinned by you; no keyword match is required and a separate budget is used.", "超过单轮注入条数上限。": "The maximum number of included memories for this turn was reached.", "固定记忆独立预算注入。": "Included using the separate pinned-memory budget.",
};
/** Translate only known application diagnostics; preserve user/model prose. */
export function memoryText(language: string, value: string): string {
  if (!language.startsWith("en")) return value;
  if (Object.hasOwn(memoryEnglish, value)) return memoryEnglish[value]!;
  let match = /^关键词与语义联合检索；(\d+)\/(\d+) 条普通记忆已索引(；语义查询使用末尾 8,000 字符)?。$/.exec(value);
  if (match) return `Keywords and semantic retrieval; ${match[1]}/${match[2]} ordinary memories indexed${match[3] ? "; the semantic query uses the last 8,000 characters" : ""}.`;
  match = /^关键词命中：(.+)；相关度 (\d+)%。$/.exec(value);
  if (match) return `Matched keywords: ${match[1]}; relevance ${match[2]}%.`;
  match = /^语义匹配：余弦相似度 ([\d.-]+)；关键词未命中。$/.exec(value);
  if (match) return `Semantic match: cosine similarity ${match[1]}; no keyword match.`;
  match = /^超出 (\d+) token (固定|检索)记忆预算被舍弃（约 (\d+) token）。$/.exec(value);
  if (match) return `Excluded from the ${match[2] === "固定" ? "pinned" : "retrieved"} memory budget of ${match[1]} tokens (approximately ${match[3]} tokens).`;
  return value;
}
