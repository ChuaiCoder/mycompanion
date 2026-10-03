import type { ChangeEvent, RefObject } from "react";
import { useTranslation } from "react-i18next";

import type { CharacterSummary } from "@mycompanion/shared";

import { CharacterAvatar, Icon, type ServiceState } from "../components";
import { libraryText } from "../library-translations";
import type { WorkspaceView } from "../hooks/useExtensionResume";

// 桌面侧边栏：品牌行、主导航、我的角色列表、服务状态与隐藏的角色卡文件输入。
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
  characters,
  selectedCharacterId,
  isLoadingCharacter,
  onSelectCharacter,
  listError,
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
  characters: CharacterSummary[];
  selectedCharacterId: string | undefined;
  isLoadingCharacter: boolean;
  onSelectCharacter: (id: string) => void;
  listError: string | null;
  serviceState: ServiceState;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onCardFile: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  const { t, i18n } = useTranslation();
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
      <section aria-labelledby="recent-characters-title" className="sidebar-library">
        <div className="tree-heading"><div><Icon name="character" size={16} /><h2 id="recent-characters-title">我的角色</h2></div><button aria-label="导入新的角色卡" disabled={busy} onClick={onOpenFilePicker} type="button"><Icon name="plus" size={16} /></button></div>
        <div id="right-nav-panel" hidden><div aria-label="收藏角色" className="hotswap" /></div>
        {listError ? <p className="sidebar-error">{listError}</p> : null}
        {characters.length === 0 ? (
          <div className="tree-empty"><span>还没有角色</span><small>导入 PNG、JSON 或 CHARX 角色卡</small></div>
        ) : (
          <ul className="character-list" aria-label="已保存角色">
            {characters.map((character) => <li key={character.id}><button aria-pressed={selectedCharacterId === character.id} className="character-row" disabled={isLoadingCharacter} onClick={() => onSelectCharacter(character.id)} type="button"><CharacterAvatar character={character} /><span className="character-row__copy"><strong>{character.name}</strong><small>世界书 {character.lorebookEntryCount} · 正则 {character.regexScriptCount}</small></span><Icon name="chevron" size={14} /></button></li>)}
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
