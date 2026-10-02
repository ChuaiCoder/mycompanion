import type { FastifyInstance } from "fastify";
import { createCharacterMacroFieldsLazy, readCharacterMacroFields } from "@mycompanion/shared";

import {
  compatibilityRuntimeSource,
  extensionsShimSource,
  i18nShimSource,
  libShimSource,
  popupShimSource,
  scriptShimSource,
  utilityShimSource,
} from "./plugin-runtime-host.js";
import { browserLibrarySource, getPluginBrowserAssets } from "./plugin-browser-libraries.js";
import { quietGenerationSource } from "./plugin-runtime-quiet-generation.js";
import { generateRuntimeSource } from "./plugin-runtime-generate.js";
import { slashRuntimeSource } from "./plugin-runtime-slash.js";
import { slashUpstreamAssets } from "./plugin-runtime-slash-upstream-assets.js";
import { slashAdapterSource } from "./plugin-runtime-slash-adapter.js";
import { eventSourceStreamSource } from "./plugin-runtime-stream.js";
import { extensionSettingsSource } from "./plugin-runtime-settings.js";
import { desktopHostSource } from "./plugin-desktop-host.js";
import { chatMergeSource, chatPersistenceSource } from "./plugin-runtime-chat.js";
import { messageRenderingSource } from "./plugin-runtime-rendering.js";
import { generationControlsSource } from "./plugin-runtime-generation-controls.js";
import { rawGenerationSource } from "./plugin-runtime-raw-generation.js";
import { tokenizersSource } from "./plugin-runtime-tokenizers.js";
import { promptCollectionsSource } from "./plugin-runtime-prompt-collections.js";
import { completionCollectionsSource } from "./plugin-runtime-completion-collections.js";
import { openAITransportSource } from "./plugin-runtime-openai-transport.js";
import { openAISettingsSource } from "./plugin-runtime-openai-settings.js";
import { presetManagerSource } from "./plugin-runtime-presets.js";
import { regexCoreSource, regexRuntimeSource } from "./plugin-runtime-regex.js";
import { macrosRuntimeSource } from "./plugin-runtime-macros.js";
import { tavernRandomBrowserSource } from "./tavern-random-core.js";
import { tavernTimeBrowserSource } from "./tavern-time-core.js";
import { variablesRuntimeSource } from "./plugin-runtime-variables.js";
import { characterFieldsSource } from "./plugin-runtime-character-fields.js";
import { reasoningRuntimeSource } from "./plugin-runtime-reasoning.js";
import { localeRuntimeSource, templateRuntimeSource } from "./plugin-runtime-templates.js";
import { popupRuntimeSource } from "./plugin-runtime-popup.js";
import { worldInfoRuntimeSource, worldInfoDataSource, worldInfoShimSource } from "./plugin-runtime-world-info.js";
import { authorNoteCoreSource, authorNoteRuntimeSource } from "./plugin-runtime-authors-note.js";
import { powerUserRuntimeSource } from "./plugin-runtime-power-user.js";
import { personasRuntimeSource } from "./plugin-runtime-personas.js";
import { scriptDataSource } from "./plugin-runtime-script-data.js";
import { openAIConversionSource } from "./plugin-runtime-openai-conversion.js";
import { openAIPromptSource } from "./plugin-runtime-openai-prompt.js";
import { messageCleanupSource } from "./plugin-runtime-message-cleanup.js";
import { providerStatusSource } from "./plugin-runtime-provider-status.js";
import { rossAscendsRuntimeSource, groupChatsRuntimeSource } from "./plugin-runtime-navigation.js";
import { macroRegistrySource } from "./plugin-runtime-macro-registry.js";
import { macroSystemSource } from "./plugin-runtime-macro-system.js";
import { macroVariableSyncSource } from "./plugin-runtime-macro-variable-sync.js";
import { macroApiSource } from "./plugin-runtime-macro-api.js";
import { characterRuntimeSource } from "./plugin-runtime-characters.js";
import { characterEditorSource } from "./plugin-runtime-character-editor.js";
import { macroDraftSource, macroBoundaryBrowserSource } from "./plugin-runtime-macro-draft.js";
import { Prompt, PromptCollection, PromptManager, chatCompletionDefaultPrompts, promptManagerDefaultPromptOrder,
  promptManagerRecord, readPromptManagerSettings, prepareCompletionPrompts, parseCompletionExample, chatCompletionPromptDefaults } from "./prompt-manager-core.js";

// Serves the built-in plugin runtime modules and browser library assets.
// Must be registered last: the /plugin-runtime/* and /scripts/* fallbacks are
// wildcard 404 handlers for every module path not listed above them.
export function registerPluginRuntimeAssets(app: FastifyInstance): void {
  for (const [path, asset] of getPluginBrowserAssets()) {
    app.get(path, async (_request, reply) => reply.type(asset.contentType).send(asset.content));
  }

  const runtimeModules: Record<string, string> = {
    "/plugin-runtime/macro-draft.js": macroDraftSource,
    "/plugin-runtime/macro-boundary.js": macroBoundaryBrowserSource,
    "/plugin-runtime/prompt-manager-core.js": `export const INJECTION_POSITION={RELATIVE:0,ABSOLUTE:1};\nexport ${Prompt.toString()}\nexport ${PromptCollection.toString()}\nexport ${PromptManager.toString()}\n` +
      `export const chatCompletionDefaultPrompts=${JSON.stringify(chatCompletionDefaultPrompts)};\nexport const promptManagerDefaultPromptOrder=${JSON.stringify(promptManagerDefaultPromptOrder)};\nexport const chatCompletionPromptDefaults=${JSON.stringify(chatCompletionPromptDefaults)};\n` +
      `const promptManagerRecord=${promptManagerRecord.toString()};\nexport ${readPromptManagerSettings.toString()}\nexport ${prepareCompletionPrompts.toString()}\nexport ${parseCompletionExample.toString()}`,
    "/plugin-runtime/character-macro-fields.js": `export ${createCharacterMacroFieldsLazy.toString()}\nexport ${readCharacterMacroFields.toString()}`,
    "/plugin-runtime/macro-api.js": macroApiSource,
    "/plugin-runtime/macro-variable-sync.js": macroVariableSyncSource,
    "/plugin-runtime/character-editor.js": characterEditorSource,
    "/plugin-runtime/author-note-core.js": authorNoteCoreSource,
    "/plugin-runtime/scripts/authors-note.js": authorNoteRuntimeSource,
    "/plugin-runtime/scripts/power-user.js": powerUserRuntimeSource,
    "/plugin-runtime/scripts/personas.js": personasRuntimeSource,
    "/plugin-runtime/script-data.js": scriptDataSource,
    "/plugin-runtime/openai-conversion.js": openAIConversionSource,
    "/plugin-runtime/openai-prompt.js": openAIPromptSource,
    "/plugin-runtime/message-cleanup.js": messageCleanupSource,
    "/plugin-runtime/provider-status.js": providerStatusSource,
    "/plugin-runtime/scripts/RossAscends-mods.js": rossAscendsRuntimeSource,
    "/plugin-runtime/scripts/group-chats.js": groupChatsRuntimeSource,
    "/plugin-runtime/scripts/macros/engine/MacroRegistry.js": macroRegistrySource,
    "/plugin-runtime/scripts/macros/macro-system.js": macroSystemSource,
    "/plugin-runtime/scripts/macros/engine/MacroEnvBuilder.js": "export { MacroEnvBuilder } from '/plugin-runtime/macros.js'; export { env_provider_order } from '/plugin-runtime/vendor/macro-engine.js';",
    "/plugin-runtime/scripts/macros/engine/MacroEngine.js": "export { MacroEngine } from '/plugin-runtime/vendor/macro-engine.js';",
    "/plugin-runtime/scripts/macros/engine/MacroParser.js": "export { MacroParser } from '/plugin-runtime/vendor/macro-engine.js';",
    "/plugin-runtime/scripts/macros/engine/MacroLexer.js": "export { MacroLexer } from '/plugin-runtime/vendor/macro-engine.js';",
    "/plugin-runtime/scripts/macros/engine/MacroCstWalker.js": "export { MacroCstWalker } from '/plugin-runtime/vendor/macro-engine.js';",
    "/plugin-runtime/scripts/macros/engine/MacroFlags.js": "export { MacroFlagType, parseFlags, createEmptyFlags } from '/plugin-runtime/vendor/macro-engine.js';",
    // The desktop profile has one local owner and no multi-user role database.
    "/plugin-runtime/scripts/user.js": "export function isAdmin() { return true; }",
    "/plugin-runtime/characters.js": characterRuntimeSource,
    "/plugin-runtime/world-info-data.js": worldInfoDataSource,
    "/plugin-runtime/world-info.js": worldInfoRuntimeSource,
    "/plugin-runtime/scripts/world-info.js": worldInfoShimSource,
    "/plugin-runtime/libraries.js": browserLibrarySource,
    "/plugin-runtime/i18n.js": localeRuntimeSource,
    "/plugin-runtime/templates.js": templateRuntimeSource,
    "/plugin-runtime/popup.js": popupRuntimeSource,
    "/plugin-runtime/scripts/templates.js": "export { renderTemplate, renderTemplateAsync } from '/plugin-runtime/templates.js';",
    "/plugin-runtime/message-rendering.js": messageRenderingSource,
    "/plugin-runtime/regex-core.js": regexCoreSource,
    "/plugin-runtime/regex.js": regexRuntimeSource,
    "/plugin-runtime/macros.js": macrosRuntimeSource,
    "/plugin-runtime/random-macros.js": tavernRandomBrowserSource,
    "/plugin-runtime/time-macros.js": tavernTimeBrowserSource,
    "/plugin-runtime/variables.js": variablesRuntimeSource,
    "/plugin-runtime/scripts/macros.js": "export { MacrosParser, evaluateMacros, getLastMessageId } from '/plugin-runtime/macros.js';",
    "/plugin-runtime/scripts/variables.js": "export { getLocalVariable, getGlobalVariable, setLocalVariable, setGlobalVariable, addLocalVariable, addGlobalVariable, incrementLocalVariable, incrementGlobalVariable, decrementLocalVariable, decrementGlobalVariable, existsLocalVariable, existsGlobalVariable, deleteLocalVariable, deleteGlobalVariable, resolveVariable, getVariableMacros } from '/plugin-runtime/variables.js';",
    "/plugin-runtime/character-fields.js": characterFieldsSource,
    "/plugin-runtime/scripts/extensions/regex/engine.js": "export { getRegexedString, regex_placement, substitute_find_regex, RegexProvider, runRegexScript, SCRIPT_TYPES, SCRIPT_TYPE_UNKNOWN, getRegexScripts, getScriptsByType, saveScriptsByType, isScopedScriptsAllowed, allowScopedScripts, disallowScopedScripts, isPresetScriptsAllowed, allowPresetScripts, disallowPresetScripts, getCurrentPresetAPI, getCurrentPresetName } from '/plugin-runtime/regex.js';",
    "/plugin-runtime/generation-controls.js": generationControlsSource,
    "/plugin-runtime/raw-generation.js": rawGenerationSource,
    "/plugin-runtime/quiet-generation.js": quietGenerationSource,
    "/plugin-runtime/generate.js": generateRuntimeSource,
    "/plugin-runtime/scripts/slash-commands.js": slashRuntimeSource,
    "/plugin-runtime/slash-adapter.js": slashAdapterSource,
    "/plugin-runtime/slash-utils.js": "export * from '/plugin-runtime/scripts/slash-commands/SlashUtils.js';",
    ...slashUpstreamAssets,
    "/plugin-runtime/scripts/tokenizers.js": tokenizersSource,
    "/plugin-runtime/scripts/PromptManager.js": promptCollectionsSource,
    "/plugin-runtime/scripts/openai.js": completionCollectionsSource + "\nexport { createGenerationParameters, sendOpenAIRequest, getStreamingReply, tryParseStreamingError } from '/plugin-runtime/openai-transport.js';\nexport { oai_settings, proxies, chat_completion_sources, openai_max_stop_strings, getChatCompletionModel, isImageInliningSupported } from '/plugin-runtime/openai-settings.js';\nexport { getChatCompletionPreset, getPresetApplicationPromise } from '/plugin-runtime/scripts/preset-manager.js';\nexport { setOpenAIMessages, setOpenAIMessageExamples } from '/plugin-runtime/openai-conversion.js';\nexport { prepareOpenAIMessages, promptManager, setupChatCompletionPromptManager } from '/plugin-runtime/openai-prompt.js';",
    "/plugin-runtime/openai-settings.js": openAISettingsSource,
    "/plugin-runtime/presets.js": presetManagerSource,
    "/plugin-runtime/scripts/preset-manager.js": "export { getPresetManager, getChatCompletionPreset, getPresetApplicationPromise, loadPresets, mountPresetSelect, flushPresetWrites } from '/plugin-runtime/presets.js';",
    "/plugin-runtime/openai-transport.js": openAITransportSource,
    "/plugin-runtime/chat.js": chatPersistenceSource,
    "/plugin-runtime/chat-merge.js": chatMergeSource,
    "/plugin-runtime/compat-runtime.js": compatibilityRuntimeSource,
    "/plugin-runtime/settings.js": extensionSettingsSource,
    "/plugin-runtime/desktop-host.js": desktopHostSource,
    "/plugin-runtime/extensions.js": extensionsShimSource,
    "/plugin-runtime/scripts/extensions.js": extensionsShimSource,
    "/plugin-runtime/script.js": scriptShimSource,
    "/plugin-runtime/scripts/script.js": scriptShimSource,
    "/plugin-runtime/lib.js": libShimSource,
    "/plugin-runtime/scripts/lib.js": libShimSource,
    "/plugin-runtime/scripts/utils.js": utilityShimSource,
    "/plugin-runtime/scripts/sse-stream.js": eventSourceStreamSource,
    "/plugin-runtime/scripts/reasoning.js": reasoningRuntimeSource,
    "/plugin-runtime/scripts/i18n.js": i18nShimSource,
    "/plugin-runtime/scripts/popup.js": popupShimSource,
    "/plugin-runtime/scripts/st-context.js": "export { getContext } from '/plugin-runtime/compat-runtime.js';",
    "/plugin-runtime/scripts/constants.js": "export const debounce_timeout={quick:100,standard:300,relaxed:1000}; export const animation_duration=0;",
  };
  for (const [path, source] of Object.entries(runtimeModules)) {
    const aliases = [path];
    if (path.startsWith("/plugin-runtime/scripts/") || path === "/plugin-runtime/script.js" || path === "/plugin-runtime/lib.js") {
      aliases.push(path.replace("/plugin-runtime", ""));
    }
    for (const alias of aliases) {
      // Reused classes and their static command registry must have one ESM
      // identity, including when the desktop imports the runtime-prefixed URL.
      const slashAlias = path === "/plugin-runtime/scripts/slash-commands.js" || path.startsWith("/plugin-runtime/scripts/slash-commands/");
      const servedSource = slashAlias && alias === path ? `export * from '${path.replace("/plugin-runtime", "")}';` : source;
      app.get(alias, async (_request, reply) => reply
        .type("text/javascript; charset=utf-8")
        .header("Cache-Control", "no-store")
        .send(servedSource));
    }
  }

  // Missing modules must remain HTTP failures, including named imports. A 200
  // throwing stub cannot provide their named exports and conceals the cause.
  for (const prefix of ["/plugin-runtime/", "/scripts/"]) {
    app.get<{ Params: { "*": string } }>(`${prefix}*`, async (request, reply) => reply
      .status(404)
      .type("text/plain; charset=utf-8")
      .header("Cache-Control", "no-store")
      .send(`MyCompanion 尚未实现该扩展模块：${prefix}${request.params["*"]}`));
  }
}
