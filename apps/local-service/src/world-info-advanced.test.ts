import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { parse } from "acorn";
import { parseRegexFromString, worldInfoSettingsSchema, type CharacterLorebookEntry, type ChatMessage } from "@mycompanion/shared";
import { parseCharacterCardDocument } from "@mycompanion/character-card";
import { matchLorebookEntries, estimateTokens } from "./worldbook-engine.js";
import { createWorldInfoRuntime } from "./world-info-upstream-runtime.js";
import { createWorldInfoEffectsDraft, commitWorldInfoEffects, getWorldInfoEffects, getCommittedWorldInfoState, worldInfoStateRevision, WORLD_INFO_STATE_KEY } from "./world-info-effects.js";
import { RuntimeRepository } from "./runtime-repository.js";
import { CharacterRepository } from "./character-repository.js";
import { MacroEvaluationSession, resolveMacroField } from "./prompt-macros.js";
import { buildWorldInfoReport, finalizeWorldInfoRegex } from "./world-info-service.js";
import { getWorldInfoOutletEntries } from "./world-info-activation.js";
import { TavernRegexExecutor } from "./tavern-regex-service.js";

const characterId = "00000000-0000-4000-8000-000000000001";
const entry = (index: number, extra: Record<string, unknown> = {}, override: Partial<CharacterLorebookEntry> = {}): CharacterLorebookEntry => ({
  index, name: `entry ${index}`, keys: ["hit"], secondaryKeys: [], content: `CONTENT_${index}`, enabled: true,
  constant: false, caseSensitive: false, selective: true, insertionOrder: 100 - index, sourceEnabled: true,
  worldInfo: { world: "test", uid: index, ...extra }, ...override,
});
const message = (index: number, content: string): ChatMessage => ({ id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  conversationId: characterId, branchId: characterId, parentMessageId: null, role: "user", content, status: "complete", createdAt: "2026-10-03T00:00:00Z" });
const selected = (report: ReturnType<typeof matchLorebookEntries>) => report.results.filter(item => item.status === "injected").map(item => item.index);
const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach(database => database.close()));

describe("fixed-upstream native world-info semantics", () => {
  it("scans explicit injections at zero chat depth without scanning messages or implicit character/recursive text", () => {
    const entries = [entry(0, { scanDepth: 0 }, { keys: ["INJECTION"] }),
      entry(1, { scanDepth: 0 }, { keys: ["CHAT"] }),
      entry(2, { scanDepth: 0, matchCharacterDescription: true }, { keys: ["CHARACTER"] })];
    const options = { messages: ["CHAT"], extensionScanText: "INJECTION", globalScanData: { characterDescription: "CHARACTER" } };
    expect(selected(matchLorebookEntries(characterId, entries, "Char", "", 1000, options))).toEqual([0]);
    expect(selected(matchLorebookEntries(characterId, entries, "Char", "", 1000, { ...options, extensionScanText: "" }))).toEqual([]);
  });
  it("extends only global scan depth for minimum activations and obeys the explicit scan-step limit", () => {
    const entries = [entry(0, {}, { keys: ["old"] }), entry(1, { scanDepth: 1 }, { keys: ["old"] })];
    const options = { messages: ["new", "middle", "old"], scanDepth: 1, minActivations: 1 };
    expect(selected(matchLorebookEntries(characterId, entries, "Char", "", 1000, options))).toEqual([0]);
    expect(selected(matchLorebookEntries(characterId, entries, "Char", "", 1000, { ...options, maxRecursionSteps: 1 }))).toEqual([]);
  });
  it("uses group priority, weights and literal scoring overrides before probability draws", () => {
    const priority = [entry(0, { group: "g", groupOverride: true, groupWeight: 0 }), entry(1, { group: "g", groupWeight: 1000 })];
    let draws = 0;
    expect(selected(matchLorebookEntries(characterId, priority, "Char", "hit", 1000, { random: () => { draws++; return .9; } }))).toEqual([0]);
    expect(draws).toBe(0); // Probability 100 is not another lottery.
    expect(selected(matchLorebookEntries(characterId, [entry(0, { group: "g", groupWeight: 1 }), entry(1, { group: "g", groupWeight: 9 })],
      "Char", "hit", 1000, { random: () => .5 }))).toEqual([1]);
    const scoring = [entry(0, { group: "g" }, { keys: ["hit", "other"] }), entry(1, { group: "g" })];
    expect(selected(matchLorebookEntries(characterId, scoring, "Char", "hit other", 1000, { useGroupScoring: true, random: () => .99 }))).toEqual([0]);
  });
  it("does not delete an unrelated final candidate when an overlapping group removes the same entry twice", () => {
    const entries = [entry(0, { group: "g1,g2", groupWeight: 1 }), entry(1, { group: "g1", groupWeight: 99 }),
      entry(2, { group: "g2", groupWeight: 99 }), entry(3)];
    expect(selected(matchLorebookEntries(characterId, entries, "Char", "hit", 1000, { random: () => .9 }))).toEqual([1, 2, 3]);
  });
  it("filters generation triggers, character names and delay before constant/keyword activation", () => {
    const entries = [entry(0, { triggers: ["quiet"] }, { constant: true }), entry(1, { characterFilter: { names: ["Char"], isExclude: false } }),
      entry(2, { delay: 3 }, { constant: true }), entry(3, {}, { keys: [], content: "@@activate\nFORCED" })];
    expect(selected(matchLorebookEntries(characterId, entries, "Char", "hit", 1000,
      { messages: ["hit"], trigger: "normal", characterFilename: "Char" }))).toEqual([1, 3]);
    expect(matchLorebookEntries(characterId, entries, "Char", "hit", 1000).results[3]!.content).toBe("FORCED");
    expect(selected(matchLorebookEntries(characterId, [entry(0, { triggers: ["normal"] })], "Char", "hit", 1000))).toEqual([0]);
    expect(selected(matchLorebookEntries(characterId, [entry(0, { triggers: ["normal"] })], "Char", "hit", 1000, { globalScanData: {} }))).toEqual([]);
    const tagEntry = entry(0, { characterFilter: { tags: ["tag-id"], isExclude: false } });
    expect(selected(matchLorebookEntries(characterId, [tagEntry], "Char", "hit", 1000))).toEqual([0]);
    expect(selected(matchLorebookEntries(characterId, [tagEntry], "Char", "hit", 1000, { characterTagIds: [] }))).toEqual([]);
    expect(selected(matchLorebookEntries(characterId, [tagEntry], "Char", "hit", 1000, { characterTagIds: ["tag-id"] }))).toEqual([0]);
  });
  it("clones timer metadata, advances sticky into protected cooldown, and bypasses sticky probability", () => {
    const item = entry(0, { sticky: 3, cooldown: 2, probability: 1 });
    const sources = [message(1, "hit")];
    const first = matchLorebookEntries(characterId, [item], "Char", "hit", 1000,
      { dryRun: false, effectsDraft: createWorldInfoEffectsDraft({}, "branch", sources), random: () => 0 });
    const draft = getWorldInfoEffects(first)!;
    const durable = { timedWorldInfo: structuredClone(draft.timedWorldInfo) }, before = structuredClone(durable);
    const next = matchLorebookEntries(characterId, [item], "Char", "none", 1000,
      { dryRun: false, effectsDraft: createWorldInfoEffectsDraft(durable, "branch", [...sources, message(2, "none")]), random: () => .99 });
    expect(selected(next)).toEqual([0]); expect(durable).toEqual(before);
    const expired = matchLorebookEntries(characterId, [item], "Char", "hit", 1000,
      { dryRun: false, effectsDraft: createWorldInfoEffectsDraft(durable, "branch", [...sources, message(2, "none"), message(3, "none"), message(4, "hit")]), random: () => 0 });
    expect(selected(expired)).toEqual([]);
    expect(getWorldInfoEffects(expired)!.timedWorldInfo.cooldown).toEqual({ "test.0": expect.objectContaining({ start: 4, end: 6, protected: true }) });
    const preview = matchLorebookEntries(characterId, [item], "Char", "none", 1000,
      { effectsDraft: createWorldInfoEffectsDraft(durable, "branch", [...sources, message(2, "none")]) });
    expect(selected(preview)).toEqual([]); expect(getWorldInfoEffects(preview)).toBeUndefined();
  });
  it("invalidates sticky matching when the entry content changes without discarding an unexpired foreign entry", () => {
    const item = entry(0, { sticky: 5 }), sources = [message(1, "hit")];
    const first = matchLorebookEntries(characterId, [item], "Char", "hit", 1000,
      { dryRun: false, effectsDraft: createWorldInfoEffectsDraft({}, "branch", sources) });
    const durable = { timedWorldInfo: getWorldInfoEffects(first)!.timedWorldInfo };
    const changed = matchLorebookEntries(characterId, [{ ...item, content: "CHANGED CONTENT" }], "Char", "no keyword", 1000,
      { dryRun: false, effectsDraft: createWorldInfoEffectsDraft(durable, "branch", [...sources, message(2, "none")]) });
    expect(selected(changed)).toEqual([]);
    // Upstream retains unknown hashes until their end; it does not activate the
    // current entry from a same-key but different-content timer.
    expect(getWorldInfoEffects(changed)!.timedWorldInfo.sticky).toEqual(durable.timedWorldInfo.sticky);
  });
  it("replays group/probability draws once per actual ordinal without committing timer drafts", async () => {
    const entries = [entry(0, { group: "g", probability: 50, sticky: 4 }, { content: "{{incvar::count}}" }), entry(1, { group: "g", probability: 50 })];
    const session = new MacroEvaluationSession();
    let draws = 0;
    const metadata = {}, effectsDraft = createWorldInfoEffectsDraft(metadata, "branch", [message(1, "hit")]);
    // 原生宏会话直接求值 {{incvar::count}}，不再经过浏览器宏边界回调。
    const report = await matchLorebookEntries(characterId, entries, "Char", "hit", 1000,
      { macroSession: session, effectsDraft, dryRun: false, random: () => { draws++; return .1; } });
    expect(selected(report)).toEqual([0]); expect(draws).toBe(2);
    expect(session.local).toEqual({ count: 1 }); expect(metadata).toEqual({});
    expect(getWorldInfoEffects(report)!.timedWorldInfo.sticky).toEqual({ "test.0": expect.objectContaining({ start: 1, end: 5 }) });
  });
  it("loads persona-bound books after chat books and deduplicates global/chat/persona/character bindings", () => {
    const database = new DatabaseSync(":memory:"); databases.push(database);
    const runtime = new RuntimeRepository(database), books = runtime.worldInfo;
    for (const [name, order] of [["shared", 10], ["persona", 9], ["chat", 8]] as const) books.save(name, { entries: { 1: { uid: 1, constant: true, content: name, order } } });
    books.saveSettings(worldInfoSettingsSchema.parse({ world_info: { globalSelect: ["shared"], charLore: [{ name: "Char", extraBooks: ["persona", "shared"] }] } }));
    const character = { id: characterId, name: "Char", lorebookEnabled: [], rawExtensions: { world: "shared" }, description: "", personality: "", scenario: "", creatorNotes: "" };
    const report = buildWorldInfoReport(books, character, [], { world_info: "chat" }, 4096,
      { extensionSettings: { __mycompanion_power_user: { persona_description_lorebook: "persona" } } });
    expect(report.results.map(result => result.world)).toEqual(["chat", "persona", "shared"]);
    expect(report.injectedCount).toBe(3);
  });
  it("keeps effects through the placement-5 regex copy without writing on a failed/preview pass", async () => {
    const item = entry(0, { sticky: 3 });
    const report = matchLorebookEntries(characterId, [item], "Char", "hit", 1000,
      { dryRun: false, effectsDraft: createWorldInfoEffectsDraft({}, "branch", [message(1, "hit")]) });
    const executor = new TavernRegexExecutor();
    try {
      const final = await finalizeWorldInfoRegex(report, executor, undefined, {}, {}, new MacroEvaluationSession());
      expect(getWorldInfoEffects(final)).toBe(getWorldInfoEffects(report));
    } finally { await executor.close(); }
  });
});

describe("world-info accepted request persistence", () => {
  it("does not write or publish normalized empty timer containers, including legacy empty checkpoints", () => {
    const database = new DatabaseSync(":memory:"); databases.push(database);
    const runtime = new RuntimeRepository(database), characters = new CharacterRepository(database);
    const character = characters.import(parseCharacterCardDocument({ name: "No timer", first_mes: "hello" }), "no-timer.json").character;
    const story = runtime.createConversation(character);
    for (const withEmptyHistory of [false, true]) {
      if (withEmptyHistory) {
        const current = runtime.getConversation(story.id)!;
        runtime.commitWorldInfoState(story.id, current.activeBranchId, worldInfoStateRevision(current.chatMetadata ?? {}), {
          timedWorldInfo: { sticky: {}, cooldown: {} }, [WORLD_INFO_STATE_KEY]: { version: 1, revision: 1,
            activeBranchId: current.activeBranchId, checkpoints: [{ branchId: current.activeBranchId, sourceCount: 0,
              sourceFingerprint: createHash("sha256").update(JSON.stringify([])).digest("hex"), timedWorldInfo: { sticky: {}, cooldown: {} } }] },
        }, []);
      }
      const before = runtime.getConversation(story.id)!;
      for (const items of [[], [entry(0)], [entry(0, { delay: 4 })]]) {
        const report = matchLorebookEntries(character.id, items, "No timer", "hit", 1000, { dryRun: false,
          effectsDraft: createWorldInfoEffectsDraft(before.chatMetadata ?? {}, before.activeBranchId, before.messages) });
        expect(getWorldInfoEffects(report)).toBeUndefined();
        runtime.withTransaction(() => commitWorldInfoEffects(runtime, story.id, before.activeBranchId, report));
        expect(runtime.getConversation(story.id)).toEqual(before);
        expect(getCommittedWorldInfoState(runtime, story.id, report)).toBeUndefined();
      }
    }
  });
  it("commits removal of the last real timer and only publishes the actually accepted revision", () => {
    const database = new DatabaseSync(":memory:"); databases.push(database);
    const runtime = new RuntimeRepository(database), characters = new CharacterRepository(database);
    const character = characters.import(parseCharacterCardDocument({ name: "Timer", first_mes: "hello" }), "timer.json").character;
    const story = runtime.createConversation(character), item = entry(0, { sticky: 1 });
    const firstSource = runtime.getConversation(story.id)!;
    const first = matchLorebookEntries(character.id, [item], "Timer", "hit", 1000, { dryRun: false,
      effectsDraft: createWorldInfoEffectsDraft(firstSource.chatMetadata ?? {}, firstSource.activeBranchId, firstSource.messages) });
    expect(getCommittedWorldInfoState(runtime, story.id, first)).toBeUndefined();
    runtime.withTransaction(() => commitWorldInfoEffects(runtime, story.id, firstSource.activeBranchId, first));
    expect(getCommittedWorldInfoState(runtime, story.id, first)?.timedWorldInfo).toEqual(getWorldInfoEffects(first)!.timedWorldInfo);
    runtime.addMessage(story.id, "user", "no activation");
    const expiredSource = runtime.getConversation(story.id)!;
    const expired = matchLorebookEntries(character.id, [item], "Timer", "no activation", 1000, { dryRun: false,
      effectsDraft: createWorldInfoEffectsDraft(expiredSource.chatMetadata ?? {}, expiredSource.activeBranchId, expiredSource.messages) });
    expect(getWorldInfoEffects(expired)!.timedWorldInfo).toEqual({ sticky: {}, cooldown: {} });
    expect(getCommittedWorldInfoState(runtime, story.id, expired)).toBeUndefined();
    expect(() => runtime.withTransaction(() => {
      commitWorldInfoEffects(runtime, story.id, expiredSource.activeBranchId, expired); throw new Error("rollback expired cleanup");
    })).toThrow("rollback expired cleanup");
    expect(getCommittedWorldInfoState(runtime, story.id, expired)).toBeUndefined();
    runtime.withTransaction(() => commitWorldInfoEffects(runtime, story.id, expiredSource.activeBranchId, expired));
    expect(getCommittedWorldInfoState(runtime, story.id, expired)?.timedWorldInfo).toEqual({ sticky: {}, cooldown: {} });
    expect(runtime.getConversation(story.id)?.chatMetadata?.timedWorldInfo).toEqual({ sticky: {}, cooldown: {} });
  });
  it("commits timer/assistant atomically, survives restart, rolls back insertion failure, and isolates edited/old branches", () => {
    const directory = mkdtempSync(join(tmpdir(), "mycompanion-w01-")), path = join(directory, "profile.sqlite");
    let database = new DatabaseSync(path), runtime = new RuntimeRepository(database);
    try {
      const characters = new CharacterRepository(database);
      const character = characters.import(parseCharacterCardDocument({ spec: "chara_card_v2", spec_version: "2.0", data: {
        name: "Char", first_mes: "hello", alternate_greetings: [], description: "", tags: [], personality: "", scenario: "",
        mes_example: "", system_prompt: "", post_history_instructions: "", creator_notes: "", creator: "MyCompanion",
        character_version: "1", extensions: {},
      } }), "w01-character.json").character;
      const story = runtime.createConversation(character);
      const user = runtime.addMessage(story.id, "user", "hit");
      const source = runtime.getConversation(story.id)!, item = entry(0, { sticky: 5, cooldown: 2 });
      const make = () => matchLorebookEntries(characterId, [item], "Char", "hit", 1000, { dryRun: false,
        effectsDraft: createWorldInfoEffectsDraft(source.chatMetadata ?? {}, source.activeBranchId, source.messages) });
      const rejected = make();
      expect(() => runtime.withTransaction(() => {
        const assistant = runtime.createAssistantMessage(story.id); commitWorldInfoEffects(runtime, story.id, assistant.branchId, rejected);
        throw new Error("injected placeholder transaction failure");
      })).toThrow("injected placeholder");
      expect(runtime.getConversation(story.id)).toEqual(source);
      const accepted = make();
      // Unrelated local-variable edits merge with the WI draft; only public or
      // private WI state and changed source messages invalidate its revision.
      runtime.commitMacroVariables(story.id, [{ scope: "local", key: "unrelated", beforeExists: false, afterExists: true, after: 1 }]);
      runtime.withTransaction(() => { const assistant = runtime.createAssistantMessage(story.id);
        commitWorldInfoEffects(runtime, story.id, assistant.branchId, accepted); runtime.finalizeAssistantMessage(assistant, "complete", "reply"); });
      const persisted = runtime.getConversation(story.id)!;
      expect(persisted.chatMetadata?.timedWorldInfo).toEqual(getWorldInfoEffects(accepted)!.timedWorldInfo);
      expect(persisted.chatMetadata?.variables).toEqual({ unrelated: 1 });
      expect(() => commitWorldInfoEffects(runtime, story.id, persisted.activeBranchId, accepted)).toThrow("计时状态");
      database.close(); database = new DatabaseSync(path); runtime = new RuntimeRepository(database);
      expect(runtime.getConversation(story.id)?.chatMetadata).toEqual(persisted.chatMetadata);
      expect(runtime.listConversationsForBackup()[0]?.chatMetadata).toEqual(persisted.chatMetadata);
      const edited = runtime.editMessage(story.id, user.id, "new branch without keyword")!;
      const branch = runtime.getConversation(story.id)!;
      expect(createWorldInfoEffectsDraft(branch.chatMetadata ?? {}, edited.branchId, branch.messages).timedWorldInfo).toEqual({});
      runtime.activateBranch(story.id, source.activeBranchId);
      const old = runtime.getConversation(story.id)!;
      expect(createWorldInfoEffectsDraft(old.chatMetadata ?? {}, old.activeBranchId, old.messages).timedWorldInfo).toEqual(persisted.chatMetadata?.timedWorldInfo);
      expect(old.chatMetadata?.[WORLD_INFO_STATE_KEY]).toBeDefined();
      const expectedPrefix = old.messages.slice(0, -1).map(message => message.id);
      const regenerated = runtime.prepareRegenerateLastAssistant(story.id)!;
      expect(regenerated.createdBranch).toBe(true);
      expect(runtime.getConversation(story.id)?.messages.map(message => message.id)).toEqual(expectedPrefix);
      runtime.activateBranch(story.id, old.activeBranchId);
      const waiting = matchLorebookEntries(characterId, [item], "Char", "hit", 1000, { dryRun: false,
        effectsDraft: createWorldInfoEffectsDraft(old.chatMetadata ?? {}, old.activeBranchId, old.messages) });
      database.prepare("UPDATE conversations SET metadata_json = json_set(metadata_json, '$.timedWorldInfo.sticky', json('{}')) WHERE id = ?").run(story.id);
      expect(() => commitWorldInfoEffects(runtime, story.id, old.activeBranchId, waiting)).toThrow("计时状态");
      const latest = runtime.getConversation(story.id)!;
      expect(createWorldInfoEffectsDraft(latest.chatMetadata ?? {}, latest.activeBranchId, latest.messages).timedWorldInfo.sticky).toEqual({});
    } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it("mounts the selected branch timers before raw extension edits and preserves each branch's outgoing edits",()=>{
    const database=new DatabaseSync(":memory:");databases.push(database);const runtime=new RuntimeRepository(database),characters=new CharacterRepository(database);
    const character=characters.import(parseCharacterCardDocument({spec:"chara_card_v2",spec_version:"2.0",data:{name:"Branch timers",first_mes:"hello",description:"",
      personality:"",scenario:"",mes_example:"",creator_notes:"",system_prompt:"",post_history_instructions:"",alternate_greetings:[],tags:[],creator:"",character_version:"",extensions:{}}}),"branch-timers.json").character;
    const story=runtime.createConversation(character),user=runtime.addMessage(story.id,"user","hit"),source=runtime.getConversation(story.id)!;
    const report=matchLorebookEntries(character.id,[entry(0,{sticky:5})],character.name,"hit",1000,{dryRun:false,
      effectsDraft:createWorldInfoEffectsDraft(source.chatMetadata??{},source.activeBranchId,source.messages)});
    runtime.withTransaction(()=>commitWorldInfoEffects(runtime,story.id,source.activeBranchId,report));
    const original=runtime.getConversation(story.id)!,timers=structuredClone(original.chatMetadata!.timedWorldInfo);
    const edited=runtime.editMessage(story.id,user.id,"no keyword")!,branch=runtime.getConversation(story.id)!;
    expect(branch.chatMetadata!.timedWorldInfo).toEqual({});
    expect((branch.chatMetadata![WORLD_INFO_STATE_KEY] as any).activeBranchId).toBe(edited.branchId);
    const external={sticky:{"test.0":{...(timers as any).sticky["test.0"],end:99}}};
    database.prepare("UPDATE conversations SET metadata_json=json_set(metadata_json,'$.timedWorldInfo',json(?)) WHERE id=?").run(JSON.stringify(external),story.id);
    const modified=runtime.getConversation(story.id)!;
    expect(createWorldInfoEffectsDraft(modified.chatMetadata!,modified.activeBranchId,modified.messages).timedWorldInfo).toEqual(external);
    const restored=runtime.activateBranch(story.id,original.activeBranchId)!;expect(restored.chatMetadata!.timedWorldInfo).toEqual(timers);
    database.prepare("UPDATE conversations SET metadata_json=json_set(metadata_json,'$.timedWorldInfo',json('{}')) WHERE id=?").run(story.id);
    expect(runtime.activateBranch(story.id,edited.branchId)!.chatMetadata!.timedWorldInfo).toEqual(external);
    expect(runtime.activateBranch(story.id,original.activeBranchId)!.chatMetadata!.timedWorldInfo).toEqual({});
    const before=runtime.getConversation(story.id)!;runtime.activateBranch(story.id,original.activeBranchId);
    expect(runtime.getConversation(story.id)!.chatMetadata).toEqual(before.chatMetadata);
  });
});

// This optional oracle reads pristine declarations, not the adapted scanner.
// Normal checks need neither a checkout nor research/cache fixtures.
it.skipIf(!process.env.SILLYTAVERN_WORLD_INFO_ORACLE_ROOT)("compares native scan states/selections/timers against pristine fixed-upstream checkWorldInfo", async () => {
  const root = resolve(process.env.SILLYTAVERN_WORLD_INFO_ORACLE_ROOT!);
  const world = readFileSync(join(root, "public/scripts/world-info.js"), "utf8"), utils = readFileSync(join(root, "public/scripts/utils.js"), "utf8");
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  expect(sha(world)).toBe("111c7f47945839e75b021e09bdbb112a54f0a9b7857d2b95435f573efc7cd9a5");
  function declaration(source: string, name: string): string {
    const nodes = parse(source, { ecmaVersion: "latest", sourceType: "module" }).body;
    const node = nodes.map((value: any) => value.type === "ExportNamedDeclaration" ? value.declaration : value)
      .find((value: any) => value?.id?.name === name || value?.declarations?.some((item: any) => item.id?.name === name));
    if (!node) throw new Error(`Missing genuine ${name}`);
    return source.slice(node.start, node.end);
  }
  const names = ["sortFn", "DEFAULT_WEIGHT", "MAX_SCAN_DEPTH", "KNOWN_DECORATORS", "scan_state", "world_info_logic", "defaultGlobalScanData",
    "world_info_position", "wi_anchor_position", "WorldInfoBuffer", "WorldInfoTimedEffects", "parseDecorators", "filterGroupsByScoring",
    "filterGroupsByTimedEffects", "filterByInclusionGroups", "checkWorldInfo"];
  const pristine = names.map(name => declaration(world, name)).join("\n") + "\n" + ["getStringHash", "escapeRegex"].map(name => declaration(utils, name)).join("\n");
  let beforeMatch: typeof matchLorebookEntries | undefined, beforeSha256: string | undefined;
  if (process.env.MYCOMPANION_WORLD_INFO_BEFORE_PATH) {
    const beforeSource = readFileSync(process.env.MYCOMPANION_WORLD_INFO_BEFORE_PATH, "utf8");
    beforeSha256 = sha(beforeSource);
    expect(beforeSha256).toBe("785557e440c2d62198d1b9aa25625dd9a3da76128fe5efc1520f04dc135211ca");
    const { transform } = await import("esbuild");
    const javascript = (await transform(beforeSource, { loader: "ts", format: "esm" })).code;
    const body = parse(javascript, { ecmaVersion: "latest", sourceType: "module" }).body
      .filter(node => node.type !== "ImportDeclaration" && node.type !== "ExportNamedDeclaration")
      .map(node => javascript.slice(node.start, node.end)).join("\n");
    const beforeVm = createContext({ Date, Math, resolveMacroField, MacroEvaluationSession,
      parseWorldInfoRegex: parseRegexFromString, countTextTokens: estimateTokens });
    runInContext(body + "\n globalThis.beforeMatch = matchLorebookEntries;", beforeVm);
    beforeMatch = beforeVm.beforeMatch;
  }
  const fixtures: Array<{ name: string; entries: any[]; messages?: string[]; settings?: Record<string, unknown>; roll?: number; trigger?: string; dryRun?: boolean;
    timer?: "sticky" | "cooldown"; repair?: boolean; injectionRepair?: boolean; injection?: string; globalScanData?: Record<string, string> }> = [
    { name: "basic", entries: [{ uid: 0, key: ["hit"] }] },
    { name: "minimum-depth", entries: [{ uid: 0, key: ["old"] }], messages: ["new", "middle", "old"], settings: { world_info_depth: 1, world_info_min_activations: 1 } },
    { name: "minimum-explicit-depth", entries: [{ uid: 0, key: ["old"], scanDepth: 1 }], messages: ["new", "old"], settings: { world_info_depth: 1, world_info_min_activations: 1 } },
    { name: "maximum-scan-steps", entries: [{ uid: 0, key: ["old"] }], messages: ["new", "old"], settings: { world_info_depth: 1, world_info_min_activations: 1, world_info_max_recursion_steps: 1 } },
    { name: "group-weight", entries: [{ uid: 0, group: "g", groupWeight: 1 }, { uid: 1, group: "g", groupWeight: 9 }], roll: .9 },
    { name: "group-priority", entries: [{ uid: 0, group: "g", groupOverride: true }, { uid: 1, group: "g" }], roll: .9 },
    { name: "group-score", entries: [{ uid: 0, group: "g", key: ["hit", "other"] }, { uid: 1, group: "g" }], messages: ["hit other"], settings: { world_info_use_group_scoring: true } },
    { name: "entry-score-override", entries: [{ uid: 0, group: "g", key: ["hit", "other"] }, { uid: 1, group: "g", useGroupScoring: false }], messages: ["hit other"], settings: { world_info_use_group_scoring: true }, roll: .9 },
    { name: "overlapping-group-idempotent-removal", entries: [{ uid: 0, group: "g1,g2", groupWeight: 1 }, { uid: 1, group: "g1", groupWeight: 99 }, { uid: 2, group: "g2", groupWeight: 99 }, { uid: 3 }], roll: .9, repair: true },
    { name: "zero-chat-depth-explicit-injection-native-contract", entries: [{ uid: 0, key: ["INJECTION"], scanDepth: 0 },
      { uid: 1, key: ["CHAT"], scanDepth: 0 }], messages: ["CHAT"], injection: "INJECTION", injectionRepair: true },
    { name: "generation-trigger", entries: [{ uid: 0, triggers: ["quiet"] }, { uid: 1, triggers: ["normal"] }], trigger: "quiet" },
    { name: "explicit-scan-data-without-trigger", entries: [{ uid: 0, triggers: ["normal"] }], globalScanData: {} },
    { name: "character-filter", entries: [{ uid: 0, characterFilter: { names: ["Char"], isExclude: true } }, { uid: 1 }] },
    { name: "delay", entries: [{ uid: 0, delay: 3 }, { uid: 1 }] },
    { name: "sticky-probability", entries: [{ uid: 0, sticky: 4, cooldown: 2, probability: 1 }], messages: ["none", "none"], timer: "sticky", roll: .9 },
    { name: "sticky-ends-cooldown-protected", entries: [{ uid: 0, sticky: 1, cooldown: 2 }], messages: ["hit", "hit"], timer: "sticky" },
    { name: "cooldown", entries: [{ uid: 0, cooldown: 4 }], messages: ["hit", "hit"], timer: "cooldown" },
    { name: "dry-run-timers", entries: [{ uid: 0, sticky: 4, cooldown: 2 }], messages: ["none", "none"], timer: "sticky", dryRun: true },
    { name: "activation-decorator", entries: [{ uid: 0, key: [], content: "@@activate\nFORCED" }, { uid: 1, content: "@@dont_activate\nNEVER" }] },
    { name: "recursive-trigger", entries: [{ uid: 0, content: "second" }, { uid: 1, key: ["second"] }], settings: { world_info_recursive: true } },
    { name: "recursion-levels", entries: [{ uid: 0, delayUntilRecursion: 1 }, { uid: 1, delayUntilRecursion: 4 }], settings: { world_info_recursive: false } },
    { name: "probability", entries: [{ uid: 0, probability: 50 }, { uid: 1, probability: 90 }], roll: .7 },
    { name: "outlet-descending-stable-activation-ties", entries: [
      { uid: 2, order: 101, constant: true, content: "HIGH", position: 7, outletName: "story" },
      { uid: 0, order: 100, key: ["second"], content: "LATE", position: 7, outletName: "story" },
      { uid: 1, order: 100, constant: true, content: "second", position: 7, outletName: "story" },
    ], messages: [], settings: { world_info_recursive: true } },
  ];
  const evidence: any[] = [];
  for (const fixture of fixtures) {
    const metadata: Record<string, any> = {}, settings = worldInfoSettingsSchema.parse(fixture.settings ?? {}), phases: any[] = [], draws: number[] = [];
    const context = { extensionPrompts: fixture.injection ? { native: { scan: true, value: fixture.injection } } : {}, tagMap: { character: [] } };
    const normalized: any[] = [];
    const vm = createContext({ ...settings, chat_metadata: metadata, structuredClone, parseRegexFromString,
      console: { debug() {}, log() {}, warn() {}, error() {} }, toastr: { warning() {} },
      getContext: () => context, getCharaFilename: () => "Char", getTagKeyForEntity: () => "character", this_chid: characterId,
      getExtensionPromptByName: async () => fixture.injection ?? "", getSortedEntries: async () => normalized,
      getTokenCountAsync: async (text: string) => estimateTokens(text), substituteParams: (text: string) => text,
      getRegexedString: (text: string) => text, regex_placement: { WORLD_INFO: 5 }, DEFAULT_DEPTH: 4, extension_prompt_roles: { SYSTEM: 0 }, shouldWIAddPrompt: false,
      event_types: { WORLDINFO_SCAN_DONE: "scan" }, eventSource: { emit: async (_type: string, args: any) => phases.push({ ...args.state }) },
      Math: Object.assign(Object.create(Math), { random: () => { draws.push(fixture.roll ?? .2); return fixture.roll ?? .2; } }),
    });
    runInContext(pristine, vm);
    for (const raw of fixture.entries) {
      const base = { world: "oracle", key: ["hit"], keysecondary: [], constant: false, selective: true, disable: false,
        order: 100 - raw.uid, content: `CONTENT_${raw.uid}`, position: 1, probability: 100, useProbability: true, ...raw };
      const [decorators, content] = runInContext("parseDecorators", vm)(base.content);
      const value = { ...base, decorators, content }; normalized.push({ ...value, hash: runInContext("getStringHash", vm)(JSON.stringify(value)) });
    }
    if (fixture.timer) metadata.timedWorldInfo = { sticky: {}, cooldown: {}, [fixture.timer]: { "oracle.0": {
      hash: normalized[0].hash, start: 1, end: 1 + Number(normalized[0][fixture.timer]), protected: false } } };
    const productMetadata = structuredClone(metadata), productEntries = structuredClone(normalized), productPhases: any[] = [], productDraws: number[] = [];
    const messages = fixture.messages ?? ["hit"], maxContext = 2000;
    vm.world_info_budget = 50;
    const scanData = fixture.globalScanData ?? { trigger: fixture.trigger ?? "normal" };
    const original = await runInContext("checkWorldInfo", vm)(messages, maxContext, fixture.dryRun ?? false, scanData);
    const runtime = createWorldInfoRuntime({ entries: productEntries, metadata: productMetadata, settings, context,
      budget: 1000, characterFilename: "Char", characterTagKey: "character", random: () => { productDraws.push(fixture.roll ?? .2); return fixture.roll ?? .2; },
      countTokens: estimateTokens, substitute: (text: string) => text, onScan: (args: any) => productPhases.push({ ...args.state }) });
    const product = runtime.scan(messages, maxContext, fixture.dryRun ?? false, scanData);
    const originalSelected = [...original.allActivatedEntries].map((entry: any) => entry.uid), productSelected = [...product.activated.values()].map((entry: any) => entry.uid);
    if (fixture.repair) { expect(originalSelected).toEqual([1, 2]); expect(productSelected).toEqual([1, 2, 3]); }
    else if (fixture.injectionRepair) { expect(originalSelected).toEqual([]); expect(productSelected).toEqual([0]);
      expect(productMetadata).toEqual(metadata); expect(productDraws).toEqual(draws); expect(productPhases).toEqual(phases); }
    else { expect(productSelected, fixture.name).toEqual(originalSelected); expect(productMetadata, fixture.name).toEqual(metadata);
      expect(productDraws, fixture.name).toEqual(draws); expect(productPhases, fixture.name).toEqual(phases); }
    const beforeEntries = fixture.entries.map(raw => entry(raw.uid, { ...raw, world: "oracle" }, {
      keys: raw.key ?? ["hit"], secondaryKeys: raw.keysecondary ?? [], constant: raw.constant ?? false,
      content: raw.content ?? `CONTENT_${raw.uid}`, insertionOrder: raw.order ?? 100 - raw.uid,
    }));
    const adapterOutlets = fixture.entries.some(raw => raw.position === 7) ? getWorldInfoOutletEntries(matchLorebookEntries(characterId,
      beforeEntries, "Char", "", 1000, { messages, recursive: settings.world_info_recursive, preservePriority: true })) : undefined;
    if (adapterOutlets) expect(adapterOutlets).toEqual(JSON.parse(JSON.stringify(original.outletEntries)));
    const beforeSelected = beforeMatch ? selected(beforeMatch(characterId, beforeEntries, "Char", "", 1000, {
      messages, scanDepth: settings.world_info_depth, minActivations: settings.world_info_min_activations,
      minActivationsDepthMax: settings.world_info_min_activations_depth_max, recursive: settings.world_info_recursive,
      maxRecursionSteps: settings.world_info_max_recursion_steps, useGroupScoring: settings.world_info_use_group_scoring,
      dryRun: fixture.dryRun ?? false, trigger: fixture.trigger ?? "normal", characterFilename: "Char", random: () => fixture.roll ?? .2,
      ...(fixture.injection ? { extensionScanText: fixture.injection } : {}),
    })) : undefined;
    evidence.push({ name: fixture.name, input: fixture, originalSelected, productSelected, beforeSelected, originalDraws: draws, productDraws,
      originalPhases: phases, productPhases, originalMetadata: metadata, productMetadata, intentionalRepair: fixture.repair || fixture.injectionRepair || false,
      ...(fixture.injectionRepair ? { adaptation: "Native explicit scan source remains eligible at zero chat depth; pristine upstream returns an empty buffer before injection assembly." } : {}) });
    if (adapterOutlets) Object.assign(evidence.at(-1), { originalOutlets: original.outletEntries, adapterOutlets });
  }
  const reportDirectory = resolve(".cache/reports"); mkdirSync(reportDirectory, { recursive: true });
  const report = process.env.MYCOMPANION_WORLD_INFO_ORACLE_REPORT ?? join(reportDirectory, "w01-upstream-world-info-oracle-20261003.json");
  writeFileSync(report, JSON.stringify({ passed: true, commit: "7e8663cd9c184a550b37238218bdd32c6efc68e9", worldSourceSha256: sha(world), utilsSourceSha256: sha(utils),
    ...(beforeSha256 ? { beforeSourceSha256: beforeSha256 } : {}),
    declarations: names.map(name => ({ name, sha256: sha(declaration(world, name)) })), comparisons: evidence }, null, 2));
});
