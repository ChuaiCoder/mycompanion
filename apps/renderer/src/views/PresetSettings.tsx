import { useEffect, useRef, useState } from "react";
import { Notice } from "../components";

interface PresetManager {
  getSelectedPresetName(): string;
  getCompletionPresetByName(name: string): unknown;
  savePresetAs(): Promise<void>;
  updatePreset(): Promise<void>;
  renamePreset(name: string): Promise<void>;
  deletePreset(): Promise<boolean>;
  savePreset(name: string, preset: unknown): Promise<void>;
}
interface PresetRuntime {
  loadPresets(): Promise<void>;
  getPresetManager(): PresetManager;
  mountPresetSelect(container: HTMLElement): () => void;
  getChatCompletionPreset(): unknown;
}
export function PresetSettings() {
  const container = useRef<HTMLDivElement>(null);
  const [runtime, setRuntime] = useState<PresetRuntime | null>(null);
  const [name, setName] = useState("");
  const [bound, setBound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false, unmount: (() => void) | undefined;
    let update = () => {};
    const path = "/scripts/preset-manager.js", settingsPath = "/plugin-runtime/openai-settings.js";
    void Promise.all([import(/* @vite-ignore */ path), import(/* @vite-ignore */ settingsPath)]).then(async ([presets, settings]) => {
      await presets.loadPresets();
      if (disposed || !container.current) return;
      unmount = presets.mountPresetSelect(container.current);
      setRuntime(presets as PresetRuntime);
      update = () => { setName(presets.getPresetManager().getSelectedPresetName()); setBound(!!settings.oai_settings.bind_preset_to_connection); };
      update();
      window.addEventListener("mycompanion:presets-changed", update);
    }).catch(reason => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; unmount?.(); window.removeEventListener("mycompanion:presets-changed", update); };
  }, []);
  const run = (action: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    void action().catch(reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(false));
  };
  return <section className="settings-card" aria-labelledby="presets-title">
    <header><h2 id="presets-title">聊天补全预设</h2><p>保存和切换生成参数，支持导入酒馆 JSON 预设。提示词编排与完整酒馆助手兼容仍在开发中。</p></header>
    {error ? <Notice tone="error">{error}</Notice> : null}
    <div className="settings-form">
      <label htmlFor="settings_preset_openai">当前预设</label><div ref={container} />
      <label><span><input type="checkbox" checked={bound} disabled={busy || !runtime} onChange={event => {
        const value = event.target.checked;
        run(async () => {
          const path = "/plugin-runtime/openai-settings.js", savePath = "/plugin-runtime/settings.js";
          const { oai_settings } = await import(/* @vite-ignore */ path);
          oai_settings.bind_preset_to_connection = value;
          await (await import(/* @vite-ignore */ savePath)).saveSettings(); setBound(value);
        });
      }} /> 随预设切换连接地址和模型</span></label>
      <div className="settings-actions">
        <button className="button button--primary" disabled={busy || !runtime} onClick={() => run(() => runtime!.getPresetManager().savePresetAs())}>另存为</button>
        <button className="button button--quiet" disabled={busy || !name} onClick={() => run(() => runtime!.getPresetManager().updatePreset())}>保存当前预设</button>
        <button className="button button--quiet" disabled={busy || !name} onClick={() => run(async () => {
          const path = "/scripts/popup.js", { Popup } = await import(/* @vite-ignore */ path);
          const next = await Popup.show.input("重命名预设", "", name);
          if (next) await runtime!.getPresetManager().renamePreset(next);
        })}>重命名</button>
        <button className="button button--quiet" disabled={busy || !name} onClick={() => run(async () => {
          const path = "/scripts/popup.js", { Popup } = await import(/* @vite-ignore */ path);
          const question = document.createElement("p"); question.textContent = `删除“${name}”？`;
          if (await Popup.show.confirm("删除预设", question)) await runtime!.getPresetManager().deletePreset();
        })}>删除</button>
        <button className="button button--quiet" disabled={busy || !runtime} onClick={() => {
          const url = URL.createObjectURL(new Blob([JSON.stringify(runtime!.getChatCompletionPreset(), null, 2)], { type: "application/json" }));
          const link = document.createElement("a"); link.href = url; link.download = (name || "preset") + ".json"; link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}>导出当前参数</button>
      </div>
      <label><span>导入 JSON 预设</span><input type="file" accept=".json,application/json" disabled={busy || !runtime} onChange={event => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (file) run(async () => {
          const data: unknown = JSON.parse(await file.text());
          if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("预设必须是 JSON 对象。");
          const presetName = file.name.replace(/\.json$/i, "");
          const path = "/plugin-runtime/compat-runtime.js", { eventSource, event_types } = await import(/* @vite-ignore */ path);
          await eventSource.emit(event_types.OAI_PRESET_IMPORT_READY, { data, presetName });
          await runtime!.getPresetManager().savePreset(presetName, data);
        });
      }} /></label>
    </div>
  </section>;
}
