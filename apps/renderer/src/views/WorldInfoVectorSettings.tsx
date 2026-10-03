import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { loadSharedExtensionSettings, onSharedExtensionSettingsSaved, saveSharedExtensionSettings } from "../extension-settings";
import "../i18n";

interface VectorSettings {
  enabled_world_info: boolean; enabled_for_all: boolean; query: number; max_entries: number; score_threshold: number;
}
const defaults: VectorSettings = { enabled_world_info: false, enabled_for_all: false, query: 2, max_entries: 5, score_threshold: .25 };
function read(root: Record<string, unknown>): VectorSettings {
  const raw = root.vectors;
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const number = (key: string, fallback: number) => typeof value[key] === "number" && Number.isFinite(value[key]) ? Number(value[key]) : fallback;
  return { enabled_world_info: value.enabled_world_info === true, enabled_for_all: value.enabled_for_all === true,
    query: Math.max(0, Math.floor(number("query", 2))), max_entries: Math.max(1, Math.floor(number("max_entries", 5))), score_threshold: number("score_threshold", .25) };
}

/** The same mutable extension settings namespace used by the original vector code.
 * Save only the changed field, preserving plugin-owned and future properties. */
export function WorldInfoVectorSettings({ online }: { online: boolean }) {
  const { i18n } = useTranslation(), en = i18n.language.startsWith("en");
  const root = useRef<Record<string, unknown> | null>(null);
  const [settings, setSettings] = useState(defaults), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!online) return;
    let disposed = false, unsubscribe: (() => void) | undefined;
    void loadSharedExtensionSettings().then(settingsRoot => {
      if (disposed) return;
      root.current = settingsRoot; setSettings(read(settingsRoot)); setReady(true);
      unsubscribe = onSharedExtensionSettingsSaved(() => { if (!disposed && root.current) setSettings(read(root.current)); });
    }).catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { disposed = true; unsubscribe?.(); };
  }, [online]);
  async function change<K extends keyof VectorSettings>(key: K, value: VectorSettings[K]) {
    const settingsRoot = root.current;
    if (!settingsRoot || busy) return;
    const previous = read(settingsRoot);
    const raw = settingsRoot.vectors;
    const vectors = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    settingsRoot.vectors = { ...vectors, [key]: value };
    setSettings(read(settingsRoot)); setBusy(true); setError("");
    try { await saveSharedExtensionSettings(); }
    catch (cause) {
      // Show the unsaved value for a retry; the shared queue retains failed
      // patches, so pretending it reverted would silently save it later.
      setError("向量设置保存失败，请再次选择设置重试。" + (cause instanceof Error ? cause.message : String(cause)));
      setSettings({ ...previous, [key]: value });
    } finally { setBusy(false); }
  }
  return <details className="world-info-vectors"><summary>{en ? "Vector matching" : "向量匹配"}</summary>
    <p>{en ? "Choose an embedding model in model connections first. Vector matching supplements keyword matches. Missing settings and request failures are reported." : "先在模型连接中为 Embedding 任务选择模型。向量匹配补充关键词匹配；未配置或请求失败时会显示原因。"}</p>
    {error ? <p role="alert">{en ? error.replace("向量设置保存失败，请再次选择设置重试。", "Could not save vector settings. Choose the setting again to retry. ") : error}</p> : null}
    <fieldset disabled={!online || !ready || busy} className="world-info-settings">
      <label><input data-vector-setting="enabled_world_info" type="checkbox" checked={settings.enabled_world_info} onChange={event => void change("enabled_world_info", event.target.checked)} />{en ? "Enable worldbook vector matching" : "启用世界书向量匹配"}</label>
      <label><input data-vector-setting="enabled_for_all" type="checkbox" checked={settings.enabled_for_all} onChange={event => void change("enabled_for_all", event.target.checked)} />{en ? "Use all enabled worldbook entries for vector matching" : "所有已启用的世界书条目参与向量匹配"}</label>
      <label>{en ? "Recent messages to query" : "查询最近消息数"}<input data-vector-setting="query" type="number" min={0} value={settings.query} onChange={event => { if (event.target.value !== "" && Number.isFinite(event.target.valueAsNumber)) void change("query", Math.max(0, Math.floor(event.target.valueAsNumber))); }} /></label>
      <label>{en ? "Maximum active entries" : "最多激活条目"}<input data-vector-setting="max_entries" type="number" min={1} value={settings.max_entries} onChange={event => { if (event.target.value !== "" && Number.isFinite(event.target.valueAsNumber)) void change("max_entries", Math.max(1, Math.floor(event.target.valueAsNumber))); }} /></label>
      <label>{en ? "Similarity threshold" : "相似度阈值"}<input data-vector-setting="score_threshold" type="number" step="0.05" value={settings.score_threshold} onChange={event => { if (event.target.value !== "" && Number.isFinite(event.target.valueAsNumber)) void change("score_threshold", event.target.valueAsNumber); }} /></label>
    </fieldset>
  </details>;
}
