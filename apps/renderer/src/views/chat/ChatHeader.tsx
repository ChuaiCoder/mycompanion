import type { ConversationDetail } from "@mycompanion/shared";
import { useTranslation } from "react-i18next";
import "../../i18n";

import { storyExportUrl } from "../../api";
import { Icon } from "../../components";

// 聊天页顶部单行栏：角色名 + 故事标题，右侧导出/记忆/停止/设置图标按钮。
export function ChatHeader({
  activeConversation,
  memoryPanelOpen,
  isGenerating,
  onMemoryPanelToggle,
  onStopGeneration,
  onOpenSettings,
}: {
  activeConversation: ConversationDetail | null;
  memoryPanelOpen: boolean;
  isGenerating: boolean;
  onMemoryPanelToggle: () => void;
  onStopGeneration: () => void;
  onOpenSettings: () => void;
}) {
  const { t } = useTranslation();
  return (
    <header className="pane-header">
      <div className="pane-heading"><strong>{activeConversation?.characterName ?? t("开始一段故事")}</strong><span>{activeConversation?.title ?? t("聊天记录只保存在本机")}</span></div>
      <div className="pane-header-actions">
        {activeConversation ? (
          <details className="story-export">
            <summary aria-label={t("导出故事")} className="icon-button" title={t("导出故事")}><Icon name="download" size={16} /></summary>
            <div className="story-export__menu" onClick={(event) => event.currentTarget.closest("details")?.removeAttribute("open")}>
              <a download href={storyExportUrl(activeConversation.id, "markdown")}>Markdown</a>
              <a download href={storyExportUrl(activeConversation.id, "json")}>{t("JSON（全部分支）")}</a>
            </div>
          </details>
        ) : null}
        <button aria-expanded={memoryPanelOpen} aria-label={t("记忆")} className={`icon-button${memoryPanelOpen && activeConversation ? " icon-button--active" : ""}`} disabled={!activeConversation} onClick={onMemoryPanelToggle} title={t("记忆")} type="button">
          <Icon name="brain" size={16} />
        </button>
        {isGenerating ? (
          <button aria-label={t("停止")} className="icon-button" onClick={onStopGeneration} title={t("停止生成")} type="button">
            <Icon name="stop" size={16} />
          </button>
        ) : (
          <button aria-label={t("模型设置")} className="icon-button" disabled={!activeConversation} onClick={onOpenSettings} title={t("模型设置")} type="button">
            <Icon name="settings" size={16} />
          </button>
        )}
      </div>
    </header>
  );
}
