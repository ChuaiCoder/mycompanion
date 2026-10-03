import type { CodePlugin, CodePluginUpdateCheck, InstalledPlugin } from "@mycompanion/shared";
import { useTranslation } from "react-i18next";

import { Notice } from "../components";
import { resolvePluginRef } from "../plugin-version-utils";
import { pluginDate, pluginDiagnostic, pluginFileCount, pluginRefLabel, pluginText } from "../plugin-translations";

export interface PluginsViewProps {
  plugins: InstalledPlugin[];
  codePlugins: CodePlugin[];
  isInstallingFromUrl: boolean;
  pluginUrl: string;
  pluginRef: string;
  isChangingPlugins: boolean;
  codePluginChecks: Record<string, CodePluginUpdateCheck>;
  codePluginRefs: Record<string, string>;
  codePluginErrors: Record<string, string>;
  codePluginPendingReload: Record<string, boolean>;
  codePluginOperations: Record<string, "checking" | "updating" | "changing">;
  codePluginStatus: Record<string, string>;
  runtimeError: string | null;
  onPluginUrl: (value: string) => void;
  onPluginRef: (value: string) => void;
  onInstallFromUrl: () => void;
  onPluginToggle: (plugin: InstalledPlugin) => void;
  onPluginUninstall: (id: string) => void;
  onCodePluginToggle: (plugin: CodePlugin) => void;
  onCodePluginUninstall: (id: string) => void;
  onCodePluginCheckUpdate: (plugin: CodePlugin) => void;
  onCodePluginRef: (id: string, ref: string) => void;
  onCodePluginUpdate: (plugin: CodePlugin) => void;
  onCodePluginReload: (id: string) => void;
  onOpenPlugin: (id: string) => void;
}

export function PluginsView(props: PluginsViewProps) {
  const { i18n } = useTranslation();
  const text = (value: string) => pluginText(i18n.language, value);
  const diagnostic = (value: string) => pluginDiagnostic(i18n.language, value);
  const { codePlugins, plugins, isInstallingFromUrl, pluginUrl } = props;
  return (
    <main className="settings-workspace">
      <section className="settings-card plugin-center" aria-labelledby="plugins-title">
        <header>
          <p className="eyebrow">{text("扩展中心")}</p>
          <h1 id="plugins-title">{text("插件")}</h1>
          <p>{text("粘贴扩展的 Git 仓库地址进行安装；再次输入同一地址可更新。启用后按 SillyTavern 前端扩展权限运行，可访问宿主页面 DOM、事件、同源 API 和外部网络。")}</p>
        </header>
        {props.runtimeError || props.codePluginStatus.host ? <Notice tone="error">{diagnostic(props.runtimeError ?? props.codePluginStatus.host!)}</Notice> : null}
        <form className="plugin-install-actions" onSubmit={(event) => {
          event.preventDefault();
          if (!isInstallingFromUrl && pluginUrl.trim()) props.onInstallFromUrl();
        }}>
          <div className="plugin-url-input"><label>
            <span className="visually-hidden-input">{text("扩展仓库地址")}</span>
            <input aria-label={text("扩展仓库地址")} disabled={props.isChangingPlugins}
              onChange={(event) => props.onPluginUrl(event.target.value)}
              placeholder="https://github.com/user/repo" required type="url" value={pluginUrl} />
          </label><details className="plugin-install-ref"><summary>{text("分支或标签（可选）")}</summary><label>{text("分支 / 标签")}<input aria-label={text("安装分支或标签")} disabled={props.isChangingPlugins} onChange={event => props.onPluginRef(event.target.value)} placeholder={text("留空使用仓库默认分支")} value={props.pluginRef} /></label></details></div>
          <button className="button button--primary" disabled={props.isChangingPlugins || !pluginUrl.trim()} type="submit">
            {text(isInstallingFromUrl ? "正在处理…" : "安装 / 更新")}
          </button>
        </form>
        {!codePlugins.length && !plugins.length ? <p className="panel-empty">{text("还没有安装扩展。")}</p> : null}
        <ul className="plugin-list code-plugin-list">
          {codePlugins.map((plugin) => {
            const checked = props.codePluginChecks[plugin.id], selectedRef = props.codePluginRefs[plugin.id] ?? checked?.sourceRef ?? plugin.sourceRef ?? "";
            const selected = checked ? resolvePluginRef(checked, selectedRef) : undefined;
            const busy = Boolean(props.codePluginOperations[plugin.id]) || props.isChangingPlugins;
            const hasUpdate = Boolean(selected && (selectedRef !== checked?.sourceRef || selected.revision !== checked?.installedRevision));
            return <li key={plugin.id} data-code-plugin-id={plugin.id}>
              <div>
                <strong>{plugin.displayName}</strong>
                <span>v{plugin.version} · {plugin.author} · {plugin.license}</span>
                <small>{diagnostic(props.codePluginStatus[plugin.id] ?? (plugin.enabled ? "已启用" : "已停用"))}</small>
                <small>{pluginFileCount(i18n.language, plugin.fileCount)} · {text("安装时间")} <time dateTime={plugin.installedAt}>{pluginDate(i18n.language, plugin.installedAt)}</time></small>
                {plugin.sourceUrl ? <small className="plugin-source-version"><span>{plugin.sourceRef ?? text("默认分支")}</span>{plugin.sourceRevision ? <> · <code title={plugin.sourceRevision}>{plugin.sourceRevision.slice(0, 10)}</code></> : null}</small> : null}
                {checked ? <><p role="status" className="plugin-update-status">{text(selected ? hasUpdate ? "有可用更新或已选择其他版本" : "已是最新版本" : "当前分支或标签已不存在，请选择其他版本")}</p><small>{text("检查时间")} <time dateTime={checked.checkedAt}>{pluginDate(i18n.language, checked.checkedAt)}</time></small></> : null}
                {props.codePluginErrors[plugin.id] ? <p role="alert">{diagnostic(props.codePluginErrors[plugin.id]!)}</p> : null}
                {checked ? <details className="plugin-ref-picker"><summary>{text("分支与标签")}</summary><label>{text("选择版本")}<select aria-label={pluginRefLabel(i18n.language, plugin.displayName)} disabled={busy} value={selectedRef} onChange={event => props.onCodePluginRef(plugin.id, event.target.value)}>
                  {!selected ? <option value={selectedRef} disabled>{selectedRef || text("当前版本")}{text("（已不存在）")}</option> : null}
                  {selected && selected.ref !== selectedRef ? <option value={selectedRef}>{text(selectedRef === "HEAD" ? "默认分支" : "当前分支 / 标签")} · {selected.name} · {selected.revision.slice(0, 10)}</option> : null}
                  {checked.refs.map(ref => <option key={ref.ref} value={ref.ref}>{text(ref.kind === "tag" ? "标签" : "分支")} · {ref.name} · {ref.revision.slice(0, 10)}</option>)}
                </select></label></details> : null}
                {plugin.warnings.length ? <details><summary>{text("兼容性说明")}</summary><ul>
                  {plugin.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
                </ul></details> : null}
              </div>
              <div className="plugin-actions">
                {props.codePluginPendingReload[plugin.id] ? <button className="button button--primary" disabled={busy} onClick={() => props.onCodePluginReload(plugin.id)} type="button">{text("应用已安装版本")}</button> : null}
                {plugin.sourceUrl && plugin.sourceRevision ? <button className="button button--quiet" disabled={busy} onClick={() => props.onCodePluginCheckUpdate(plugin)} type="button">{text(props.codePluginOperations[plugin.id] === "checking" ? "正在检查…" : "检查更新")}</button> : null}
                {checked ? <button className="button button--primary" disabled={busy || !hasUpdate} onClick={() => props.onCodePluginUpdate(plugin)} type="button">{text(props.codePluginOperations[plugin.id] === "updating" ? "正在更新…" : selectedRef !== checked.sourceRef ? "切换版本" : "更新")}</button> : null}
                {plugin.enabled ? <button className="button button--quiet" onClick={() => props.onOpenPlugin(plugin.id)} type="button">{text("设置")}</button> : null}
                <button className={`button ${plugin.enabled ? "button--quiet" : "button--primary"}`} disabled={busy} onClick={() => props.onCodePluginToggle(plugin)} type="button">{text(plugin.enabled ? "停用" : "启用")}</button>
                <button className="button button--quiet" disabled={busy} onClick={() => props.onCodePluginUninstall(plugin.id)} type="button">{text("卸载")}</button>
              </div>
            </li>;
          })}
          {/* Keep previously installed declarative plugins manageable. */}
          {plugins.map((plugin) => (
            <li key={`legacy-${plugin.id}`}>
              <div><strong>{plugin.name}</strong><span>v{plugin.version} · {plugin.author || text("未知作者")} · {plugin.license}</span></div>
              <div className="plugin-actions">
                <button className="button button--quiet" onClick={() => props.onPluginToggle(plugin)} type="button">{text(plugin.enabled ? "停用" : "启用")}</button>
                <button className="button button--quiet" onClick={() => props.onPluginUninstall(plugin.id)} type="button">{text("卸载")}</button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
