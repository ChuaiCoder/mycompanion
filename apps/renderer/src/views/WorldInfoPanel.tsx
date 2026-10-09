import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "../i18n";
import { worldInfoDocumentSchema, type CharacterDetail, type WorldInfoDocument, type WorldInfoSettings } from "@mycompanion/shared";
import {
  createWorldInfo,
  deleteWorldInfo,
  getWorldInfoSettings,
  listWorldInfoNames,
  loadWorldInfo,
  newWorldInfoEntryTemplate,
  saveWorldInfo,
  saveWorldInfoSettings,
} from "../world-info-api";
import { loadWorldDraftStore, type WorldDraftStore } from "../world-editor-drafts";
import { WorldInfoAdvancedFields } from "./WorldInfoAdvancedFields";
import { WorldInfoVectorSettings } from "./WorldInfoVectorSettings";
import { openCharacterWorldInfoEditor } from "../character-world-info-editor";

/** A real editor stays mounted while closed so selection state survives reopening. */
export function WorldInfoPanel({ open, online, character, onClose }: { open: boolean; online: boolean; character?: CharacterDetail | null; onClose(): void }) {
  const drafts = useRef<WorldDraftStore | null>(null);
  const { t } = useTranslation();
  const base = useRef<WorldInfoDocument | null>(null);
  const [worldNames, setWorldNames] = useState<string[]>([]);
  const [settings, setSettings] = useState<WorldInfoSettings | null>(null);
  const settingsRoot = useRef<WorldInfoSettings | null>(null);
  function applySettings(value: WorldInfoSettings | null) {
    settingsRoot.current = value; setSettings(value);
  }
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
  const settingsTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  function show(nextName: string, nextDocument: WorldInfoDocument | null, nextDirty: boolean) {
    current.current = { name: nextName, dirty: nextDirty, document: nextDocument };
    setName(nextName); setDocument(nextDocument); setDirty(nextDirty);
  }
  function checkpoint() {
    const value = current.current;
    if (value.name && value.dirty && value.document && base.current) drafts.current?.write(value.name, { base: base.current, document: value.document });
  }
  const loadRevision = useRef(0);
  async function select(selected: string) {
    checkpoint();
    const revision = ++loadRevision.current;
    try {
      const next = selected ? await loadWorldInfo(selected) : null;
      if (revision !== loadRevision.current) return;
      const draft = drafts.current?.read(selected);
      base.current = next ?? draft?.base ?? null;
      show(selected, draft ? next ? drafts.current!.merge(draft.base, draft.document, next) : draft.document : next, Boolean(draft));
      drafts.current?.select(selected);
      setDraftNotice(draft ? "已恢复未保存的草稿；点击保存后才会用于对话。" : ""); setError("");
    } catch (cause) { if (revision === loadRevision.current) setError(String(cause)); }
  }
  function updateSettings(patch: Partial<WorldInfoSettings>) {
    const value = settingsRoot.current;
    if (!value) return;
    const next = { ...value, ...patch };
    applySettings(next);
    if (settingsTimer.current) clearTimeout(settingsTimer.current);
    settingsTimer.current = setTimeout(() => {
      settingsTimer.current = undefined;
      void saveWorldInfoSettings(next).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
    }, 800);
  }
  useEffect(() => {
    if (!online) return;
    let disposed = false;
    function selected(event: Event) {
      void select((event as CustomEvent<{ name: string }>).detail.name);
    }
    function changed(event: Event) {
      const detail = (event as CustomEvent<{ name?: string; deleted?: boolean }>).detail;
      void Promise.all([listWorldInfoNames(), getWorldInfoSettings()]).then(([names, next]) => {
        if (disposed) return;
        setWorldNames(names); applySettings(next);
        if (detail?.name === current.current.name && !current.current.dirty) void select(detail.deleted ? "" : detail.name);
      }).catch(() => {});
    }
    window.addEventListener("mycompanion:world-editor", selected);
    window.addEventListener("mycompanion:world-info", changed);
    void (async () => {
      try {
        const [store, names, next] = await Promise.all([loadWorldDraftStore(), listWorldInfoNames(), getWorldInfoSettings()]);
        if (disposed) return;
        drafts.current = store;
        setWorldNames(names); applySettings(next); setReady(true);
        if (store.selected()) await select(store.selected());
      } catch (cause) { if (!disposed) setError(String(cause)); }
    })();
    return () => {
      disposed = true;
      window.removeEventListener("mycompanion:world-editor", selected);
      window.removeEventListener("mycompanion:world-info", changed);
      // Flush a pending settings write so closing the panel never loses it.
      if (settingsTimer.current) {
        clearTimeout(settingsTimer.current);
        settingsTimer.current = undefined;
        if (settingsRoot.current) void saveWorldInfoSettings(settingsRoot.current).catch(() => {});
      }
    };
  }, [online]);
  async function action(operation: () => Promise<void>, isCurrent = () => true) {
    setBusy(true); setError("");
    try { await operation(); } catch (cause) { if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  function edit(uid: string, patch: Record<string, unknown>) {
    const value = current.current.document;
    if (value) { show(current.current.name, { ...value, entries: { ...value.entries, [uid]: { ...value.entries[uid], ...patch } } }, true); checkpoint(); }
  }
  const numberSetting = (key: keyof WorldInfoSettings, label: string) => <label key={key}>{label}<input id={key} data-world-info-setting type="number" min={0}
    value={settings?.[key] as number ?? 0} disabled={!settings}
    onChange={event => { if (event.target.value !== "" && Number.isFinite(event.target.valueAsNumber)) updateSettings({ [key]: Math.max(0, Math.floor(event.target.valueAsNumber)) } as Partial<WorldInfoSettings>); }} /></label>;
  const boolSetting = (key: keyof WorldInfoSettings, label: string) => <label key={key}><input id={key} data-world-info-setting type="checkbox"
    checked={Boolean(settings?.[key])} disabled={!settings}
    onChange={event => updateSettings({ [key]: event.target.checked } as Partial<WorldInfoSettings>)} />{label}</label>;
  return <aside className="world-info-dock" hidden={!open} aria-label={t("世界书编辑器")}>
    <header><h2>{t("世界书")}</h2><button type="button" className="button button--quiet button--small" onClick={onClose}>{t("关闭")}</button></header>
    {error ? <p role="alert">{t(error)}</p> : null}
    {draftNotice ? <p role="status">{t(draftNotice)}</p> : null}
    {character && (character.lorebookEntryCount > 0 || typeof character.rawExtensions.world === "string") ? <button type="button" className="button button--quiet" data-edit-character-world-info disabled={!online || !ready || busy} onClick={() => {
      const id = character.id, revision = loadRevision.current;
      const isCurrent = () => characterId.current === id && loadRevision.current === revision;
      void action(async () => {
        const copied = await openCharacterWorldInfoEditor(character, isCurrent);
        if (copied && isCurrent()) {
          setWorldNames(await listWorldInfoNames());
          await select(copied);
        }
      }, isCurrent);
    }}>{t("编辑 {{name}} 的世界书", { name: character.name })}</button> : null}
    <label>{t("全局启用")}<select id="world_info" multiple aria-label={t("全局启用的世界书")} disabled={!settings}
      value={settings?.world_info.globalSelect ?? []}
      onChange={event => updateSettings({ world_info: { ...settings!.world_info, globalSelect: [...event.target.selectedOptions].map(option => option.value) } })}>
      {worldNames.map(world => <option key={world} value={world}>{world}</option>)}
    </select></label>
    <details><summary>{t("匹配设置")}</summary><div className="world-info-settings">
      {([["world_info_depth", "扫描消息数"], ["world_info_budget", "上下文占比（%）"], ["world_info_budget_cap", "Token 上限（0 为不限）"], ["world_info_max_recursion_steps", "递归轮数（0 为不限）"], ["world_info_min_activations", "至少激活条目数（0 为停用）"], ["world_info_min_activations_depth_max", "扩展扫描消息上限（0 为不限）"]] as const).map(([key, label]) => numberSetting(key, t(label)))}
      {([["world_info_include_names", "扫描发言者名字"], ["world_info_recursive", "递归匹配"], ["world_info_case_sensitive", "区分大小写"], ["world_info_match_whole_words", "整词匹配"], ["world_info_use_group_scoring", "按关键词匹配数量选择互斥组条目"]] as const).map(([key, label]) => boolSetting(key, t(label)))}
      <label>{t("角色与全局书优先级")}<select id="world_info_character_strategy" data-world-info-setting disabled={!settings}
        value={settings?.world_info_character_strategy ?? 1}
        onChange={event => updateSettings({ world_info_character_strategy: Number(event.target.value) })}>
        <option value={0}>{t("按条目顺序")}</option><option value={1}>{t("角色优先")}</option><option value={2}>{t("全局优先")}</option></select></label>
    </div></details>
    <label>{t("编辑世界书")}<select id="world_editor_select" aria-label={t("编辑世界书")} disabled={busy || !ready} value={name} onChange={event => void select(event.target.value)}>
      <option value="">{t("（未选择）")}</option>
      {worldNames.map(world => <option key={world} value={world}>{world}</option>)}
      {name && !worldNames.includes(name) ? <option value={name}>{name}</option> : null}
    </select></label>
    <WorldInfoVectorSettings online={online} />
    <div className="world-info-actions">
      <input aria-label={t("新世界书名称")} placeholder={t("新世界书名称")} value={newName} onChange={event => setNewName(event.target.value)} />
      <button className="button button--primary button--small" disabled={!online || busy || !newName.trim()} type="button" onClick={() => void action(async () => {
        if (!await createWorldInfo(newName.trim())) throw new Error("同名世界书已存在，或名称无效。");
        setWorldNames(await listWorldInfoNames());
        setNewName("");
      })}>{t("新建")}</button>
      <label>{t("导入 JSON")}<input aria-label={t("导入世界书 JSON")} type="file" accept="application/json,.json" disabled={!online || busy} onChange={event => {
        const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
        void action(async () => {
          const data = worldInfoDocumentSchema.parse(JSON.parse(await file.text()));
          const response = await fetch("/api/files/sanitize-filename", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fileName: newName.trim() || file.name.replace(/\.json$/i, "") }) });
          if (!response.ok) throw new Error("无法确认世界书名称。");
          const { fileName: target } = await response.json() as { fileName: string };
          // Creation detects duplicates; a failed import never overwrites a book.
          if (!await createWorldInfo(target)) throw new Error("同名世界书已存在，请指定新的名称。");
          await saveWorldInfo(target, data);
          setWorldNames(await listWorldInfoNames());
          await select(target);
        });
      }} /></label>
    </div>
    {document ? <section aria-label={t("世界书条目")}>
      <h3>{name}{dirty ? t(" · 未保存") : ""}</h3>
      <div className="world-info-actions"><button type="button" className="button button--quiet button--small" disabled={busy} onClick={() => {
        let uid = 0; while (Object.hasOwn(document.entries, String(uid))) uid++;
        edit(String(uid), { ...structuredClone(newWorldInfoEntryTemplate), uid });
      }}>{t("添加条目")}</button><button type="button" className="button button--primary button--small" disabled={busy || !dirty} onClick={() => void action(async () => {
        const snapshot = current.current;
        await saveWorldInfo(snapshot.name, snapshot.document!);
        if (current.current.name === snapshot.name) {
          base.current = snapshot.document;
          if (current.current.document === snapshot.document) { show(snapshot.name, snapshot.document, false); drafts.current!.remove(snapshot.name); setDraftNotice(""); }
          else checkpoint();
        }
        await drafts.current!.flush();
      })}>{t("保存世界书")}</button>
      <button type="button" className="button button--quiet button--small" disabled={busy || !dirty} onClick={() => void action(async () => {
        if (!window.confirm(t("放弃这本世界书的未保存修改？"))) return;
        const next = await loadWorldInfo(name);
        drafts.current!.remove(name); base.current = next; show(name, next, false); setDraftNotice(""); await drafts.current!.flush();
      })}>{t("放弃草稿")}</button>
      <button type="button" className="button button--quiet button--small" disabled={busy} onClick={() => void action(async () => {
        if (!window.confirm(t("是否删除当前世界书及其所有条目？"))) return;
        if (!await deleteWorldInfo(name)) throw new Error("删除失败，请重试。");
        drafts.current!.remove(name); drafts.current!.select(""); base.current = null; show("", null, false); setDraftNotice(""); await drafts.current!.flush();
      })}>{t("删除世界书")}</button></div>
      {Object.entries(document.entries).map(([uid, entry]) => <fieldset key={uid} data-world-info-entry={uid}>
        <label>{t("条目名称")}<input data-world-info-field="comment" value={String(entry.comment ?? "")} onChange={event => edit(uid, { comment: event.target.value })} /></label>
        <label><input data-world-info-field="enabled" type="checkbox" checked={!entry.disable} onChange={event => edit(uid, { disable: !event.target.checked })} />{t("启用")}</label>
        <label><input data-world-info-field="constant" type="checkbox" checked={Boolean(entry.constant)} onChange={event => edit(uid, { constant: event.target.checked })} />{t("常驻")}</label>
        <label>{t("关键词（每行一个）")}<textarea data-world-info-field="key" value={Array.isArray(entry.key) ? entry.key.join("\n") : ""} onChange={event => edit(uid, { key: event.target.value.split("\n").filter(Boolean) })} /></label>
        <label>{t("内容")}<textarea data-world-info-field="content" rows={4} value={String(entry.content ?? "")} onChange={event => edit(uid, { content: event.target.value })} /></label>
        <WorldInfoAdvancedFields entry={entry} onChange={patch => edit(uid, patch)} />
        <button type="button" className="button button--quiet button--small" onClick={() => { const entries = { ...document.entries }; delete entries[uid]; show(name, { ...document, entries }, true); checkpoint(); }}>{t("移除条目")}</button>
      </fieldset>)}
    </section> : <p>{t("选择或新建一本世界书，在需要时向对话补充背景设定。")}</p>}
  </aside>;
}
