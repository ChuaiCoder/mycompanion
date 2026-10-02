import git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import type { CodePlugin, CodePluginUpdateCheck } from "@mycompanion/shared";
import { CodePluginRepositoryError, normalizeRepositoryUrl } from "./code-plugin-repository.js";

/** Read remote Git advertisements without cloning assets or touching installed data. */
export async function checkCodePluginUpdate(plugin: CodePlugin): Promise<CodePluginUpdateCheck> {
  if (!plugin.sourceUrl || !plugin.sourceRevision) {
    throw new CodePluginRepositoryError("这个扩展没有 Git 来源，请通过仓库地址安装后再检查更新。");
  }
  const sourceUrl = normalizeRepositoryUrl(plugin.sourceUrl).href;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const advertised = await git.listServerRefs({
      http: { request: request => http.request({ ...request, signal: controller.signal }) },
      url: sourceUrl, protocolVersion: 1, symrefs: true, peelTags: true,
      onAuth: () => { throw new CodePluginRepositoryError("当前只支持无需登录的公开 Git 仓库。"); },
    });
    const defaultRef = advertised.find(item => item.ref === "HEAD")?.target ?? null;
    const refs = advertised.flatMap<CodePluginUpdateCheck["refs"][number]>(item => {
      const kind = item.ref.startsWith("refs/heads/") ? "branch" : item.ref.startsWith("refs/tags/") ? "tag" : null;
      if (!kind || item.ref.endsWith("^{}")) return [];
      return [{ ref: item.ref, name: item.ref.slice(kind === "branch" ? 11 : 10), kind, revision: item.peeled ?? item.oid }];
    }).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    const sourceRef = plugin.sourceRef ?? "HEAD";
    const ref = refs.find(item => item.ref === sourceRef)
      ?? (sourceRef === "HEAD" ? refs.find(item => item.ref === defaultRef)
        : !sourceRef.startsWith("refs/") ? refs.find(item => item.ref === "refs/heads/" + sourceRef)
          ?? refs.find(item => item.ref === "refs/tags/" + sourceRef) : undefined);
    const remoteRevision = ref?.revision ?? null;
    return { sourceUrl, sourceRef, installedRevision: plugin.sourceRevision, remoteRevision, refs, defaultRef,
      state: !remoteRevision ? "ref_missing" : remoteRevision === plugin.sourceRevision ? "up_to_date" : "update_available",
      checkedAt: new Date().toISOString() };
  } catch (error) {
    if (error instanceof CodePluginRepositoryError) throw error;
    throw new CodePluginRepositoryError(controller.signal.aborted
      ? "检查扩展更新超时，请检查网络后重试。" : "无法检查扩展更新，请检查仓库地址和网络后重试。");
  } finally { clearTimeout(timeout); controller.abort(); }
}
