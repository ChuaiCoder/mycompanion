import type { FastifyInstance } from "fastify";
import { extensionPromptSchema, worldInfoDocumentSchema, worldInfoSettingsSchema, type ExtensionPrompt, type CharacterLorebookEntry } from "@mycompanion/shared";
import type { WorldInfoRepository } from "./world-info-repository.js";
import type { CharacterRepository } from "./character-repository.js";
import type { RuntimeRepository } from "./runtime-repository.js";
import { buildWorldInfoReport, finalizeWorldInfoRegex } from "./world-info-service.js";
import { MacroEvaluationSession } from "./prompt-macros.js";
import { MacroVariableConflictError } from "./macro-variable-conflict.js";
import { sendError } from "./http-errors.js";
import { TavernRegexExecutor } from "./tavern-regex-service.js";
import { bindCharacterMacroEnvironment } from "./character-macros.js";
import { completeMacroApi } from "./macro-boundary.js";
import { commitWorldInfoEffects, getCommittedWorldInfoState } from "./world-info-effects.js";

export function registerWorldInfoRoutes(app: FastifyInstance, books: WorldInfoRepository, characters: CharacterRepository,
  runtime: RuntimeRepository): void {
  const regexExecutor = new TavernRegexExecutor();
  app.addHook("onClose", async () => regexExecutor.close());
  app.get("/api/worldinfo/list", async (_request, reply) => reply.header("Cache-Control", "no-store").send({ world_names: books.names() }));
  const nameSchema = { type: "object", required: ["name"], properties: { name: { type: "string", minLength: 1, pattern: "^[^\\u0000]+$" } } };
  app.post<{ Body: { name: string } }>("/api/worldinfo/get", { schema: { body: nameSchema } }, async (request, reply) => {
    const book = books.get(request.body.name);
    return book ?? reply.status(404).send({ error: "World info not found" });
  });
  app.post<{ Body: { name: string; data: unknown } }>("/api/worldinfo/edit", { bodyLimit: 500 * 1024 * 1024, schema: { body: nameSchema } }, async (request, reply) => {
    const parsed = worldInfoDocumentSchema.safeParse(request.body.data);
    if (!parsed.success || !request.body.name.trim()) return reply.status(400).send({ error: "Invalid world info document" });
    books.save(request.body.name, parsed.data);
    return { ok: true };
  });
  app.post<{ Body: { name: string } }>("/api/worldinfo/delete", { schema: { body: nameSchema } }, async (request, reply) => {
    return books.delete(request.body.name) ? { ok: true } : reply.status(404).send({ error: "World info not found" });
  });
  app.get("/api/worldinfo/settings", async (_request, reply) => reply.header("Cache-Control", "no-store").send(books.settings()));
  app.put<{ Body: unknown }>("/api/worldinfo/settings", async (request, reply) => {
    const parsed = worldInfoSettingsSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid world info settings", details: parsed.error.issues });
    books.saveSettings(parsed.data);
    return parsed.data;
  });
  app.post<{ Body: { chat: string[]; maxContext: number; maxResponseTokens?: number; model?: string;
    globalVariables?: Record<string, unknown>; characterId?: string | null; metadata?: Record<string, unknown>;
    commitVariables?: boolean; browserMacros?: boolean; conversationId?: string | null; isDryRun?: boolean;
    settings?: unknown; globalScanData?: Record<string, string>; userName?: string;
    extensionScanText?: string; extensionScanTextResolved?: boolean; extensionScanPrompts?: ExtensionPrompt[] } }>("/api/worldinfo/prompt", {
    schema: { body: { type: "object", required: ["chat", "maxContext"], properties: {
      chat: { type: "array", items: { type: "string" } }, maxContext: { type: "number", minimum: 1 },
      maxResponseTokens: { type: "number", minimum: 0 },
      model: { type: "string", maxLength: 512 }, globalVariables: { type: "object" },
      commitVariables: { type: "boolean" }, conversationId: { type: ["string", "null"], format: "uuid" },
      browserMacros: { type: "boolean" }, isDryRun: { type: "boolean" },
      characterId: { type: ["string", "null"] }, metadata: { type: "object" },
      globalScanData: { type: "object", additionalProperties: { type: "string" } }, userName: { type: "string" },
      extensionScanText: { type: "string" },
      extensionScanTextResolved: { type: "boolean" },
      extensionScanPrompts: { type: "array", items: { type: "object" } },
    } } },
  }, async (request, reply) => {
    const body = request.body;
    // Existing read-only API callers omit isDryRun and explicitly suppress
    // effects. The Tavern adapter always supplies its public isDryRun argument.
    const dryRun = body.isDryRun ?? body.commitVariables !== true;
    if (body.extensionScanPrompts?.some(prompt => !extensionPromptSchema.safeParse(prompt).success))
      return sendError(reply,400,"INVALID_EXTENSION_PROMPT","扩展扫描提示词参数无效。");
    const conversation = body.conversationId ? runtime.getConversation(body.conversationId) : undefined;
    if (body.commitVariables && body.conversationId) {
      if (!conversation) return sendError(reply,404,"CONVERSATION_NOT_FOUND","故事不存在。");
      if (body.characterId && conversation.characterId !== body.characterId)
        return sendError(reply,409,"MACRO_CONTEXT_CHANGED","故事与角色已变化，请重新组装提示词。");
    }
    const character = body.characterId ? characters.get(body.characterId) : undefined;
    if (body.characterId && !character) return reply.status(404).send({ error: "Character not found" });
    const parsed = worldInfoSettingsSchema.safeParse(body.settings ?? books.settings());
    if (!parsed.success) return reply.status(400).send({ error: "Invalid world info settings" });
    const provider = runtime.getProvider();
    const extensionSettings = runtime.getExtensionSettings();
    if(body.globalVariables !== undefined) extensionSettings.variables = {global:body.globalVariables};
    // An omitted snapshot means use durable state. An explicitly supplied stale
    // snapshot must still participate in the atomic conflict check below.
    const metadata = body.metadata ?? conversation?.chatMetadata ?? {};
    const macroSession = new MacroEvaluationSession(metadata,extensionSettings);
    if (character) bindCharacterMacroEnvironment(character, metadata, extensionSettings, provider, macroSession);
    let entries: CharacterLorebookEntry[] = [];
    return completeMacroApi(app, reply, { conversationId: body.conversationId ?? null, branchId: conversation?.activeBranchId ?? null },
      macroSession, body.browserMacros === true, async signal => {
    const scanned = buildWorldInfoReport(books, character ?? {
      id: "00000000-0000-4000-8000-000000000000", name: "", lorebookEnabled: [], rawExtensions: {},
      description: "", personality: "", scenario: "", creatorNotes: "",
    }, [], metadata, body.maxContext, {
      chat: body.chat, settings: parsed.data, ...(body.globalScanData === undefined ? {} : {globalScanData:body.globalScanData}), userName: body.userName ?? "User",
      model: body.model || provider.model,
      maxResponseTokens: body.maxResponseTokens ?? provider.maxTokens,
      extensionSettings,
      macroSession,
      dryRun,
      worldInfoSourceMessages: conversation?.messages ?? [],
      ...(conversation ? { worldInfoBranchId: conversation.activeBranchId } : {}),
      ...(body.extensionScanText ? { extensionScanText: body.extensionScanText } : {}),
      ...(body.extensionScanTextResolved ? { extensionScanTextResolved: true } : {}),
      ...(body.extensionScanPrompts ? { extensionScanPrompts: body.extensionScanPrompts } : {}),
      onEntries: value => { entries = value; },
    });
    const report = await finalizeWorldInfoRegex(scanned, regexExecutor, character, metadata, extensionSettings, macroSession, {
      userName: body.userName ?? "User", model: body.model || provider.model,
      contextLimitTokens: body.maxContext, maxResponseTokens: body.maxResponseTokens ?? provider.maxTokens,
      ...(signal ? { signal } : {}),
    });
    const macroChanges = macroSession.changes();
    const selected = new Map(report.results.filter(result => result.status === "injected").map(result => [result.index, result]));
    return { report, ...(body.commitVariables ? {macroChanges} : {}), activated: entries.filter(entry => selected.has(entry.index)).map(entry => ({
      ...entry.worldInfo, key: entry.keys, keysecondary: entry.secondaryKeys, comment: entry.name,
      content: selected.get(entry.index)!.content, constant: entry.constant, selective: entry.selective, order: entry.insertionOrder,
    })) };
    }, result => {
      if (body.commitVariables || (!dryRun && conversation)) {
        try { runtime.withTransaction(() => {
          if (body.commitVariables) runtime.commitMacroVariables(body.conversationId ?? null, result.macroChanges ?? []);
          if (!dryRun && conversation) commitWorldInfoEffects(runtime, conversation.id, conversation.activeBranchId, result.report);
        }); }
        catch(error) {
          if(body.browserMacros)throw error;
          if(error instanceof MacroVariableConflictError)return sendError(reply,409,"MACRO_VARIABLE_CONFLICT",error.message);
          throw error;
        }
      }
      const worldInfoState=!dryRun&&conversation ? getCommittedWorldInfoState(runtime,conversation.id,result.report) : undefined;
      return {...result,...(worldInfoState?{worldInfoState}:{})};
    });
  });
}
