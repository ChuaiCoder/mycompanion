import type { InstalledPlugin } from "@mycompanion/shared";
import { useTranslation } from "react-i18next";

import { Notice } from "../components";
import { pluginDiagnostic, pluginText } from "../plugin-translations";

export interface PluginsViewProps {
  plugins: InstalledPlugin[];
  runtimeError: string | null;
  onPluginToggle: (plugin: InstalledPlugin) => void;
  onPluginUninstall: (id: string) => void;
}

export function PluginsView(props: PluginsViewProps) {
  const { i18n } = useTranslation();
  const text = (value: string) => pluginText(i18n.language, value);
  const diagnostic = (value: string) => pluginDiagnostic(i18n.language, value);
  const { plugins } = props;
  return (
    <main className="settings-workspace">
      <header className="settings-page-head"><h1>{text("插件")}</h1><p>{text("声明式插件是纯数据的提示词插件：声明注入的提示词与斜杠命令，不包含可执行代码。可在此启用、停用或卸载。")}</p></header>
      <section className="settings-card plugin-center" aria-label={text("插件")}>
        {props.runtimeError ? <Notice tone="error">{diagnostic(props.runtimeError)}</Notice> : null}
        {!plugins.length ? <p className="panel-empty">{text("还没有安装插件。")}</p> : null}
        <ul className="plugin-list">
          {plugins.map((plugin) => (
            <li key={plugin.id}>
              <div>
                <strong>{plugin.name}</strong>
                <span>v{plugin.version} · {plugin.author || text("未知作者")} · {plugin.license}</span>
                <small>{diagnostic(plugin.enabled ? "已启用" : "已停用")}</small>
              </div>
              <div className="plugin-actions">
                <button className={`button ${plugin.enabled ? "button--quiet" : "button--primary"}`} onClick={() => props.onPluginToggle(plugin)} type="button">{text(plugin.enabled ? "停用" : "启用")}</button>
                <button className="button button--quiet" onClick={() => props.onPluginUninstall(plugin.id)} type="button">{text("卸载")}</button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
