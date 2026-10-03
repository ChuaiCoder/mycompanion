import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { loadExtensionHost } from "../ExtensionHost";
import "../i18n";

interface VectorSettings {
  enabled_world_info: boolean; enabled_for_all: boolean; query: number; max_entries: number; score_threshold: number;
}
interface SettingsRuntime {
  extension_settings: Record<string, unknown>;
  saveSettings(): Promise<void>;
  onExtensionSettingsSaved(callback: () => void): () => void;
}
const defaults: VectorSettings = { enabled_world_info: false, enabled_for_all: false, query: 2, max_entries: 5, score_threshold: .25 };
function read(runtime: SettingsRuntime): VectorSettings {
  const raw = runtime.extension_settings.vectors;
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const number = (key: string, fallback: number) => typeof value[key] === "number" && Number.isFinite(value[key]) ? Number(value[key]) : fallback;
  return { enabled_world_info: value.enabled_world_info === true, enabled_for_all: value.enabled_for_all === true,
    query: Math.max(0, Math.floor(number("query", 2))), max_entries: Math.max(1, Math.floor(number("max_entries", 5))), score_threshold: number("score_threshold", .25) };
}

/** The same mutable extension_settings namespace used by original vector code.
 * Save only the changed field, preserving plugin-owned and future properties. */
export function WorldInfoVectorSettings({ online }: { online: boolean }) {
  const { i18n } = useTranslation(), en = i18n.language.startsWith("en");
  const runtime = useRef<SettingsRuntime | null>(null);
  const [settings, setSettings] = useState(defaults), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!online) return;
    let disposed = false, unsubscribe: (() => void) | undefined;
    void loadExtensionHost().then(async () => {
      const path = "/plugin-runtime/settings.js";
      const module = await import(/* @vite-ignore */ path) as SettingsRuntime;
      if (disposed) return;
      runtime.current = module; setSettings(read(module)); setReady(true);
      unsubscribe = module.onExtensionSettingsSaved(() => { if (!disposed) setSettings(read(module)); });
    }).catch(error => { if (!disposed) setError(error instanceof Error ? error.message : String(error)); });
    return () => { disposed = true; unsubscribe?.(); };
  }, [online]);
  async function change<K extends keyof VectorSettings>(key: K, value: VectorSettings[K]) {
    const module = runtime.current;
    if (!module || busy) return;
    const previous = read(module);
    const raw = module.extension_settings.vectors;
    const vectors = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    module.extension_settings.vectors = { ...vectors, [key]: value };
    setSettings(read(module)); setBusy(true); setError("");
    try { await module.saveSettings(); }
    catch (error) {
      // Show the unsaved value for a retry; the shared queue retains failed
      // patches, so pretending it reverted would silently save it later.
      setError("向量设置保存失败，请再次选择设置重试。" + (error instanceof Error ? error.message : String(error)));
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
