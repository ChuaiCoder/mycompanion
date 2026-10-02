import { posix } from "node:path";

import type { FastifyInstance } from "fastify";
import sanitizeFilename from "sanitize-filename";

import {
  mergeJsonChanges,
  codePluginContributionSchema,
  codePluginListResponseSchema,
  codePluginSchema,
  codePluginUpdateCheckSchema,
  installedPluginSchema,
  installCodePluginRequestSchema,
  updateCodePluginRequestSchema,
  pluginListResponseSchema,
  pluginManifestSchema,
  setPluginEnabledRequestSchema,
  type ApiErrorResponse,
} from "@mycompanion/shared";

import {
  CodePluginPackageError,
  CodePluginRepositoryError,
  contentTypeForPluginFile,
  installCodePluginFromUrl,
  parseCodePluginPackage,
} from "./code-plugin-repository.js";
import { checkCodePluginUpdate } from "./code-plugin-git-state.js";
import { PRESET_STORAGE_KEY } from "./preset-routes.js";
import type { RuntimeRepository } from "./runtime-repository.js";
import { sendError } from "./http-errors.js";
import type { IdParams, PluginAssetParams } from "./route-types.js";

export function registerPluginRoutes(app: FastifyInstance, runtime: RuntimeRepository): void {
  app.get("/api/plugins", async () => {
    return pluginListResponseSchema.parse(runtime.listPlugins());
  });

  app.post<{ Body: unknown }>("/api/plugins/install", async (request, reply) => {
    const parsed = pluginManifestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send({
        error: {
          code: "INVALID_PLUGIN_MANIFEST",
          message: "插件清单无效；当前仅支持 MyCompanion 声明式插件格式。",
          details: parsed.error.issues.map((issue) => issue.message),
        },
      } satisfies ApiErrorResponse);
    }
    if (
      parsed.data.contributes.systemPrompt &&
      !parsed.data.permissions.includes("prompt:system")
    ) {
      return sendError(reply, 422, "MISSING_PERMISSION", "插件注入系统提示词时必须声明 prompt:system 权限。");
    }
    if (
      parsed.data.contributes.commands.length > 0 &&
      !parsed.data.permissions.includes("command:register")
    ) {
      return sendError(reply, 422, "MISSING_PERMISSION", "插件注册命令时必须声明 command:register 权限。");
    }
    return reply.status(201).send(installedPluginSchema.parse(runtime.installPlugin(parsed.data)));
  });

  app.put<{ Params: IdParams; Body: unknown }>(
    "/api/plugins/:id/enabled",
    async (request, reply) => {
      const parsed = setPluginEnabledRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, "INVALID_REQUEST", "插件状态无效。");
      }
      const plugin = runtime.setPluginEnabled(request.params.id, parsed.data.enabled);
      if (!plugin) {
        return sendError(reply, 404, "PLUGIN_NOT_FOUND", "插件不存在。");
      }
      return installedPluginSchema.parse(plugin);
    },
  );

  app.delete<{ Params: IdParams }>("/api/plugins/:id", async (request, reply) => {
    if (!runtime.deletePlugin(request.params.id)) {
      return sendError(reply, 404, "PLUGIN_NOT_FOUND", "插件不存在。");
    }
    return reply.status(204).send();
  });

  app.get("/api/code-plugins", async () => {
    return codePluginListResponseSchema.parse(runtime.listCodePlugins());
  });

  app.post<{ Body: unknown }>("/api/code-plugins/install", async (request, reply) => {
    if (!Buffer.isBuffer(request.body)) {
      return sendError(reply, 415, "ZIP_REQUIRED", "请选择包含 manifest.json 的 ZIP 扩展包。");
    }
    const filenameHeader = request.headers["x-plugin-filename"];
    let filename = "sillytavern-extension.zip";
    if (typeof filenameHeader === "string") {
      try {
        filename = decodeURIComponent(filenameHeader).slice(0, 300);
      } catch {
        return sendError(reply, 400, "INVALID_FILENAME", "扩展文件名无效。");
      }
    }
    try {
      const parsed = await parseCodePluginPackage(request.body, filename);
      return reply.status(201).send(codePluginSchema.parse(runtime.installCodePlugin(parsed)));
    } catch (error) {
      if (error instanceof CodePluginPackageError) {
        return sendError(reply, 422, "INVALID_CODE_PLUGIN", error.message);
      }
      throw error;
    }
  });

  app.post<{ Body: unknown }>("/api/code-plugins/install-url", async (request, reply) => {
    const parsed = installCodePluginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "INVALID_INSTALL_URL", "扩展仓库地址无效。");
    }
    try {
      const repository = await installCodePluginFromUrl(parsed.data.url, parsed.data.branch);
      const existing = runtime.getCodePlugin(repository.plugin.id);
      if (existing && existing.sourceUrl !== repository.plugin.sourceUrl) {
        return sendError(reply, 409, "EXTENSION_SOURCE_CONFLICT", "同名扩展已来自另一个仓库；请先确认已安装扩展的来源。");
      }
      return reply.status(201).send(codePluginSchema.parse(runtime.installCodePlugin(repository)));
    } catch (error) {
      if (error instanceof CodePluginRepositoryError) {
        return sendError(reply, 422, "INVALID_CODE_PLUGIN", error.message);
      }
      throw error;
    }
  });

  const sameSource = (a: ReturnType<RuntimeRepository["getCodePlugin"]>, b: ReturnType<RuntimeRepository["getCodePlugin"]>): boolean =>
    Boolean(a && b && a.sourceUrl === b.sourceUrl && a.sourceRef === b.sourceRef
      && a.sourceRevision === b.sourceRevision && a.installedAt === b.installedAt);

  app.post<{ Params: IdParams }>("/api/code-plugins/:id/check-update", async (request, reply) => {
    const plugin = runtime.getCodePlugin(request.params.id);
    if (!plugin) return sendError(reply, 404, "PLUGIN_NOT_FOUND", "代码扩展不存在。");
    try {
      const result = await checkCodePluginUpdate(plugin);
      if (!sameSource(plugin, runtime.getCodePlugin(plugin.id))) {
        return sendError(reply, 409, "EXTENSION_CHANGED", "扩展在检查期间发生变化，请重新检查。");
      }
      return reply.header("Cache-Control", "no-store").send(codePluginUpdateCheckSchema.parse(result));
    } catch (error) {
      if (error instanceof CodePluginRepositoryError) return sendError(reply, 422, "UPDATE_CHECK_FAILED", error.message);
      throw error;
    }
  });

  app.post<{ Params: IdParams; Body: unknown }>("/api/code-plugins/:id/update", async (request, reply) => {
    const parsed = updateCodePluginRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_UPDATE_REQUEST", "扩展版本或分支无效，请重新检查后再更新。");
    const plugin = runtime.getCodePlugin(request.params.id);
    if (!plugin) return sendError(reply, 404, "PLUGIN_NOT_FOUND", "代码扩展不存在。");
    if (!plugin.sourceUrl || !plugin.sourceRevision) return sendError(reply, 400, "GIT_SOURCE_REQUIRED", "这个扩展没有 Git 来源，请通过仓库地址安装。");
    if (plugin.sourceRevision !== parsed.data.expectedRevision) return sendError(reply, 409, "EXTENSION_CHANGED", "扩展版本已改变，请重新检查后再更新。");
    try {
      // Clone and validate away from installed assets; a failed download leaves the old version intact.
      const repository = await installCodePluginFromUrl(plugin.sourceUrl, parsed.data.branch ?? plugin.sourceRef ?? "");
      if (!sameSource(plugin, runtime.getCodePlugin(plugin.id))) return sendError(reply, 409, "EXTENSION_CHANGED", "扩展在下载期间发生变化，请重新检查后再更新。");
      if (repository.plugin.id !== plugin.id || repository.plugin.sourceUrl !== plugin.sourceUrl) {
        return sendError(reply, 409, "EXTENSION_SOURCE_CONFLICT", "下载的扩展来源与已安装版本不同。");
      }
      return codePluginSchema.parse(runtime.installCodePlugin(repository));
    } catch (error) {
      if (error instanceof CodePluginRepositoryError) return sendError(reply, 422, "EXTENSION_UPDATE_FAILED", error.message);
      throw error;
    }
  });

  app.put<{ Params: IdParams; Body: unknown }>(
    "/api/code-plugins/:id/enabled",
    async (request, reply) => {
      const parsed = setPluginEnabledRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, "INVALID_REQUEST", "扩展状态无效。");
      }
      const plugin = runtime.setCodePluginEnabled(request.params.id, parsed.data.enabled);
      if (!plugin) {
        return sendError(reply, 404, "PLUGIN_NOT_FOUND", "代码扩展不存在。");
      }
      return codePluginSchema.parse(plugin);
    },
  );

  app.put<{ Params: IdParams; Body: unknown }>(
    "/api/code-plugins/:id/contributions",
    async (request, reply) => {
      const parsed = codePluginContributionSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, "INVALID_CONTRIBUTION", "扩展贡献内容无效。");
      }
      if (!runtime.saveCodePluginContributions(request.params.id, parsed.data)) {
        return sendError(reply, 404, "PLUGIN_NOT_ACTIVE", "扩展不存在或尚未启用。");
      }
      return parsed.data;
    },
  );

  app.delete<{ Params: IdParams }>("/api/code-plugins/:id", async (request, reply) => {
    if (!runtime.deleteCodePlugin(request.params.id)) {
      return sendError(reply, 404, "PLUGIN_NOT_FOUND", "代码扩展不存在。");
    }
    return reply.status(204).send();
  });

  app.get("/api/code-plugins/runtime", async (_request, reply) => {
    const items = runtime.listCodePlugins().items.map(plugin => {
      const manifest = runtime.getCodePluginManifest(plugin.id) ?? {};
      return { id: plugin.id, displayName: plugin.displayName, enabled: plugin.enabled, js: plugin.js, css: plugin.css,
        order: Number.isFinite(Number(manifest.loading_order)) ? Number(manifest.loading_order) : 0,
        hooks: typeof manifest.hooks === "object" && manifest.hooks !== null && !Array.isArray(manifest.hooks) ? manifest.hooks : {},
      };
    }).sort((a, b) => a.order - b.order || a.displayName.localeCompare(b.displayName));
    return reply.header("Cache-Control", "no-store").send({ items });
  });

  // Preserve extension source bytes; serve original SillyTavern absolute paths
  // as aliases instead of rewriting arbitrary strings inside third-party code.
  for (const assetRoute of ["/plugin-runtime/scripts/extensions/third-party/:id/*", "/scripts/extensions/third-party/:id/*"]) {
    app.get<{ Params: PluginAssetParams }>(
      assetRoute,
      async (request, reply) => {
        const plugin = runtime.getCodePlugin(request.params.id);
        if (!plugin) {
          return reply.status(404).type("text/plain").send("Extension is not installed.");
        }
        const rawPath = request.params["*"];
        const path = posix.normalize(rawPath);
        if (
          !rawPath ||
          rawPath.includes("\\") ||
          path === ".." ||
          path.startsWith("../") ||
          path.startsWith("/")
        ) {
          return reply.status(400).type("text/plain").send("Invalid extension path.");
        }
        const content = runtime.getCodePluginFile(plugin.id, path);
        if (!content) {
          return reply.status(404).type("text/plain; charset=utf-8")
            .send(`扩展文件不存在：${path}`);
        }
        return reply
          .type(contentTypeForPluginFile(path))
          .header("Cache-Control", "no-store")
          .send(content);
      },
    );
  }

  app.get("/api/extensions/settings", async (_request, reply) => reply.header("Cache-Control", "no-store")
    .send({ extensionSettings: runtime.getExtensionSettings() }));
  app.put<{ Body: { extensionSettings: Record<string, unknown>; patches?: Array<{base:Record<string,unknown>;next:Record<string,unknown>}> } }>("/api/extensions/settings", {
    bodyLimit: 500 * 1024 * 1024,
    schema: { body: { type: "object", required: ["extensionSettings"], properties: { extensionSettings: { type: "object", additionalProperties: true },
      patches:{type:"array",items:{type:"object",required:["base","next"],properties:{base:{type:"object",additionalProperties:true},next:{type:"object",additionalProperties:true}}}},
    } } },
  }, async request => {
    const current = runtime.getExtensionSettings();
    const settings = request.body.patches
      // A no-op merge may return its input object. Keep the preserved snapshot
      // separate before removing the browser-owned copy of the preset domain.
      ? { ...request.body.patches.reduce((state,patch)=>mergeJsonChanges(patch.base,patch.next,state) as Record<string,unknown>,current) }
      : { ...request.body.extensionSettings };
    delete settings[PRESET_STORAGE_KEY];
    if (Object.hasOwn(current, PRESET_STORAGE_KEY)) settings[PRESET_STORAGE_KEY] = current[PRESET_STORAGE_KEY];
    runtime.saveExtensionSettings(settings);
    return { saved: true };
  });

  app.post<{ Body: { fileName: string } }>("/api/files/sanitize-filename", {
    schema: { body: { type: "object", required: ["fileName"], properties: { fileName: { type: "string" } } } },
  }, async request => ({ fileName: sanitizeFilename(request.body.fileName) }));
}
