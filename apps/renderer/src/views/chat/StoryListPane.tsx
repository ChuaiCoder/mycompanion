import type { ConversationSummary } from "@mycompanion/shared";

// 左侧故事列表：每段故事一行，预览为纯文本（plainPreview 已剥掉标记）。
export function StoryListPane({
  conversations,
  activeConversationId,
  onOpenConversation,
}: {
  conversations: ConversationSummary[];
  activeConversationId: string | undefined;
  onOpenConversation: (id: string) => void;
}) {
  return (
    <aside className="story-list-pane" aria-label="故事列表">
      <header><h1>故事</h1>{conversations.length > 0 ? <small>{conversations.length} 段</small> : null}</header>
      {conversations.length === 0 ? <p className="panel-empty">选择角色并点击“开始对话”，这里会保存每一段故事。</p> : (
        <ul>{conversations.map((conversation) => <li key={conversation.id}><button data-conversation-id={conversation.id} aria-pressed={activeConversationId === conversation.id} onClick={() => onOpenConversation(conversation.id)} type="button"><span className="story-row__title"><strong>{conversation.title}</strong><small>{conversation.messageCount} 条</small></span><span className="story-row__preview">{conversation.lastMessagePreview || "尚无消息"}</span></button></li>)}</ul>
      )}
    </aside>
  );
}
