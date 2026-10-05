import { useState, type ChangeEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";

import type { ConversationSummary } from "@mycompanion/shared";

import { Icon } from "../components";
import type { ModelConnection } from "../hooks/useModelConnection";
import { libraryText } from "../library-translations";
import type { WorkspaceView } from "../hooks/useExtensionResume";

// 侧栏对话分组：角色名作可折叠分组头（只留名字），下属该角色的各段故事。
interface ConversationGroup {
  characterId: string;
  characterName: string;
  items: ConversationSummary[];
}

function groupConversationsByCharacter(conversations: ConversationSummary[]): ConversationGroup[] {
  const groups: ConversationGroup[] = [];
  const index = new Map<string, ConversationGroup>();
  for (const conversation of conversations) {
    let group = index.get(conversation.characterId);
    if (!group) {
      group = { characterId: conversation.characterId, characterName: conversation.characterName, items: [] };
      index.set(conversation.characterId, group);
      groups.push(group);
    }
    group.items.push(conversation);
  }
  return groups;
}

// 桌面侧边栏：品牌行、主导航、按角色分组的对话列表、服务状态与隐藏的角色卡文件输入。
export function AppSidebar({
  collapsed,
  onCollapseToggle,
  view,
  memoryPanelOpen,
  onNavigate,
  onChatNav,
  onMemoryNav,
  busy,
  isImporting,
  onOpenFilePicker,
  conversationCount,
  pluginCount,
  memoryInjectedCount,
  conversations,
  activeConversationId,
  onOpenConversation,
  onDeleteConversation,
  modelConnection,
  fileInputRef,
  onCardFile,
}: {
  collapsed: boolean;
  onCollapseToggle: () => void;
  view: WorkspaceView;
  memoryPanelOpen: boolean;
  onNavigate: (view: WorkspaceView) => void;
  onChatNav: () => void;
  onMemoryNav: () => void;
  busy: boolean;
  isImporting: boolean;
  onOpenFilePicker: () => void;
  conversationCount: number;
  pluginCount: number;
  memoryInjectedCount: number | "";
  conversations: ConversationSummary[];
  activeConversationId: string | undefined;
  onOpenConversation: (id: string) => void;
  onDeleteConversation: (id: string) => Promise<boolean>;
  /** 模型连通性（启动检查一次），决定侧栏状态点显示什么。 */
  modelConnection: ModelConnection;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onCardFile: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  const { t, i18n } = useTranslation();
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());
  // 行内二次确认：先记下待删的故事，再由用户在行内确认或取消，不用弹窗。
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const groups = groupConversationsByCharacter(conversations);
  const toggleGroup = (characterId: string) => setCollapsedGroups(current => {
    const next = new Set(current);
    if (next.has(characterId)) next.delete(characterId); else next.add(characterId);
    return next;
  });
  const confirmDelete = async (id: string): Promise<void> => {
    setDeletingId(id);
    const deleted = await onDeleteConversation(id);
    setDeletingId(null);
    // 失败时保留确认态，让用户能重试或取消，而不是让行悄悄弹回。
    if (deleted) setPendingDeleteId(null);
  };
  return (
    <aside className="sidebar">
      <div className="brand-row">
        <button className="brand-button" onClick={() => onNavigate("chat")} type="button"><span aria-hidden="true" className="brand-mark">M</span><span className="brand-name">MyCompanion</span></button>
        <button aria-expanded={!collapsed} aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"} className="sidebar-collapse" onClick={onCollapseToggle} type="button">{collapsed ? "▣" : "◫"}</button>
      </div>
      <nav aria-label="主导航" className="primary-nav">
        <button className="nav-row nav-row--new" disabled={busy} onClick={onOpenFilePicker} type="button"><Icon name="plus" /><span>{t(isImporting ? "nav.reading" : "nav.import")}</span><kbd>Ctrl I</kbd></button>
        <button aria-current={view === "library" ? "page" : undefined} className={`nav-row ${view === "library" ? "nav-row--active" : ""}`} onClick={() => onNavigate("library")} type="button"><Icon name="character" /><span>{t("nav.library")}</span></button>
        <button aria-current={view === "chat" ? "page" : undefined} className={`nav-row ${view === "chat" ? "nav-row--active" : ""}`} onClick={onChatNav} type="button"><Icon name="book" /><span>{t("nav.chat")}</span><small>{conversationCount || ""}</small></button>
        <button aria-current={view === "plugins" ? "page" : undefined} className={`nav-row ${view === "plugins" ? "nav-row--active" : ""}`} onClick={() => onNavigate("plugins")} type="button"><Icon name="sparkles" /><span>{t("nav.plugins")}</span><small>{pluginCount || ""}</small></button>
        <button aria-current={view === "memory" ? "page" : undefined} className={`nav-row ${view === "memory" ? "nav-row--active" : ""}`} onClick={onMemoryNav} type="button"><Icon name="brain" /><span>{t("nav.memory")}</span><small>{view === "chat" ? memoryInjectedCount : ""}</small></button>
      </nav>
      <section aria-labelledby="sidebar-conversations-title" className="sidebar-library">
        <div className="tree-heading"><div><Icon name="book" size={16} /><h2 id="sidebar-conversations-title">{t("nav.chat")}</h2></div></div>
        {groups.length === 0 ? (
          <div className="tree-empty"><span>还没有对话</span><small>在角色库选择角色，开始第一段故事</small></div>
        ) : (
          <ul className="conversation-groups" aria-label="按角色分组的对话">
            {groups.map((group) => {
              const isCollapsed = collapsedGroups.has(group.characterId);
              return (
                <li key={group.characterId}>
                  <button aria-expanded={!isCollapsed} className="conversation-group__header" onClick={() => toggleGroup(group.characterId)} type="button"><Icon name="chevron" size={14} /><strong>{group.characterName}</strong></button>
                  {isCollapsed ? null : (
                    <ul className="conversation-group__items">
                      {group.items.map((conversation) => {
                        const isPending = pendingDeleteId === conversation.id;
                        const isDeleting = deletingId === conversation.id;
                        if (isPending) {
                          return (
                            <li key={conversation.id}>
                              <div className="conversation-confirm" role="group" aria-label={t("conversation.deleteConfirm", { title: conversation.title })}>
                                <span className="conversation-confirm__prompt">{t("conversation.deletePrompt")}</span>
                                <button className="conversation-confirm__danger" disabled={isDeleting} onClick={() => void confirmDelete(conversation.id)} type="button">{isDeleting ? t("conversation.deleting") : t("conversation.deleteConfirmAction")}</button>
                                <button className="conversation-confirm__cancel" disabled={isDeleting} onClick={() => setPendingDeleteId(null)} type="button">{t("conversation.deleteCancel")}</button>
                              </div>
                            </li>
                          );
                        }
                        return (
                          <li key={conversation.id} className="conversation-item">
                            <button data-conversation-id={conversation.id} aria-pressed={activeConversationId === conversation.id} className="conversation-row" onClick={() => onOpenConversation(conversation.id)} type="button"><span>{conversation.title}</span><small>{conversation.messageCount} 条</small></button>
                            <button aria-label={t("conversation.delete", { title: conversation.title })} className="conversation-delete" onClick={() => setPendingDeleteId(conversation.id)} type="button"><span aria-hidden="true">×</span></button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <footer className="sidebar-footer">
        <div className={`service-state service-state--${modelConnection.state}`} title={modelConnection.reason ?? undefined}><span aria-hidden="true" className="status-dot" /><span>{t("service." + modelConnection.state)}</span>{modelConnection.state === "online" && modelConnection.modelCount > 0 ? <small>{modelConnection.modelCount}</small> : null}</div>
        <button aria-label={t("nav.settings")} aria-pressed={view === "settings"} onClick={() => onNavigate("settings")} type="button"><Icon name="settings" size={18} /></button>
      </footer>
      <input ref={fileInputRef} multiple accept=".json,.png,.yaml,.yml,.charx,.zip,.byaf,.jpg,.jpeg,application/json,image/png,application/charx,application/zip,application/byaf,application/yaml,text/yaml" aria-label={libraryText(i18n.language, "选择角色卡文件")} className="visually-hidden-input" disabled={busy} onChange={onCardFile} type="file" />
    </aside>
  );
}
