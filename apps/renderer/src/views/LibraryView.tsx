import type {
  CharacterCardPreviewResponse,
  CharacterDetail,
  CharacterSummary,
} from "@mycompanion/shared";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { characterExportUrl } from "../api";
import { uiLocale } from "../i18n";
import { libraryText } from "../library-translations";
import {
  characterInitial,
  CharacterAvatar,
  ExpandableDescription,
  Icon,
  ImportedContentDetails,
  Metric,
  Notice,
  RichTextPreview,
  warningText,
  type HeadingRef,
} from "../components";
import { LorebookPanel } from "./LorebookPanel";
import { RegexPanel } from "./RegexPanel";
import type { ImportQueueItem } from "../hooks/useCharacterImport";

export interface LibraryViewProps {
  preview: CharacterCardPreviewResponse | null;
  selectedCharacter: CharacterDetail | null;
  draftFileName: string | null;
  characters: CharacterSummary[];
  listError: string | null;
  importError: string | null;
  importErrorDetails: string[];
  successMessage: string | null;
  isImporting: boolean;
  isSaving: boolean;
  isLoadingCharacter: boolean;
  regexPanelOpen: boolean;
  lorebookPanelOpen: boolean;
  worldEditorOpen: boolean;
  previewHeadingRef: HeadingRef;
  onOpenFilePicker: () => void;
  onSelectCharacter: (id: string) => void;
  /** 直接为该角色开一局新故事（不必先进详情——详情里没有开始对话的入口）。 */
  onStartConversationWith?: (id: string) => void;
  onBackToLibrary?: () => void;
  onEditCharacter: () => void;
  onStartConversation: () => void;
  onCommit: () => void;
  onCancelImport: () => void;
  onRegexPanelToggle: () => void;
  onLorebookPanelToggle: () => void;
  onWorldEditorToggle: () => void;
  onOpenSettings?: () => void;
  connectionReady?: boolean;
  batchItems?: ImportQueueItem[];
  onSkipFile?: () => void;
  onRetryFile?: (id: string) => void;
  onOpenDuplicate?: (id: string) => void;
  onReplaceDuplicate?: (id: string, updatedAt: string) => void;
  onRefreshPreview?: () => void;
}

export function LibraryView({
  preview,
  selectedCharacter,
  draftFileName,
  characters,
  listError,
  importError,
  importErrorDetails,
  successMessage,
  isImporting,
  isSaving,
  isLoadingCharacter,
  regexPanelOpen,
  lorebookPanelOpen,
  worldEditorOpen,
  previewHeadingRef,
  onOpenFilePicker,
  onSelectCharacter,
  onStartConversationWith,
  onBackToLibrary,
  onEditCharacter,
  onStartConversation,
  onCommit,
  onCancelImport,
  onRegexPanelToggle,
  onLorebookPanelToggle,
  onWorldEditorToggle,
  onOpenSettings, connectionReady,
  batchItems = [], onSkipFile, onRetryFile, onOpenDuplicate, onReplaceDuplicate, onRefreshPreview,
}: LibraryViewProps) {
  const { i18n } = useTranslation();
  const text = (value: string) => libraryText(i18n.language, value);
  const locale = uiLocale();
  // 含脚本的卡片要求用户显式确认信任来源后才允许导入（spec §5.10：卡脚本以完整权限
  // 运行）。换一张卡（preview 引用变化）时重新要求确认。
  const [scriptConsent, setScriptConsent] = useState(false);
  const previewContainsScripts = preview?.containsScripts === true;
  useEffect(() => { setScriptConsent(false); }, [preview]);
  const currentTitle = preview?.name ?? selectedCharacter?.name ?? text("角色库");
  // 角色库只是浏览已保存角色（网格或角色详情）时，导入助手整栏没有内容可做，却要
  // 占掉约 62% 宽度，并把库网格挤成一条窄缝；此时收起助手，让库区占满。导入入口仍
  // 保留在侧边栏「导入角色卡」、页面右上「新建导入」和 Ctrl/Cmd+I。只有在还没有任何
  // 角色（首启引导）或已选中角色卡文件进入预览（审核与确认）时才显示助手。
  const showAssistant = preview !== null || characters.length === 0;
  // 导入结果提示（成功、失败、批量进度）挂在右侧检视栏而不是左侧助手栏：确认导入
  // 成功的那一刻助手正好收起（角色已入库、进入详情），提示若留在助手栏就会随之一并
  // 消失，用户看不到"已保存"的确认。
  const notices = (
    <div aria-live="polite" className="notice-stack">
      {importError ? <Notice tone="error"><strong>{text(importError)}</strong>{importErrorDetails.length > 0 ? <details><summary>{text("查看具体问题")}</summary><ul>{importErrorDetails.map((detail) => <li key={detail}>{text(detail)}</li>)}</ul></details> : null}</Notice> : null}
      {successMessage ? <Notice tone="success">{text(successMessage)}</Notice> : null}
      {batchItems.length > 1 ? <section className="import-batch" aria-label={text("批量导入结果")}><h2>{text(`逐文件导入 · ${batchItems.filter(item => ["saved", "opened", "skipped"].includes(item.status)).length} / ${batchItems.length}`)}</h2><ol>{batchItems.map(item => <li key={item.id}><strong>{item.fileName}</strong><span>{{ waiting: text("待检查"), previewing: text("正在检查"), ready: text("等待确认"), failed: text("失败"), saved: text("已导入"), opened: text("已打开既有角色"), skipped: text("已跳过") }[item.status]}</span>{item.error ? <p role="status">{text(item.error)}</p> : null}{item.status === "failed" ? <button type="button" disabled={isImporting || isSaving || Boolean(preview)} onClick={() => onRetryFile?.(item.id)}>{text("重试此文件")}</button> : null}</li>)}</ol></section> : null}
    </div>
  );
  return (
    <main className={`workspace-shell${showAssistant ? "" : " workspace-shell--solo"}`}>
      {showAssistant ? (
      <section className="conversation-pane" aria-label={text("角色导入助手")}>
        <header className="pane-header">
          <div className="pane-heading"><strong>{text("角色导入助手")}</strong><span>{text("上下文：")}{currentTitle}</span></div>
          <div className="pane-header-actions"><button className="button button--quiet" type="button" id="world_button" aria-pressed={worldEditorOpen} onClick={onWorldEditorToggle}><Icon name="book" size={16} />{text("世界书")}</button><button className="button button--quiet" disabled type="button"><Icon name="history" size={16} />{text("历史记录")}</button><button className="button button--primary" disabled={isImporting || isSaving} onClick={onOpenFilePicker} type="button"><Icon name="plus" size={16} />{text("新建导入")}</button></div>
        </header>
        <div className="conversation-scroll">
          {notices}
          {preview ? (
            <div className="assistant-flow">
              <div className="request-bubble"><span>{text("请帮我检查并导入角色卡")}</span><strong>{draftFileName}</strong></div>
              <article className="assistant-message">
                <div className="assistant-label"><span className="mini-brand">M</span><strong>{text("角色导入助手")}</strong></div>
                <p>{text("检查完成。这张角色卡可以导入，人物设定、开场白、世界书和正则数据都已进入预览。")}</p>
                <p>{text("右侧列出了实际识别结果。确认后才会写入角色库，你也可以取消并重新选择文件。")}</p>
                <div className={`review-card ${preview.warningCodes.length > 0 ? "has-warnings" : "is-ready"}`}>
                  <div className="review-card__icon"><Icon name="file" /></div><div><strong>{preview.name}</strong><span>{preview.format.toUpperCase()} · {preview.specVersion}</span></div><span className="review-status">{preview.warningCodes.length > 0 ? text(`${preview.warningCodes.length} 项提醒`) : text("可以导入")}</span>
                  <div className="review-card__footer"><span>{text("兼容性检查")}</span><span>{text(`${preview.lorebookEntryCount} 世界书 · ${preview.regexScriptCount} 正则`)}</span></div>
                </div>
              </article>
            </div>
          ) : selectedCharacter ? (
            <div className="assistant-flow"><article className="assistant-message assistant-message--loaded"><div className="assistant-label"><span className="mini-brand">M</span><strong>{text("角色导入助手")}</strong></div><p><strong>{selectedCharacter.name}</strong>{text(" 已载入。角色设定和扩展内容显示在右侧，你可以检查开场白并开始对话。")}</p><div className="ready-card"><span aria-hidden="true">✓</span><div><strong>{text("第 1 步已完成：角色数据可用")}</strong><small>{text(`已保留 ${selectedCharacter.lorebookEntryCount} 条世界书和 ${selectedCharacter.regexScriptCount} 条正则规则`)}</small></div></div>{!connectionReady && onOpenSettings ? <p>{text("首次使用，先测试模型连接，再让角色回复。")}<button className="button button--primary" onClick={onOpenSettings} type="button">{text("第 2 步：连接模型")}</button></p> : null}<button className={`button ${connectionReady ? "button--primary" : "button--quiet"} start-chat-button`} onClick={onStartConversation} type="button">{text("开始对话")}</button></article></div>
          ) : (
            <section className="empty-workspace" aria-labelledby="welcome-title">
              <span aria-hidden="true" className="empty-workspace__mark"><Icon name="sparkles" size={29} /></span>
              <h1 id="welcome-title">{text("导入喜欢的角色，直接开始故事。")}</h1>
              <p>{text("我会先检查人物设定、世界书、正则和兼容性。你确认之前，不会写入永久数据。")}</p>
              <div className="suggestion-row" aria-label={text("支持的角色卡内容")}><button disabled type="button">{text("识别 V2 / V3")}</button><button disabled type="button">{text("保留世界书")}</button><button disabled type="button">{text("导入正则脚本")}</button></div>
            </section>
          )}
        </div>
        <div className="composer-wrap">
          <button className="import-composer" disabled={isImporting || isSaving} onClick={onOpenFilePicker} type="button"><span><strong>{isImporting ? text("正在读取角色卡…") : preview ? text("重新选择角色卡") : text("选择一张角色卡")}</strong><small>{text("PNG、JSON、YAML、CHARX 或 BYAF · 最大 20 MiB")}</small></span><span aria-hidden="true" className="composer-add"><Icon name="plus" size={19} /></span><span className="composer-mode"><Icon name="character" size={16} />{text("兼容导入")}</span><span aria-hidden="true" className="composer-submit">↑</span></button>
          <small className="composer-hint">{text("支持 Character Card V2/V3 · 导入前始终预览")}</small>
        </div>
      </section>
      ) : null}

      <aside className="inspector-pane">
        <header className="inspector-header"><div className="breadcrumb" aria-label={text("当前位置")}>{!preview && selectedCharacter && onBackToLibrary ? <button className="breadcrumb__link" onClick={onBackToLibrary} type="button">{text("角色库")}</button> : <span>{text("角色库")}</span>}<i>/</i><strong>{currentTitle}</strong></div><span className={`local-save-state ${preview ? "local-save-state--pending" : ""}`}>{preview ? text("尚未保存") : selectedCharacter ? text("✓ 已保存到本地") : text("本地工作区")}</span></header>
        {!showAssistant ? notices : null}
        {preview ? (
          <section className="inspector-scroll preview-inspector" aria-labelledby="preview-title">
            <header className="character-hero"><span aria-hidden="true" className="character-avatar character-avatar--large">{characterInitial(preview.name)}</span><div><p className="eyebrow">{text("导入预览 · ")}{preview.format.toUpperCase()}</p><h1 id="preview-title" ref={previewHeadingRef} tabIndex={-1}>{preview.name}</h1><ExpandableDescription translate={text} text={preview.descriptionPreview} emptyText={text("这张角色卡没有填写人物简介。")} /></div></header>
            <div className="metric-grid" aria-label={text("角色卡内容统计")}><Metric locale={locale} label={text("备用开场白")} value={preview.alternateGreetingsCount} /><Metric locale={locale} label={text("世界书条目")} value={preview.lorebookEntryCount} /><Metric locale={locale} label={text("正则规则")} value={preview.regexScriptCount} /><Metric locale={locale} label={text("扩展字段")} value={preview.extensionKeys.length} /></div>
            {preview.importedAssetCount !== undefined ? <section className="document-section"><h2>{text("随卡资产")}</h2><p>{text(`实际识别 ${preview.importedAssetCount} 个文件，确认后将随卡保存，包含未引用的辅助文件。CHARX 导出和完整备份会保留这些文件；外部地址不会自动下载。`)}</p></section> : null}
            {preview.importedScenarioCount !== undefined ? <section className="document-section"><h2>{text("随卡故事")}</h2><p>{text(`实际识别 ${preview.importedScenarioCount} 个故事，确认导入后会保留消息和回复分支，可在故事列表中打开。`)}</p></section> : null}
            {preview.firstMessagePreview ? <section className="document-section"><h2>{text("开场白预览")}</h2><RichTextPreview translate={text} text={preview.firstMessagePreview} /></section> : null}
            {preview.lorebookEntries.length > 0 || preview.regexScripts.length > 0 ? <section className="document-section imported-content" aria-label={text("角色卡附属内容")}><ImportedContentDetails locale={locale} translate={text} lorebookEntries={preview.lorebookEntries} regexScripts={preview.regexScripts} /></section> : null}
            <section className="document-section" aria-labelledby="compatibility-title"><h2 id="compatibility-title">{text("兼容性")}</h2>{preview.warningCodes.length > 0 ? <ul className="warning-list">{preview.warningCodes.map((warning) => <li key={warning}><span aria-hidden="true">i</span>{text(warningText[warning])}</li>)}</ul> : <p className="ready-message"><span aria-hidden="true">✓</span>{text("格式检查通过，没有需要处理的警告。")}</p>}</section>
            {preview.unknownFieldPaths.length > 0 || preview.compatibilityDefaultPaths.length > 0 ? <details className="content-disclosure compatibility-paths"><summary><span>{text("字段处理明细")}</span><small>{text(`${preview.unknownFieldPaths.length + preview.compatibilityDefaultPaths.length} 项`)}</small></summary>{preview.unknownFieldPaths.length > 0 ? <div><strong>{text("原样保留的未知字段")}</strong><ul>{preview.unknownFieldPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul></div> : null}{preview.compatibilityDefaultPaths.length > 0 ? <div><strong>{text("使用安全默认值")}</strong><ul>{preview.compatibilityDefaultPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul></div> : null}</details> : null}
            {preview.duplicates?.length ? <section className="document-section import-duplicates" aria-label={text("已有角色匹配")}><h2>{text("发现已有角色")}</h2><p>{text("可打开既有角色、导入独立副本，或用当前卡片替换。替换会保留既有故事和角色 ID。")}</p><ul>{preview.duplicates.map(item => <li key={item.id} data-character-id={item.id}><strong>{item.name}</strong><span>{item.match === "exact" ? text("相同卡片内容") : text("名称相同")}</span><div><button className="button button--quiet" type="button" disabled={isSaving} onClick={() => onOpenDuplicate?.(item.id)}>{text("打开既有角色")}</button><button className="button button--quiet" type="button" disabled={isSaving || (previewContainsScripts && !scriptConsent)} onClick={() => onReplaceDuplicate?.(item.id, item.updatedAt)}>{text("用当前卡片替换")}</button></div></li>)}</ul><button className="button button--quiet" type="button" disabled={isSaving || isImporting} onClick={onRefreshPreview}>{text("重新检查角色匹配")}</button></section> : null}
            {previewContainsScripts ? (
              <section className="document-section script-consent" aria-label={text("脚本确认")}>
                <h2>{text("包含交互脚本")}</h2>
                <p>{text("这张卡片包含交互脚本，导入后将以完整权限运行：可读写本应用的数据并访问网络。请只导入你信任的卡片。")}</p>
                <label className="script-consent__check"><input checked={scriptConsent} onChange={(event) => setScriptConsent(event.currentTarget.checked)} type="checkbox" />{text("我了解风险，信任这张卡片的来源")}</label>
              </section>
            ) : null}
            <div className="sticky-actions"><button className="button button--primary" disabled={isSaving || (previewContainsScripts && !scriptConsent)} onClick={onCommit} type="button">{isSaving ? text("正在保存…") : preview.duplicates?.length ? text("导入独立副本") : text("确认导入")}</button>{batchItems.length > 1 ? <button className="button button--quiet" disabled={isSaving} onClick={onSkipFile} type="button">{text("跳过此文件")}</button> : null}<button className="button button--quiet" disabled={isSaving} onClick={onCancelImport} type="button">{batchItems.length > 1 ? text("取消整批") : text("取消")}</button></div>
          </section>
        ) : selectedCharacter ? (
          <section className="inspector-scroll character-page" aria-labelledby="character-detail-title">
            <header className="character-hero"><CharacterAvatar character={selectedCharacter} large /><div><p className="eyebrow">{selectedCharacter.sourceFormat.toUpperCase()}</p><h1 id="character-detail-title">{selectedCharacter.name}</h1><ExpandableDescription translate={text} text={selectedCharacter.description} emptyText={text("未填写人物简介。")} /></div></header>
            <div className="export-actions" aria-label={text("角色操作")}><a download href={characterExportUrl(selectedCharacter.id, "json")}><Icon name="download" size={15} />{text("导出 JSON")}</a><a download href={characterExportUrl(selectedCharacter.id, "png")}><Icon name="download" size={15} />{text("导出 PNG")}</a><a download href={characterExportUrl(selectedCharacter.id, "charx")}><Icon name="download" size={15} />{text("导出 CHARX")}</a><button aria-expanded={regexPanelOpen} className="button button--quiet button--small" onClick={onRegexPanelToggle} type="button"><Icon name="sparkles" size={15} />{text("正则规则")}{selectedCharacter.regexScriptCount > 0 ? text(`（${selectedCharacter.regexScriptCount}）`) : ""}</button><button aria-expanded={lorebookPanelOpen} className="button button--quiet button--small" onClick={onLorebookPanelToggle} type="button"><Icon name="book" size={15} />{text("世界书")}{selectedCharacter.lorebookEntryCount > 0 ? text(`（${selectedCharacter.lorebookEntryCount}）`) : ""}</button></div>
            <p className="export-format-help">{text("JSON 不包含随卡附件。PNG 会保存内嵌资产，但资产路径受 PNG 文本块长度和 Latin-1 编码限制；完整迁移优先选择 CHARX。")}</p>
            <section className="document-section"><div className="document-section__head"><h2>{text("角色设定")}</h2><button className="button button--quiet button--small" type="button" onClick={onEditCharacter}>{text("编辑角色")}</button></div><dl className="detail-list"><div><dt>{text("性格")}</dt><dd>{selectedCharacter.personality || text("未填写")}</dd></div><div><dt>{text("场景")}</dt><dd>{selectedCharacter.scenario || text("未填写")}</dd></div><div><dt>{text("标签")}</dt><dd>{selectedCharacter.tags.join("、") || text("无")}</dd></div></dl></section>
            <section className="document-section"><h2>{text("附属内容")}</h2><div className="metric-grid metric-grid--three"><Metric locale={locale} label={text("备用开场白")} value={selectedCharacter.alternateGreetingsCount} /><Metric locale={locale} label={text("世界书条目")} value={selectedCharacter.lorebookEntryCount} /><Metric locale={locale} label={text("正则规则")} value={selectedCharacter.regexScriptCount} /></div></section>
            {regexPanelOpen ? <RegexPanel characterId={selectedCharacter.id} characterName={selectedCharacter.name} runtimeError={importError} /> : null}
            {lorebookPanelOpen ? <LorebookPanel characterId={selectedCharacter.id} characterName={selectedCharacter.name} runtimeError={importError} primaryWorld={typeof selectedCharacter.rawExtensions.world === "string" ? selectedCharacter.rawExtensions.world : undefined} /> : null}
            {selectedCharacter.lorebookEntries.length > 0 || selectedCharacter.regexScripts.length > 0 ? <section className="document-section imported-content" aria-label={text("已保存的附属内容")}><ImportedContentDetails locale={locale} translate={text} lorebookEntries={selectedCharacter.lorebookEntries} regexScripts={selectedCharacter.regexScripts} /></section> : null}
            {selectedCharacter.firstMessage ? <section className="document-section"><h2>{text("默认开场白")}</h2><RichTextPreview translate={text} text={selectedCharacter.firstMessage} /></section> : null}
          </section>
        ) : characters.length > 0 ? (
          <section className="inspector-scroll character-grid-panel" aria-labelledby="character-grid-title">
            <p className="eyebrow">{text("MYCOMPANION · 角色库")}</p><h2 id="character-grid-title">{text("我的角色")}</h2><p className="onboarding-lead">{text("选择角色查看设定、世界书和正则，或直接点卡片上的「开始对话」开一局新故事。")}</p>
            {listError ? <p className="sidebar-error">{text(listError)}</p> : null}
            <ul className="character-grid" aria-label={text("已保存角色")}>
              {characters.map((character) => <li key={character.id}><div className="character-card"><button className="character-card__detail" data-character-id={character.id} disabled={isLoadingCharacter} onClick={() => onSelectCharacter(character.id)} type="button"><CharacterAvatar character={character} large /><strong>{character.name}</strong><small>{text(`${character.lorebookEntryCount} 世界书 · ${character.regexScriptCount} 正则`)}</small></button><button className="button button--quiet button--small character-card__start" disabled={isLoadingCharacter} onClick={() => onStartConversationWith?.(character.id)} type="button">{text("开始对话")}</button></div></li>)}
            </ul>
          </section>
        ) : (
          <section className="inspector-scroll onboarding-panel" aria-labelledby="steps-title">
            <p className="eyebrow">{text("MYCOMPANION · 新手引导")}</p><h2 id="steps-title">{text("只需要三步")}</h2><p className="onboarding-lead">{text("先导入角色，再连接模型。复杂设置可以稍后处理。")}</p>
            <ol><li><span>1</span><div><strong>{text("导入角色")}</strong><p>{text("选择角色卡文件，先看完整预览。")}</p></div></li><li><span>2</span><div><strong>{text("连接模型")}</strong><p>{text("用自己的 API 服务完成连接检查。")}</p></div></li><li><span>3</span><div><strong>{text("开始故事")}</strong><p>{text("选择开场白，记忆和上下文由系统持续整理。")}</p></div></li></ol>
            <div className="format-note"><Icon name="file" /><div><strong>{text("角色卡兼容")}</strong><p>{text("支持 Character Card V2/V3，包含世界书、备用开场白和常见正则扩展。")}</p></div></div>
          </section>
        )}
      </aside>
    </main>
  );
}
