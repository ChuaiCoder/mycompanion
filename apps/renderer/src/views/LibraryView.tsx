import type {
  CharacterCardPreviewResponse,
  CharacterDetail,
  CharacterSummary,
} from "@mycompanion/shared";

import { characterExportUrl } from "../api";
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
  previewHeadingRef: HeadingRef;
  onOpenFilePicker: () => void;
  onSelectCharacter: (id: string) => void;
  onEditCharacter: () => void;
  onStartConversation: () => void;
  onCommit: () => void;
  onCancelImport: () => void;
  onRegexPanelToggle: () => void;
  onLorebookPanelToggle: () => void;
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
  previewHeadingRef,
  onOpenFilePicker,
  onSelectCharacter,
  onEditCharacter,
  onStartConversation,
  onCommit,
  onCancelImport,
  onRegexPanelToggle,
  onLorebookPanelToggle,
  onOpenSettings, connectionReady,
  batchItems = [], onSkipFile, onRetryFile, onOpenDuplicate, onReplaceDuplicate, onRefreshPreview,
}: LibraryViewProps) {
  const currentTitle = preview?.name ?? selectedCharacter?.name ?? "角色库";
  return (
    <main className="workspace-shell">
      <section className="conversation-pane" aria-label="角色导入助手">
        <header className="pane-header">
          <div className="pane-heading"><strong>角色导入助手</strong><span>上下文：{currentTitle}</span></div>
          <button type="button" id="world_button" onClick={onLorebookPanelToggle}>世界书</button>
          <div className="pane-header-actions"><button disabled type="button"><Icon name="history" size={17} />历史记录</button><button disabled={isImporting || isSaving} onClick={onOpenFilePicker} type="button"><Icon name="plus" size={17} />新建导入</button></div>
        </header>
        <div className="conversation-scroll">
          <div aria-live="polite" className="notice-stack">
            {importError ? <Notice tone="error"><strong>{importError}</strong>{importErrorDetails.length > 0 ? <details><summary>查看具体问题</summary><ul>{importErrorDetails.map((detail) => <li key={detail}>{detail}</li>)}</ul></details> : null}</Notice> : null}
            {successMessage ? <Notice tone="success">{successMessage}</Notice> : null}
            {batchItems.length > 1 ? <section className="import-batch" aria-label="批量导入结果"><h2>逐文件导入 · {batchItems.filter(item => ["saved", "opened", "skipped"].includes(item.status)).length} / {batchItems.length}</h2><ol>{batchItems.map(item => <li key={item.id}><strong>{item.fileName}</strong><span>{{ waiting: "待检查", previewing: "正在检查", ready: "等待确认", failed: "失败", saved: "已导入", opened: "已打开既有角色", skipped: "已跳过" }[item.status]}</span>{item.error ? <p role="status">{item.error}</p> : null}{item.status === "failed" ? <button type="button" disabled={isImporting || isSaving || Boolean(preview)} onClick={() => onRetryFile?.(item.id)}>重试此文件</button> : null}</li>)}</ol></section> : null}
          </div>
          {preview ? (
            <div className="assistant-flow">
              <div className="request-bubble"><span>请帮我检查并导入角色卡</span><strong>{draftFileName}</strong></div>
              <article className="assistant-message">
                <div className="assistant-label"><span className="mini-brand">M</span><strong>角色导入助手</strong></div>
                <p>检查完成。这张角色卡可以导入，人物设定、开场白、世界书和正则数据都已进入预览。</p>
                <p>右侧列出了实际识别结果。确认后才会写入角色库，你也可以取消并重新选择文件。</p>
                <div className={`review-card ${preview.warningCodes.length > 0 ? "has-warnings" : "is-ready"}`}>
                  <div className="review-card__icon"><Icon name="file" /></div><div><strong>{preview.name}</strong><span>{preview.format.toUpperCase()} · {preview.specVersion}</span></div><span className="review-status">{preview.warningCodes.length > 0 ? `${preview.warningCodes.length} 项提醒` : "可以导入"}</span>
                  <div className="review-card__footer"><span>兼容性检查</span><span>{preview.lorebookEntryCount} 世界书 · {preview.regexScriptCount} 正则</span></div>
                </div>
              </article>
            </div>
          ) : selectedCharacter ? (
            <div className="assistant-flow"><article className="assistant-message assistant-message--loaded"><div className="assistant-label"><span className="mini-brand">M</span><strong>角色导入助手</strong></div><p><strong>{selectedCharacter.name}</strong> 已载入。角色设定和扩展内容显示在右侧，你可以检查开场白并开始对话。</p><div className="ready-card"><span aria-hidden="true">✓</span><div><strong>第 1 步已完成：角色数据可用</strong><small>已保留 {selectedCharacter.lorebookEntryCount} 条世界书和 {selectedCharacter.regexScriptCount} 条正则规则</small></div></div>{!connectionReady && onOpenSettings ? <p>首次使用，先测试模型连接，再让角色回复。<button className="button button--primary" onClick={onOpenSettings} type="button">第 2 步：连接模型</button></p> : null}<button className={`button ${connectionReady ? "button--primary" : "button--quiet"} start-chat-button`} onClick={onStartConversation} type="button">开始对话</button></article></div>
          ) : (
            <section className="empty-workspace" aria-labelledby="welcome-title">
              <span aria-hidden="true" className="empty-workspace__mark"><Icon name="sparkles" size={29} /></span>
              <h1 id="welcome-title">导入喜欢的角色，直接开始故事。</h1>
              <p>我会先检查人物设定、世界书、正则和兼容性。你确认之前，不会写入永久数据。</p>
              <div className="suggestion-row" aria-label="支持的角色卡内容"><button disabled type="button">识别 V2 / V3</button><button disabled type="button">保留世界书</button><button disabled type="button">导入正则脚本</button></div>
            </section>
          )}
        </div>
        <div className="composer-wrap">
          <button className="import-composer" disabled={isImporting || isSaving} onClick={onOpenFilePicker} type="button"><span><strong>{isImporting ? "正在读取角色卡…" : preview ? "重新选择角色卡" : "选择一张角色卡"}</strong><small>PNG、JSON、YAML、CHARX 或 BYAF · 最大 20 MiB</small></span><span aria-hidden="true" className="composer-add"><Icon name="plus" size={19} /></span><span className="composer-mode"><Icon name="character" size={16} />兼容导入</span><span aria-hidden="true" className="composer-submit">↑</span></button>
          <small className="composer-hint">支持 Character Card V2/V3 · 导入前始终预览</small>
        </div>
      </section>

      <aside className="inspector-pane">
        <header className="inspector-header"><div className="breadcrumb" aria-label="当前位置"><span>角色库</span><i>/</i><strong>{currentTitle}</strong></div><span className={`local-save-state ${preview ? "local-save-state--pending" : ""}`}>{preview ? "尚未保存" : selectedCharacter ? "✓ 已保存到本地" : "本地工作区"}</span></header>
        {preview ? (
          <section className="inspector-scroll preview-inspector" aria-labelledby="preview-title">
            <header className="character-hero"><span aria-hidden="true" className="character-avatar character-avatar--large">{characterInitial(preview.name)}</span><div><p className="eyebrow">导入预览 · {preview.format.toUpperCase()}</p><h1 id="preview-title" ref={previewHeadingRef} tabIndex={-1}>{preview.name}</h1><ExpandableDescription text={preview.descriptionPreview} emptyText="这张角色卡没有填写人物简介。" /></div></header>
            <div className="metric-grid" aria-label="角色卡内容统计"><Metric label="备用开场白" value={preview.alternateGreetingsCount} /><Metric label="世界书条目" value={preview.lorebookEntryCount} /><Metric label="正则规则" value={preview.regexScriptCount} /><Metric label="扩展字段" value={preview.extensionKeys.length} /></div>
            {preview.importedAssetCount !== undefined ? <section className="document-section"><h2>随卡资产</h2><p>实际识别 {preview.importedAssetCount} 个文件，确认后将随卡保存，包含未引用的辅助文件。CHARX 导出和完整备份会保留这些文件；外部地址不会自动下载。</p></section> : null}
            {preview.importedScenarioCount !== undefined ? <section className="document-section"><h2>随卡故事</h2><p>实际识别 {preview.importedScenarioCount} 个故事，确认导入后会保留消息和回复分支，可在故事列表中打开。</p></section> : null}
            {preview.firstMessagePreview ? <section className="document-section"><h2>开场白预览</h2><RichTextPreview text={preview.firstMessagePreview} /></section> : null}
            {preview.lorebookEntries.length > 0 || preview.regexScripts.length > 0 ? <section className="document-section imported-content" aria-label="角色卡附属内容"><ImportedContentDetails lorebookEntries={preview.lorebookEntries} regexScripts={preview.regexScripts} /></section> : null}
            <section className="document-section" aria-labelledby="compatibility-title"><h2 id="compatibility-title">兼容性</h2>{preview.warningCodes.length > 0 ? <ul className="warning-list">{preview.warningCodes.map((warning) => <li key={warning}><span aria-hidden="true">i</span>{warningText[warning]}</li>)}</ul> : <p className="ready-message"><span aria-hidden="true">✓</span>格式检查通过，没有需要处理的警告。</p>}</section>
            {preview.unknownFieldPaths.length > 0 || preview.compatibilityDefaultPaths.length > 0 ? <details className="content-disclosure compatibility-paths"><summary><span>字段处理明细</span><small>{preview.unknownFieldPaths.length + preview.compatibilityDefaultPaths.length} 项</small></summary>{preview.unknownFieldPaths.length > 0 ? <div><strong>原样保留的未知字段</strong><ul>{preview.unknownFieldPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul></div> : null}{preview.compatibilityDefaultPaths.length > 0 ? <div><strong>使用安全默认值</strong><ul>{preview.compatibilityDefaultPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul></div> : null}</details> : null}
            {preview.duplicates?.length ? <section className="document-section import-duplicates" aria-label="已有角色匹配"><h2>发现已有角色</h2><p>可打开既有角色、导入独立副本，或用当前卡片替换。替换会保留既有故事和角色 ID。</p><ul>{preview.duplicates.map(item => <li key={item.id} data-character-id={item.id}><strong>{item.name}</strong><span>{item.match === "exact" ? "相同卡片内容" : "名称相同"}</span><div><button className="button button--quiet" type="button" disabled={isSaving} onClick={() => onOpenDuplicate?.(item.id)}>打开既有角色</button><button className="button button--quiet" type="button" disabled={isSaving} onClick={() => onReplaceDuplicate?.(item.id, item.updatedAt)}>用当前卡片替换</button></div></li>)}</ul><button className="button button--quiet" type="button" disabled={isSaving || isImporting} onClick={onRefreshPreview}>重新检查角色匹配</button></section> : null}
            <div className="sticky-actions"><button className="button button--primary" disabled={isSaving} onClick={onCommit} type="button">{isSaving ? "正在保存…" : preview.duplicates?.length ? "导入独立副本" : "确认导入"}</button>{batchItems.length > 1 ? <button className="button button--quiet" disabled={isSaving} onClick={onSkipFile} type="button">跳过此文件</button> : null}<button className="button button--quiet" disabled={isSaving} onClick={onCancelImport} type="button">{batchItems.length > 1 ? "取消整批" : "取消"}</button></div>
          </section>
        ) : selectedCharacter ? (
          <section className="inspector-scroll character-page" aria-labelledby="character-detail-title">
            <header className="character-hero"><CharacterAvatar character={selectedCharacter} large /><div><p className="eyebrow">{selectedCharacter.sourceFormat.toUpperCase()}</p><h1 id="character-detail-title">{selectedCharacter.name}</h1><ExpandableDescription text={selectedCharacter.description} emptyText="未填写人物简介。" /></div></header>
            <div className="export-actions" aria-label="角色操作"><a download href={characterExportUrl(selectedCharacter.id, "json")}><Icon name="download" size={15} />导出 JSON</a><a download href={characterExportUrl(selectedCharacter.id, "png")}><Icon name="download" size={15} />导出 PNG</a><a download href={characterExportUrl(selectedCharacter.id, "charx")}><Icon name="download" size={15} />导出 CHARX</a><button aria-expanded={regexPanelOpen} className="button button--quiet button--small" onClick={onRegexPanelToggle} type="button"><Icon name="sparkles" size={15} />正则规则{selectedCharacter.regexScriptCount > 0 ? `（${selectedCharacter.regexScriptCount}）` : ""}</button><button aria-expanded={lorebookPanelOpen} className="button button--quiet button--small" onClick={onLorebookPanelToggle} type="button"><Icon name="book" size={15} />世界书{selectedCharacter.lorebookEntryCount > 0 ? `（${selectedCharacter.lorebookEntryCount}）` : ""}</button></div>
            <p className="export-format-help">JSON 不包含随卡附件。PNG 会保存内嵌资产，但资产路径受 PNG 文本块长度和 Latin-1 编码限制；完整迁移优先选择 CHARX。</p>
            <section className="document-section"><h2>角色设定</h2><button type="button" onClick={onEditCharacter}>编辑角色</button><dl className="detail-list"><div><dt>性格</dt><dd>{selectedCharacter.personality || "未填写"}</dd></div><div><dt>场景</dt><dd>{selectedCharacter.scenario || "未填写"}</dd></div><div><dt>标签</dt><dd>{selectedCharacter.tags.join("、") || "无"}</dd></div></dl></section>
            <section className="document-section"><h2>附属内容</h2><div className="metric-grid metric-grid--three"><Metric label="备用开场白" value={selectedCharacter.alternateGreetingsCount} /><Metric label="世界书条目" value={selectedCharacter.lorebookEntryCount} /><Metric label="正则规则" value={selectedCharacter.regexScriptCount} /></div></section>
            {regexPanelOpen ? <RegexPanel characterId={selectedCharacter.id} characterName={selectedCharacter.name} runtimeError={importError} /> : null}
            {lorebookPanelOpen ? <LorebookPanel characterId={selectedCharacter.id} characterName={selectedCharacter.name} runtimeError={importError} /> : null}
            {selectedCharacter.lorebookEntries.length > 0 || selectedCharacter.regexScripts.length > 0 ? <section className="document-section imported-content" aria-label="已保存的附属内容"><ImportedContentDetails lorebookEntries={selectedCharacter.lorebookEntries} regexScripts={selectedCharacter.regexScripts} /></section> : null}
            {selectedCharacter.firstMessage ? <section className="document-section"><h2>默认开场白</h2><RichTextPreview text={selectedCharacter.firstMessage} /></section> : null}
          </section>
        ) : (
          <section className="inspector-scroll onboarding-panel" aria-labelledby="steps-title">
            <p className="eyebrow">MYCOMPANION · 新手引导</p><h2 id="steps-title">只需要三步</h2><p className="onboarding-lead">先导入角色，再连接模型。复杂设置可以稍后处理。</p>
            <ol><li><span>1</span><div><strong>导入角色</strong><p>选择角色卡文件，先看完整预览。</p></div></li><li><span>2</span><div><strong>连接模型</strong><p>用自己的 API 服务完成连接检查。</p></div></li><li><span>3</span><div><strong>开始故事</strong><p>选择开场白，记忆和上下文由系统持续整理。</p></div></li></ol>
            <div className="format-note"><Icon name="file" /><div><strong>角色卡兼容</strong><p>支持 Character Card V2/V3，包含世界书、备用开场白和常见正则扩展。</p></div></div>
          </section>
        )}
      </aside>
    </main>
  );
}
