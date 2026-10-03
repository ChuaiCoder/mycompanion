import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { backupPayloadSchemaShared, type BackupPayload, type BackupRestorePreviewResponse } from "@mycompanion/shared";
import { applyBackupRestore, fetchBackup, previewBackupRestore } from "../api";
import { flushSharedExtensionSettings, reloadApplication } from "../extension-settings";
import { flushWorldEditorDrafts } from "../world-editor-drafts";
import { flushComposerDrafts } from "../composer-drafts";
import { uiLocale } from "../i18n";
import { backupText, backupTotals } from "../backup-translations";

const labels: Record<keyof BackupRestorePreviewResponse["sections"], string> = {
  characters: "角色", conversations: "故事", memories: "记忆", plugins: "已有提示词插件", codePlugins: "代码扩展",
  extensionSettings: "扩展设置", userAvatars: "用户头像", worldbooks: "世界书", worldInfoSettings: "世界书设置", retainedCharacterChats: "已归档角色的故事",
  providerProfiles: "模型连接与任务",
};
function errorText(cause: unknown) { return cause instanceof Error ? cause.message : "操作失败，请重试。"; }

export function BackupPanel({ busy: applicationBusy = false }: { busy?: boolean }) {
  const { i18n } = useTranslation();
  const text = (value: string) => backupText(i18n.language, value);
  const [backup, setBackup] = useState<BackupPayload | null>(null);
  const [fileName, setFileName] = useState("");
  const [strategy, setStrategy] = useState<"skip" | "overwrite">("skip");
  const [preview, setPreview] = useState<BackupRestorePreviewResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const revision = useRef(0);
  async function flush() { await flushWorldEditorDrafts(); await flushComposerDrafts(); await flushSharedExtensionSettings(); }
  async function review(value: BackupPayload, nextStrategy: "skip" | "overwrite", token: number) {
    const result = await previewBackupRestore(value, nextStrategy);
    if (token === revision.current) setPreview(result);
  }
  const disabled = busy || applicationBusy;
  return <section className="settings-card backup-panel" aria-labelledby="backup-title">
    <header><h2 id="backup-title">{text("备份与恢复")}</h2><p>{text("保存角色、全部故事分支、记忆、世界书、扩展和设置。API Key 不包含在备份里，换电脑后需要重新填写。")}</p></header>
    {error ? <p role="alert">{text(error)}</p> : null}{notice ? <p role="status">{text(notice)}</p> : null}
    <button className="button button--quiet" type="button" disabled={disabled} onClick={() => void (async () => {
      setBusy(true); setError(""); setNotice("");
      try {
        await flush(); const payload = await fetchBackup();
        const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
        const link = document.createElement("a"); link.href = url; link.download = `mycompanion-backup-${payload.createdAt.slice(0, 10)}.json`; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000); setNotice("已开始下载完整备份。");
      } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
    })()}>{text("导出完整备份")}</button>
    <label>{text("选择备份文件")}<input type="file" accept=".json,application/json" aria-label={text("选择备份文件")} disabled={disabled} onChange={event => {
      const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
      const token = ++revision.current; setBusy(true); setBackup(null); setPreview(null); setError(""); setNotice(""); setFileName(file.name);
      void (async () => {
        try {
          if (file.size > 500 * 1024 * 1024) throw new Error("备份文件超过 500 MiB，请选择较小的备份。");
          let value: unknown; try { value = JSON.parse(await file.text()); } catch { throw new Error("无法读取这个 JSON 文件，请选择 MyCompanion 导出的备份。"); }
          const parsed = backupPayloadSchemaShared.safeParse(value);
          if (!parsed.success) throw new Error("备份格式或版本不受支持，请选择 MyCompanion 完整备份文件。");
          if (token !== revision.current) return;
          setBackup(parsed.data); await review(parsed.data, strategy, token);
        } catch (cause) { if (token === revision.current) setError(errorText(cause)); }
        finally { if (token === revision.current) setBusy(false); }
      })();
    }} /></label>
    {backup ? <>
      <p>{fileName} · {text("备份时间")} {new Date(backup.createdAt).toLocaleString(uiLocale())}</p>
      <label>{text("遇到已有内容时")}<select aria-label={text("恢复冲突处理")} disabled={disabled} value={strategy} onChange={event => {
        const next = event.target.value as "skip" | "overwrite"; const token = ++revision.current;
        setStrategy(next); setPreview(null); setBusy(true); setError("");
        void review(backup, next, token).catch(cause => { if (token === revision.current) setError(errorText(cause)); }).finally(() => { if (token === revision.current) setBusy(false); });
      }}><option value="skip">{text("保留现在的内容，跳过重复项")}</option><option value="overwrite">{text("用备份覆盖重复项")}</option></select></label>
      {preview ? <>
        {!preview.valid ? <div role="alert"><strong>{text("备份未通过检查，不能恢复。")}</strong><ul>{preview.errors.map((value, index) => <li key={index}>{text(value)}</li>)}</ul></div> : null}
        <table><caption>{text("恢复预览")}</caption><thead><tr>{["内容", "新增", "覆盖", "跳过", "冲突"].map(label => <th key={label} scope="col">{text(label)}</th>)}</tr></thead><tbody>{Object.entries(preview.sections).map(([key, value]) => value ? <tr key={key}><th scope="row">{text(labels[key as keyof typeof labels])}</th><td>{value.new.toLocaleString(uiLocale())}</td><td>{value.overwrite.toLocaleString(uiLocale())}</td><td>{value.skip.toLocaleString(uiLocale())}</td><td>{value.conflict.toLocaleString(uiLocale())}</td></tr> : null)}</tbody></table>
        <p>{backupTotals(i18n.language, preview.totals)}{strategy === "overwrite" && preview.totals.conflict ? text("冲突项也将以备份为准。") : ""}</p>
        <button className="button button--primary" type="button" disabled={disabled || !preview.valid} onClick={() => void (async () => {
          if (!preview.valid) return;
          setBusy(true); setError("");
          try {
            await flush(); await applyBackupRestore(backup, strategy);
            // Do not flush the old settings object over the restored profile.
            setNotice("恢复完成，正在重新加载数据…"); reloadApplication();
          } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
        })()}>{text("确认恢复")}</button>
      </> : <p>{text("正在检查备份…")}</p>}
      <button className="button button--quiet" type="button" disabled={disabled} onClick={() => { revision.current++; setBackup(null); setPreview(null); setFileName(""); setError(""); }}>{text("取消")}</button>
    </> : null}
  </section>;
}
