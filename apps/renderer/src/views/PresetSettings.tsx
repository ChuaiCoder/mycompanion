import { useEffect, useRef, useState } from "react";
import type { ProviderSettings } from "@mycompanion/shared";
import { getProviderSettings, saveProviderSettings } from "../api";
import { loadSharedExtensionSettings, saveSharedExtensionSettings } from "../extension-settings";
import { Notice } from "../components";

interface PresetEntry { name: string; preset: Record<string, unknown> }

// 预设内容 = 生成参数快照。连接字段（来源/地址/模型）只在勾选“随预设切换连接”时应用。
// 导入的酒馆 JSON 预设按常见键名映射（temperature / openai_max_tokens / openai_max_context）。
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
function generationPatch(preset: Record<string, unknown>, bound: boolean): Partial<ProviderSettings> {
  const patch: Partial<ProviderSettings> = {};
  const temperature = number(preset.temperature);
  const maxTokens = number(preset.maxTokens) ?? number(preset.openai_max_tokens);
  const contextLimitTokens = number(preset.contextLimitTokens) ?? number(preset.openai_max_context);
  if (temperature !== undefined) patch.temperature = temperature;
  if (maxTokens !== undefined) patch.maxTokens = Math.max(1, Math.floor(maxTokens));
  if (contextLimitTokens !== undefined) patch.contextLimitTokens = Math.max(1, Math.floor(contextLimitTokens));
  if (bound) {
    if (preset.kind === "openai-compatible" || preset.kind === "ollama" || preset.kind === "anthropic" || preset.kind === "gemini") patch.kind = preset.kind;
    if (typeof preset.baseUrl === "string" && preset.baseUrl) patch.baseUrl = preset.baseUrl;
    if (typeof preset.model === "string" && preset.model) patch.model = preset.model;
  }
  return patch;
}
function captureProvider(provider: ProviderSettings): Record<string, unknown> {
  return { kind: provider.kind, baseUrl: provider.baseUrl, model: provider.model,
    temperature: provider.temperature, maxTokens: provider.maxTokens, contextLimitTokens: provider.contextLimitTokens };
}

export function PresetSettings() {
  const [entries, setEntries] = useState<PresetEntry[]>([]);
  const [selected, setSelected] = useState("");
  const [bound, setBound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [ready, setReady] = useState(false);
  const operation = useRef(0);
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const [response, settings] = await Promise.all([
          fetch("/api/presets/openai", { headers: { Accept: "application/json" } }),
          loadSharedExtensionSettings().catch(() => null),
        ]);
        if (!response.ok) throw new Error(`预设列表读取失败（HTTP ${response.status}）。`);
        const payload = await response.json() as { entries?: unknown };
        if (disposed) return;
        setEntries(Array.isArray(payload.entries) ? payload.entries as PresetEntry[] : []);
        const preferences = settings?.__mycompanion_preferences as Record<string, unknown> | undefined;
        setBound(preferences?.bind_preset_to_connection === true);
        setReady(true);
      } catch (cause) { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); }
    })();
    return () => { disposed = true; };
  }, []);
  const run = (action: () => Promise<void>) => {
    const attempt = ++operation.current;
    setBusy(true); setError(null); setNotice("");
    void action().catch(cause => {
      if (attempt === operation.current) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (attempt === operation.current) setBusy(false); });
  };
  async function savePreset(name: string, preset: Record<string, unknown>): Promise<void> {
    const response = await fetch("/api/presets/save", {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ apiId: "openai", name, preset }),
    });
    if (!response.ok) throw new Error(`预设保存失败（HTTP ${response.status}）。`);
    setEntries(current => {
      const index = current.findIndex(item => item.name === name);
      return index < 0 ? [...current, { name, preset }] : current.map((item, itemIndex) => itemIndex === index ? { name, preset } : item);
    });
    setSelected(name);
  }
  async function apply(entry: PresetEntry): Promise<void> {
    const provider = await getProviderSettings();
    const patch = generationPatch(entry.preset, bound);
    const saved = await saveProviderSettings({
      kind: patch.kind ?? provider.kind, baseUrl: patch.baseUrl ?? provider.baseUrl, model: patch.model ?? provider.model,
      temperature: patch.temperature ?? provider.temperature, maxTokens: patch.maxTokens ?? provider.maxTokens,
      contextLimitTokens: patch.contextLimitTokens ?? provider.contextLimitTokens, clearApiKey: false,
    });
    window.dispatchEvent(new CustomEvent("mycompanion:provider-saved", { detail: saved }));
    setNotice(`已应用预设“${entry.name}”。`);
  }
  async function changeBound(value: boolean): Promise<void> {
    const settings = await loadSharedExtensionSettings();
    const preferences = settings.__mycompanion_preferences ??= {};
    (preferences as Record<string, unknown>).bind_preset_to_connection = value;
    await saveSharedExtensionSettings();
    setBound(value);
  }
  const current = entries.find(item => item.name === selected);
  return <section className="settings-card" aria-labelledby="presets-title">
    <header><h2 id="presets-title">聊天补全预设</h2><p>保存和切换生成参数快照；选中预设即应用到当前模型连接。支持导入酒馆 JSON 预设（映射温度与 Token 参数）。</p></header>
    {error ? <Notice tone="error">{error}</Notice> : null}
    {notice ? <Notice tone="success">{notice}</Notice> : null}
    <div className="settings-form">
      <label htmlFor="settings_preset_openai">当前预设</label>
      <select id="settings_preset_openai" aria-label="当前预设" disabled={busy || !ready} value={selected} onChange={event => {
        const name = event.target.value;
        setSelected(name);
        const entry = entries.find(item => item.name === name);
        if (entry) run(() => apply(entry));
      }}>
        <option value="">（未选择）</option>
        {entries.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
      </select>
      <label><span><input type="checkbox" checked={bound} disabled={busy || !ready} onChange={event => {
        const value = event.target.checked;
        run(() => changeBound(value));
      }} /> 随预设切换连接地址和模型</span></label>
      <div className="settings-actions">
        <button className="button button--primary" disabled={busy || !ready} onClick={() => run(async () => {
          const name = window.prompt("把当前生成参数另存为预设，输入预设名称：", selected || "");
          if (!name?.trim()) return;
          await savePreset(name.trim(), captureProvider(await getProviderSettings()));
        })}>另存为</button>
        <button className="button button--quiet" disabled={busy || !current} onClick={() => run(async () => {
          await savePreset(current!.name, captureProvider(await getProviderSettings()));
          setNotice(`已用当前参数更新预设“${current!.name}”。`);
        })}>保存当前预设</button>
        <button className="button button--quiet" disabled={busy || !current} onClick={() => run(async () => {
          const next = window.prompt("重命名预设", current!.name);
          if (!next?.trim() || next.trim() === current!.name) return;
          const response = await fetch("/api/presets/rename", {
            method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({ apiId: "openai", name: current!.name, newName: next.trim(), preset: current!.preset }),
          });
          if (response.status === 409) throw new Error("同名预设已存在，请换一个名称。");
          if (!response.ok) throw new Error(`预设重命名失败（HTTP ${response.status}）。`);
          setEntries(items => items.map(item => item.name === current!.name ? { name: next.trim(), preset: current!.preset } : item));
          setSelected(next.trim());
        })}>重命名</button>
        <button className="button button--quiet" disabled={busy || !current} onClick={() => run(async () => {
          if (!window.confirm(`删除“${current!.name}”？`)) return;
          const response = await fetch("/api/presets/delete", {
            method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({ apiId: "openai", name: current!.name }),
          });
          if (!response.ok) throw new Error(`预设删除失败（HTTP ${response.status}）。`);
          setEntries(items => items.filter(item => item.name !== current!.name));
          setSelected("");
        })}>删除</button>
        <button className="button button--quiet" disabled={busy || !current} onClick={() => {
          const url = URL.createObjectURL(new Blob([JSON.stringify(current!.preset, null, 2)], { type: "application/json" }));
          const link = document.createElement("a"); link.href = url; link.download = (current!.name || "preset") + ".json"; link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}>导出当前参数</button>
      </div>
      <label><span>导入 JSON 预设</span><input type="file" accept=".json,application/json" disabled={busy || !ready} onChange={event => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (file) run(async () => {
          const data: unknown = JSON.parse(await file.text());
          if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("预设必须是 JSON 对象。");
          await savePreset(file.name.replace(/\.json$/i, ""), data as Record<string, unknown>);
        });
      }} /></label>
    </div>
  </section>;
}
