import type { FastifyInstance } from "fastify";
import sanitizeFilename from "sanitize-filename";

import {
  mergeJsonChanges,
  installedPluginSchema,
  pluginListResponseSchema,
  pluginManifestSchema,
  setPluginEnabledRequestSchema,
  type ApiErrorResponse,
} from "@mycompanion/shared";

import { PRESET_STORAGE_KEY } from "./preset-routes.js";
import type { RuntimeRepository } from "../persistence/runtime-repository.js";
import { sendError } from "../http-errors.js";
import type { IdParams } from "../route-types.js";

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
