import { DatabaseSync } from "node:sqlite";
import { drainHttpConnectionsOnShutdown } from "./http-shutdown.js";

import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";

import { CharacterRepository } from "./character/character-repository.js";
import { RuntimeRepository } from "./persistence/runtime-repository.js";
import { registerWorldInfoRoutes } from "./world-info/world-info-routes.js";
import { registerCharacterWorldInfoEditor } from "./character/character-world-info-editor.js";
import { registerProviderProfileRoutes } from "./providers/provider-profile-routes.js";
import { registerPresetRoutes } from "./storage/preset-routes.js";
import { createGenerationPipeline } from "./chat/generation-pipeline.js";
import { registerHealthRoutes } from "./health-routes.js";
import { registerSettingsRoutes } from "./storage/settings-routes.js";
import { registerCharacterRoutes } from "./character/character-routes.js";
import { registerCharacterRegexRoutes } from "./character/character-regex-routes.js";
import { registerCharacterLorebookRoutes } from "./world-info/character-lorebook-routes.js";
import { registerConversationRoutes } from "./chat/conversation-routes.js";
import { registerPromptAssemblyRoutes } from "./prompt/prompt-assembly-routes.js";
import { registerGenerationRoutes } from "./chat/generation-routes.js";
import { registerBackupRoutes } from "./storage/backup-routes.js";
import { registerPluginRoutes } from "./storage/plugin-routes.js";
import type { SecretCodec } from "./route-types.js";

const packageVersion = "0.2.1";

// 角色导入（CHARX/ZIP/BYAF）的体积上限（沿用原共享解析器的 32 MiB）。
const characterArchiveBytes = 32 * 1024 * 1024;

export interface BuildAppOptions {
  databasePath?: string;
  logger?: boolean;
  rendererRoot?: string;
  secretCodec?: SecretCodec;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    bodyLimit: 21 * 1024 * 1024,
    logger: options.logger ?? false,
    requestIdHeader: "x-request-id",
  });
  drainHttpConnectionsOnShutdown(app);
  const database = new DatabaseSync(options.databasePath ?? ":memory:");
  // Fastify executes onClose hooks in reverse registration order. Register the
  // database first so pending generation/memory work and workers finish first.
  app.addHook("onClose", async () => { database.close(); });
  const characters = new CharacterRepository(database);
  const runtime = new RuntimeRepository(database);
  registerWorldInfoRoutes(app, runtime.worldInfo, characters, runtime);
  registerCharacterWorldInfoEditor(app, database, characters, runtime.worldInfo);
  registerPresetRoutes(app, runtime);
  registerSettingsRoutes(app, runtime, options.secretCodec);
  registerProviderProfileRoutes(app, runtime, options.secretCodec);
  // The pipeline owns cancellation, memory job draining and worker shutdown.
  const pipeline = createGenerationPipeline(app, {
    runtime,
    characters,
    secretCodec: options.secretCodec,
  });

  app.addContentTypeParser(
    "image/png",
    { parseAs: "buffer", bodyLimit: 20 * 1024 * 1024 },
    (_request, body, done) => done(null, body),
  );

  // Bound the archive parser before buffering the request.
  app.addContentTypeParser(
    ["application/zip", "application/x-zip-compressed", "application/charx", "application/byaf"],
    { parseAs: "buffer", bodyLimit: characterArchiveBytes },
    (_request, body, done) => done(null, body),
  );

  if (options.rendererRoot) {
    void app.register(fastifyStatic, {
      root: options.rendererRoot,
      index: ["index.html"],
    });
    // 桌面渲染器安全响应头：禁用 CSP（原生 UI 需要内联脚本），但保留
    // Chromium 源规则、Electron 沙箱、no-referrer 与 nosniff。
    app.addHook("onSend", async (_request, reply, payload) => {
      reply.headers({
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      });
      return payload;
    });
  }

  registerHealthRoutes(app, packageVersion);
  registerCharacterRoutes(app, characters, runtime);
  registerCharacterRegexRoutes(app, characters, pipeline);
  registerCharacterLorebookRoutes(app, characters);
  registerConversationRoutes(app, runtime, characters, pipeline);
  registerPromptAssemblyRoutes(app, runtime, characters, pipeline, options.secretCodec);
  registerGenerationRoutes(app, runtime, characters, pipeline);
  registerBackupRoutes(app, runtime, characters);
  registerPluginRoutes(app, runtime);

  return app;
}
export { bindBrowserPort } from "./browser-port.js";
