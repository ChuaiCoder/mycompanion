import { useState, type ChangeEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";

import type { ConversationSummary } from "@mycompanion/shared";

import { Icon, type ServiceState } from "../components";
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
  serviceState,
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
  serviceState: ServiceState;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onCardFile: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  const { t, i18n } = useTranslation();
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());
  const groups = groupConversationsByCharacter(conversations);
  const toggleGroup = (characterId: string) => setCollapsedGroups(current => {
    const next = new Set(current);
    if (next.has(characterId)) next.delete(characterId); else next.add(characterId);
    return next;
  });
  return (
    <aside className="sidebar">
      <div className="brand-row">
        <button className="brand-button" onClick={() => onNavigate("chat")} type="button"><span aria-hidden="true" className="brand-mark">M</span><span className="brand-name">MyCompanion</span></button>
        <button aria-expanded={!collapsed} aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"} className="sidebar-collapse" onClick={onCollapseToggle} type="button">{collapsed ? "▣" : "◫"}</button>
      </div>
      <nav aria-label="主导航" className="primary-nav">
        <button className="nav-row nav-row--new" disabled={busy} onClick={onOpenFilePicker} type="button"><Icon name="plus" /><span>{t(isImporting ? "nav.reading" : "nav.import")}</span><kbd>Ctrl I</kbd></button>
        <button aria-current={view === "library" ? "page" : undefined} className={`nav-row ${view === "library" ? "nav-row--active" : ""}`} onClick={() => onNavigate("library")} type="button"><Icon name="character" /><span>{t("nav.library")}</span></button>
        <button aria-current={view === "chat" && !memoryPanelOpen ? "page" : undefined} className={`nav-row ${view === "chat" && !memoryPanelOpen ? "nav-row--active" : ""}`} onClick={onChatNav} type="button"><Icon name="book" /><span>{t("nav.chat")}</span><small>{conversationCount || ""}</small></button>
        <button aria-current={view === "plugins" ? "page" : undefined} className={`nav-row ${view === "plugins" ? "nav-row--active" : ""}`} onClick={() => onNavigate("plugins")} type="button"><Icon name="sparkles" /><span>{t("nav.plugins")}</span><small>{pluginCount || ""}</small></button>
        <button aria-current={view === "chat" && memoryPanelOpen ? "page" : undefined} className={`nav-row ${view === "chat" && memoryPanelOpen ? "nav-row--active" : ""}`} onClick={onMemoryNav} type="button"><Icon name="brain" /><span>{t("nav.memory")}</span><small>{memoryInjectedCount}</small></button>
      </nav>
      <section aria-labelledby="sidebar-conversations-title" className="sidebar-library">
        <div className="tree-heading"><div><Icon name="book" size={16} /><h2 id="sidebar-conversations-title">对话</h2></div></div>
        <div id="right-nav-panel" hidden><div aria-label="收藏角色" className="hotswap" /></div>
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
                      {group.items.map((conversation) => <li key={conversation.id}><button data-conversation-id={conversation.id} aria-pressed={activeConversationId === conversation.id} className="conversation-row" onClick={() => onOpenConversation(conversation.id)} type="button"><span>{conversation.title}</span><small>{conversation.messageCount} 条</small></button></li>)}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <footer className="sidebar-footer">
        <div className={`service-state service-state--${serviceState}`}><span aria-hidden="true" className="status-dot" /><span>{t("service." + serviceState)}</span></div>
        <button aria-label={t("nav.settings")} aria-pressed={view === "settings"} onClick={() => onNavigate("settings")} type="button"><Icon name="settings" size={18} /></button>
      </footer>
      <input ref={fileInputRef} multiple accept=".json,.png,.yaml,.yml,.charx,.zip,.byaf,.jpg,.jpeg,application/json,image/png,application/charx,application/zip,application/byaf,application/yaml,text/yaml" aria-label={libraryText(i18n.language, "选择角色卡文件")} className="visually-hidden-input" disabled={busy} onChange={onCardFile} type="file" />
    </aside>
  );
}
