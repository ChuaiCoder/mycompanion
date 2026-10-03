import type { FastifyInstance, FastifyReply } from "fastify";
import type { RuntimeRepository } from "./runtime-repository.js";
import { CodePluginRepositoryError } from "./code-plugin-repository.js";
import { CodePluginMutationError, checkInstalledCodePlugin, extensionInstallationName, installCodePluginUrl, resolveCodePlugin, updateInstalledCodePlugin } from "./code-plugin-service.js";

// Independent HTTP adapter for the fixed Tavern 1.19.0 extension contract.
// The single-user desktop profile is administrator-owned; both installation
// scopes share its existing Git/SQLite service and retain separate records.
type RequestBody = { extensionName?: string; url?: string; branch?: string; global?: boolean };
const scope = (body: RequestBody) => body.global ? "global" as const : "local" as const;
const folder = (name: string) => name.startsWith("third-party/") ? name.slice(12) : name;
function failure(reply: FastifyReply, error: unknown) {
  if (error instanceof CodePluginMutationError) return reply.code(error.statusCode).send({ error: error.message });
  if (error instanceof CodePluginRepositoryError) return reply.code(500).send({ error: error.message });
  throw error;
}
export function registerExtensionCompatibility(app: FastifyInstance, runtime: RuntimeRepository): void {
  const requestSchema = (required: "url" | "extensionName") => ({ body: { type: "object", required: [required], properties: {
    url: { type: "string", minLength: 1 }, extensionName: { type: "string", minLength: 1 }, branch: { type: "string" }, global: { type: "boolean" },
  } } });
  app.post<{ Body: RequestBody }>("/api/extensions/install", { schema: requestSchema("url") }, async (request, reply) => {
    try {
      const plugin = await installCodePluginUrl(runtime, request.body.url!, request.body.branch ?? "", { onlyNew: true, scope: scope(request.body) });
      const folderName = extensionInstallationName(plugin);
      return { version: plugin.version, author: plugin.author, display_name: plugin.displayName,
        extensionPath: `third-party/${folderName}`, folderName };
    } catch (error) { return failure(reply, error); }
  });
  app.post<{ Body: RequestBody }>("/api/extensions/version", { schema: requestSchema("extensionName") }, async (request, reply) => {
    const plugin = resolveCodePlugin(runtime, folder(request.body.extensionName!), scope(request.body), false);
    if (!plugin) return reply.code(404).send({ error: "Extension not found" });
    if (!plugin.sourceUrl || !plugin.sourceRevision) return { currentBranchName: "", currentCommitHash: "", isUpToDate: true, remoteUrl: "" };
    try {
      const result = await checkInstalledCodePlugin(runtime, plugin);
      return { currentBranchName: plugin.sourceRef?.startsWith("refs/tags/") ? "" : (plugin.sourceRef ?? "HEAD").replace(/^refs\/heads\//, ""), currentCommitHash: plugin.sourceRevision,
        isUpToDate: result.state === "up_to_date", remoteUrl: plugin.sourceUrl };
    } catch (error) { return failure(reply, error); }
  });
  app.post<{ Body: RequestBody }>("/api/extensions/update", { schema: requestSchema("extensionName") }, async (request, reply) => {
    const plugin = resolveCodePlugin(runtime, folder(request.body.extensionName!), scope(request.body), false);
    if (!plugin) return reply.code(404).send({ error: "Extension not found" });
    try {
      // Tavern reports whether the installed revision was current *before* pull.
      const checked = await checkInstalledCodePlugin(runtime, plugin);
      const updated = await updateInstalledCodePlugin(runtime, plugin);
      return { shortCommitHash: updated.sourceRevision!.slice(0, 7), extensionPath: `third-party/${extensionInstallationName(updated)}`,
        isUpToDate: checked.state === "up_to_date", remoteUrl: updated.sourceUrl };
    } catch (error) { return failure(reply, error); }
  });
  app.post<{ Body: RequestBody }>("/api/extensions/delete", { schema: requestSchema("extensionName") }, async (request, reply) => {
    const plugin = resolveCodePlugin(runtime, folder(request.body.extensionName!), scope(request.body), false);
    if (!plugin || !runtime.deleteCodePlugin(plugin.id)) return reply.code(404).send({ error: "Extension not found" });
    return reply.type("text/plain").send("Extension deleted");
  });
}
