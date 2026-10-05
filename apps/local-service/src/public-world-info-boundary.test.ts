import { expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createTestCharacter } from "./testing/native-character.js";
import { apps } from "./testing/helpers.js";
import { countCompatibilityMessagesSync } from "./tokens/tokenizer-service.js";
import { CONTEXT_RESERVE_TOKENS } from "./prompt/prompt-budget.js";

// 原生 prompt-preview 不再接受调用方直接供给的世界书文本（那是已删除的
// extension-prompt-assembly 兼容接口的能力）。这里的边界是：预览/组装不得
// 执行未被请求的世界书条目或 scan-only 扩展提示词。
for (const experimental of [false, true]) {
  it(`keeps unrequested world info and scan-only extension prompts out of prompt preview (experimental=${experimental})`, async () => {
    const app = buildApp(); apps.push(app);
    const character = await createTestCharacter(app, {
      ch_name: "Public WI boundary", description: "CARD_ANCHOR", first_mes: "Hello",
    });
    const story = (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } })).json();
    await app.inject({ method: "PUT", url: "/api/settings/provider", payload: {
      kind: "ollama", baseUrl: "http://provider.test/v1", model: "gpt-4o", maxTokens: 128, contextLimitTokens: 4096,
    } });
    await app.inject({ method: "PUT", url: "/api/extensions/settings", payload: {
      extensionSettings: { __mycompanion_power_user: { experimental_macro_engine: experimental } },
    } });
    const book = await app.inject({ method: "POST", url: "/api/worldinfo/edit", payload: {
      name: "public-wi-boundary", data: { entries: {
        1: { uid: 1, constant: true, key: [], content: "UNREQUESTED_WORLD={{incvar::worldReads}}/{{incglobalvar::worldGlobals}}", position: 1 },
      } },
    } });
    expect(book.statusCode, book.body).toBe(200);
    const worldSettings = (await app.inject({ method: "GET", url: "/api/worldinfo/settings" })).json();
    const selected = await app.inject({ method: "PUT", url: "/api/worldinfo/settings", payload: {
      ...worldSettings, world_info: { globalSelect: ["public-wi-boundary"], charLore: [] },
    } });
    expect(selected.statusCode, selected.body).toBe(200);
    const chat = async () => (await app.inject({ method: "GET", url: `/api/conversations/${story.id}` })).json();
    const settings = async () => (await app.inject({ method: "GET", url: "/api/extensions/settings" })).json().extensionSettings;
    const before = await chat(), initialSettings = await settings();
    // A positive control proves this selected constant entry is executable.
    // Scanning is a separate public call; the read-only preview is not assembly input.
    const scan = await app.inject({ method: "POST", url: "/api/worldinfo/prompt", payload: {
      chat: [], maxContext: 4096, characterId: character.id, conversationId: story.id, commitVariables: false,
    } });
    expect(scan.statusCode, scan.body).toBe(200);
    expect(scan.json().report.block).toBe("UNREQUESTED_WORLD=1/1");
    expect(await chat()).toEqual(before);
    expect(await settings()).toEqual(initialSettings);

    const preview = await app.inject({ method: "POST", url: `/api/conversations/${story.id}/prompt-preview`, payload: {
      draft: "input",
      extensionPrompts: [{ key: "scan-only", value: "UNREQUESTED_SCAN={{incvar::scanOnly}}", position: -1, scan: true, depth: 0, role: 0 }],
    } });
    expect(preview.statusCode, preview.body).toBe(200);
    const report = preview.json(), text = report.messages.map((message: { content: string }) => message.content).join("\n");
    // 原生预览与真实生成一致：选中的常驻世界书会被注入并求值。
    expect.soft(text).toContain("UNREQUESTED_WORLD=");
    // scan-only 扩展提示词只应在明确要求扫描的入口求值，不进预览正文。
    expect.soft(text).not.toContain("UNREQUESTED_SCAN");
    expect.soft(text).toContain("CARD_ANCHOR");
    const worldTokens = report.regions.filter((region: { key: string }) => ["worldbook", "worldbook_constant"].includes(region.key))
      .reduce((sum: number, region: { tokens: number }) => sum + region.tokens, 0);
    expect.soft(worldTokens > 0).toBe(true);
    expect.soft(report.totalTokens).toBe(countCompatibilityMessagesSync(report.messages, "gpt-4o", true) + 128 + CONTEXT_RESERVE_TOKENS);
    expect.soft(await chat()).toEqual(before);
    expect.soft(await settings()).toEqual(initialSettings);
  });
}
