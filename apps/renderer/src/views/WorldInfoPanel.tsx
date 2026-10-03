import { useEffect, useRef, useState } from "react";
import { worldInfoDocumentSchema, type CharacterDetail, type WorldInfoDocument } from "@mycompanion/shared";
import { loadWorldInfoRuntime, type WorldInfoRuntime } from "../world-info-runtime";
import { loadWorldDraftStore, type WorldDraftStore } from "../world-editor-drafts";
import { WorldInfoAdvancedFields } from "./WorldInfoAdvancedFields";
import { WorldInfoVectorSettings } from "./WorldInfoVectorSettings";
import { openCharacterWorldInfoEditor } from "../character-world-info-editor";

/** A real editor stays mounted while closed so extension selectors operate on
 * the same controls the user opens, not hidden compatibility-only duplicates. */
export function WorldInfoPanel({ open, online, character, onClose }: { open: boolean; online: boolean; character?: CharacterDetail | null; onClose(): void }) {
  const runtime = useRef<WorldInfoRuntime | null>(null);
  const drafts = useRef<WorldDraftStore | null>(null);
  const base = useRef<WorldInfoDocument | null>(null);
  const [name, setName] = useState("");
  const [newName, setNewName] = useState("");
  const [document, setDocument] = useState<WorldInfoDocument | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draftNotice, setDraftNotice] = useState("");
  const [ready, setReady] = useState(false);
  const characterId = useRef(character?.id); characterId.current = character?.id;
  const current = useRef({ name, dirty, document });
  function show(nextName: string, nextDocument: WorldInfoDocument | null, nextDirty: boolean) {
    current.current = { name: nextName, dirty: nextDirty, document: nextDocument };
    setName(nextName); setDocument(nextDocument); setDirty(nextDirty);
  }
  function checkpoint() {
    const value = current.current;
    if (value.name && value.dirty && value.document && base.current) drafts.current?.write(value.name, { base: base.current, document: value.document });
  }
  const loadRevision = useRef(0);
  useEffect(() => {
    if (!online) return;
    let disposed = false;
    async function select(event: Event) {
      const selected = (event as CustomEvent<{ name: string }>).detail.name;
      checkpoint();
      const revision = ++loadRevision.current;
      try {
        const next = selected ? await runtime.current!.loadWorldInfo(selected) : null;
        if (disposed || revision !== loadRevision.current) return;
        const draft = drafts.current?.read(selected);
        base.current = next ?? draft?.base ?? null;
        show(selected, draft ? next ? drafts.current!.merge(draft.base, draft.document, next) : draft.document : next, Boolean(draft));
        drafts.current?.select(selected);
        setDraftNotice(draft ? "已恢复未保存的草稿；点击保存后才会用于对话。" : ""); setError("");
      } catch (error) { if (!disposed && revision === loadRevision.current) setError(String(error)); }
    }
    function changed(event: Event) {
      const detail = (event as CustomEvent<{ name?: string; deleted?: boolean }>).detail;
      if (detail?.name === current.current.name && !current.current.dirty) void select(new CustomEvent("select", { detail: { name: detail.deleted ? "" : detail.name } }));
    }
    window.addEventListener("mycompanion:world-editor", select);
    window.addEventListener("mycompanion:world-info", changed);
    void loadWorldInfoRuntime().then(async module => {
      if (disposed) return;
      runtime.current = module;
      drafts.current = await loadWorldDraftStore();
      if (disposed) return;
      module.syncWorldInfoControls();
      setReady(true);
      if (drafts.current.selected()) module.selectWorldInfoEditor(drafts.current.selected());
    }).catch(error => { if (!disposed) setError(String(error)); });
    return () => { disposed = true; window.removeEventListener("mycompanion:world-editor", select); window.removeEventListener("mycompanion:world-info", changed); };
  }, [online]);
  async function action(operation: () => Promise<void>, isCurrent = () => true) {
    setBusy(true); setError("");
    try { await operation(); } catch (error) { if (isCurrent()) setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  function edit(uid: string, patch: Record<string, unknown>) {
    const value = current.current.document;
    if (value) { show(current.current.name, { ...value, entries: { ...value.entries, [uid]: { ...value.entries[uid], ...patch } } }, true); checkpoint(); }
  }
  return <aside className="world-info-dock" hidden={!open} aria-label="世界书编辑器">
    <header><h2>世界书</h2><button type="button" onClick={onClose}>关闭</button></header>
    {error ? <p role="alert">{error}</p> : null}
    {draftNotice ? <p role="status">{draftNotice}</p> : null}
    {character && (character.lorebookEntryCount > 0 || typeof character.rawExtensions.world === "string") ? <button type="button" data-edit-character-world-info disabled={!online || !ready || busy} onClick={() => {
      const id = character.id, revision = loadRevision.current;
      const isCurrent = () => characterId.current === id && loadRevision.current === revision;
      void action(async () => {
        const name = await openCharacterWorldInfoEditor(character, runtime.current!, isCurrent);
        if (name && isCurrent()) runtime.current!.selectWorldInfoEditor(name);
      }, isCurrent);
    }}>编辑 {character.name} 的世界书</button> : null}
    <label>全局启用<select id="world_info" multiple aria-label="全局启用的世界书" /></label>
    <details><summary>匹配设置</summary><div className="world-info-settings">
      {[["world_info_depth", "扫描消息数"], ["world_info_budget", "上下文占比（%）"], ["world_info_budget_cap", "Token 上限（0 为不限）"], ["world_info_max_recursion_steps", "递归轮数（0 为不限）"], ["world_info_min_activations", "至少激活条目数（0 为停用）"], ["world_info_min_activations_depth_max", "扩展扫描消息上限（0 为不限）"]].map(([id, label]) => <label key={id}>{label}<input id={id} data-world-info-setting type="number" min={0} /></label>)}
      {[["world_info_include_names", "扫描发言者名字"], ["world_info_recursive", "递归匹配"], ["world_info_case_sensitive", "区分大小写"], ["world_info_match_whole_words", "整词匹配"], ["world_info_use_group_scoring", "按关键词匹配数量选择互斥组条目"]].map(([id, label]) => <label key={id}><input id={id} data-world-info-setting type="checkbox" />{label}</label>)}
      <label>角色与全局书优先级<select id="world_info_character_strategy" data-world-info-setting><option value="0">按条目顺序</option><option value="1">角色优先</option><option value="2">全局优先</option></select></label>
    </div></details>
    <label>编辑世界书<select id="world_editor_select" aria-label="编辑世界书" disabled={busy} /></label>
    <WorldInfoVectorSettings online={online} />
    <div className="world-info-actions">
      <input aria-label="新世界书名称" placeholder="新世界书名称" value={newName} onChange={event => setNewName(event.target.value)} />
      <button disabled={!online || busy || !newName.trim()} type="button" onClick={() => void action(async () => {
        if (!await runtime.current!.createNewWorldInfo(newName.trim())) throw new Error("同名世界书已存在，或名称无效。");
        setNewName("");
      })}>新建</button>
      <label>导入 JSON<input aria-label="导入世界书 JSON" type="file" accept="application/json,.json" disabled={!online || busy} onChange={event => {
        const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
        void action(async () => {
          const data = worldInfoDocumentSchema.parse(JSON.parse(await file.text()));
          const response = await fetch('/api/files/sanitize-filename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileName: newName.trim() || file.name.replace(/\.json$/i, "") }) });
          if (!response.ok) throw new Error("无法确认世界书名称。");
          const { fileName: target } = await response.json() as { fileName: string };
          // Creation detects duplicates; a failed import never overwrites a book.
          if (!await runtime.current!.createNewWorldInfo(target)) throw new Error("同名世界书已存在，请指定新的名称。");
          await runtime.current!.saveWorldInfo(target, data, true); runtime.current!.selectWorldInfoEditor(target);
        });
      }} /></label>
    </div>
    {document ? <section aria-label="世界书条目">
      <h3>{name}{dirty ? " · 未保存" : ""}</h3>
      <div className="world-info-actions"><button type="button" disabled={busy} onClick={() => {
        let uid = 0; while (Object.hasOwn(document.entries, String(uid))) uid++;
        edit(String(uid), { ...structuredClone(runtime.current!.newWorldInfoEntryTemplate), uid });
      }}>添加条目</button><button type="button" disabled={busy || !dirty} onClick={() => void action(async () => {
        const snapshot = current.current;
        await runtime.current!.saveWorldInfo(snapshot.name, snapshot.document!, true);
        if (current.current.name === snapshot.name) {
          base.current = snapshot.document;
          if (current.current.document === snapshot.document) { show(snapshot.name, snapshot.document, false); drafts.current!.remove(snapshot.name); setDraftNotice(""); }
          else checkpoint();
        }
        await drafts.current!.flush();
      })}>保存世界书</button>
      <button type="button" disabled={busy || !dirty} onClick={() => void action(async () => {
        if (!window.confirm("放弃这本世界书的未保存修改？")) return;
        const next = await runtime.current!.loadWorldInfo(name);
        drafts.current!.remove(name); base.current = next; show(name, next, false); setDraftNotice(""); await drafts.current!.flush();
      })}>放弃草稿</button>
      <button type="button" disabled={busy} onClick={() => void action(async () => {
        const path = "/scripts/popup.js"; const { Popup } = await import(/* @vite-ignore */ path);
        if (!await Popup.show.confirm("删除世界书", "是否删除当前世界书及其所有条目？")) return;
        if (!await runtime.current!.deleteWorldInfo(name)) throw new Error("删除失败，请重试。");
        drafts.current!.remove(name); drafts.current!.select(""); base.current = null; show("", null, false); setDraftNotice(""); await drafts.current!.flush();
      })}>删除世界书</button></div>
      {Object.entries(document.entries).map(([uid, entry]) => <fieldset key={uid} data-world-info-entry={uid}>
        <label>条目名称<input data-world-info-field="comment" value={String(entry.comment ?? "")} onChange={event => edit(uid, { comment: event.target.value })} /></label>
        <label><input data-world-info-field="enabled" type="checkbox" checked={!entry.disable} onChange={event => edit(uid, { disable: !event.target.checked })} />启用</label>
        <label><input data-world-info-field="constant" type="checkbox" checked={Boolean(entry.constant)} onChange={event => edit(uid, { constant: event.target.checked })} />常驻</label>
        <label>关键词（每行一个）<textarea data-world-info-field="key" value={Array.isArray(entry.key) ? entry.key.join("\n") : ""} onChange={event => edit(uid, { key: event.target.value.split("\n").filter(Boolean) })} /></label>
        <label>内容<textarea data-world-info-field="content" rows={4} value={String(entry.content ?? "")} onChange={event => edit(uid, { content: event.target.value })} /></label>
        <WorldInfoAdvancedFields entry={entry} onChange={patch => edit(uid, patch)} />
        <button type="button" onClick={() => { const entries = { ...document.entries }; delete entries[uid]; show(name, { ...document, entries }, true); checkpoint(); }}>移除条目</button>
      </fieldset>)}
    </section> : <p>选择或新建一本世界书，在需要时向对话补充背景设定。</p>}
  </aside>;
}
