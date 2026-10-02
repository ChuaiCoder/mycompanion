import { DatabaseSync } from "node:sqlite";
import { drainHttpConnectionsOnShutdown } from "./http-shutdown.js";

import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";

import { CharacterRepository } from "./character-repository.js";
import { codePluginLimits } from "./code-plugin-repository.js";
import { RuntimeRepository } from "./runtime-repository.js";
import { registerPersonaAvatarRoutes } from "./persona-avatars.js";
import { registerWorldInfoRoutes } from "./world-info-routes.js";
import { registerRawGeneration } from "./raw-generation.js";
import { registerTokenizerRoutes } from "./tokenizer-service.js";
import { registerChatCompletionRoutes } from "./chat-completion-routes.js";
import { registerProviderPatchRoutes } from "./provider-patch-routes.js";
import { registerPresetRoutes } from "./preset-routes.js";
import { registerCharacterCompatibility } from "./character-compatibility.js";
import { createGenerationPipeline } from "./generation-pipeline.js";
import { registerHealthRoutes } from "./health-routes.js";
import { registerSettingsRoutes } from "./settings-routes.js";
import { registerCharacterRoutes } from "./character-routes.js";
import { registerCharacterRegexRoutes } from "./character-regex-routes.js";
import { registerCharacterLorebookRoutes } from "./character-lorebook-routes.js";
import { registerConversationRoutes } from "./conversation-routes.js";
import { registerPromptAssemblyRoutes } from "./prompt-assembly-routes.js";
import { registerGenerationRoutes } from "./generation-routes.js";
import { registerBackupRoutes } from "./backup-routes.js";
import { registerPluginRoutes } from "./plugin-routes.js";
import { registerPluginRuntimeAssets } from "./plugin-runtime-assets.js";
import type { SecretCodec } from "./route-types.js";

const packageVersion = "0.2.1";

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
  registerCharacterCompatibility(app, characters, runtime);
  registerPersonaAvatarRoutes(app, runtime.avatars);
  registerWorldInfoRoutes(app, runtime.worldInfo, characters, runtime);
  registerRawGeneration(app, runtime, options.secretCodec ? value => options.secretCodec!.unseal(value) : undefined);
  registerTokenizerRoutes(app, runtime);
  registerProviderPatchRoutes(app,runtime);
  registerPresetRoutes(app, runtime);
  registerChatCompletionRoutes(app, runtime, options.secretCodec ? value => options.secretCodec!.unseal(value) : undefined);
  registerSettingsRoutes(app, runtime, options.secretCodec);
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

  // Bound the legacy ZIP endpoint before buffering the request.
  app.addContentTypeParser(
    ["application/zip", "application/x-zip-compressed", "application/charx", "application/byaf"],
    { parseAs: "buffer", bodyLimit: codePluginLimits.archiveBytes },
    (_request, body, done) => done(null, body),
  );

  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/plugin-runtime/")) {
      reply.headers({
        "Access-Control-Allow-Origin": "*",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      });
      return payload;
    }
    if (options.rendererRoot) {
      // ST 1.19.0 disables CSP. Installed extensions require inline/Blob scripts,
      // eval, frames and external fetches in the document they operate on.
      // Keep Chromium's origin rules and the Electron process sandbox.
      reply.headers({
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      });
    }
    return payload;
  });

  if (options.rendererRoot) {
    void app.register(fastifyStatic, {
      root: options.rendererRoot,
      index: ["index.html"],
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
  // Must stay last: it registers the /plugin-runtime/* and /scripts/* 404 fallbacks.
  registerPluginRuntimeAssets(app);

  return app;
}
export { bindBrowserPort } from "./browser-port.js";
