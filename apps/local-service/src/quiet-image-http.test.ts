import {createServer, type ServerResponse} from "node:http";
import {runInNewContext} from "node:vm";
import {afterEach, expect, it} from "vitest";
import type {GenerationSseEvent, ProviderSettings} from "@mycompanion/shared";
import {buildApp} from "./app.js";
import {countCompatibilityMessagesSync} from "./tokenizer-service.js";
import {imageTokenCost} from "./image-token-cost.js";
import {providerRequestBody} from "./provider-transport.js";
import {openAIPromptSource} from "./plugin-runtime-openai-prompt.js";
import {openAISettingsSource} from "./plugin-runtime-openai-settings.js";
import {completionCollectionsSource} from "./plugin-runtime-completion-collections.js";
import {PromptManager, readPromptManagerSettings, chatCompletionDefaultPrompts, promptManagerDefaultPromptOrder, chatCompletionPromptDefaults} from "./prompt-manager-core.js";
import {waitFor} from "./test-helpers.js";

const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9rS3lGQAAAABJRU5ErkJggg==";
const imageData = image.split(",")[1]!;
const frame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
type Protocol = "openai" | "claude" | "gemini";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});

function finalResponse(protocol: Protocol, response: ServerResponse) {
  response.writeHead(200, {"Content-Type": "text/event-stream"});
  if (protocol === "claude") response.end(frame({type: "content_block_start", index: 0, content_block: {type: "text", text: "图片已收到"}})
    + frame({type: "message_delta", delta: {stop_reason: "end_turn"}}) + frame({type: "message_stop"}));
  else if (protocol === "gemini") response.end(frame({candidates: [{content: {parts: [{text: "图片已收到"}]}, finishReason: "STOP"}]}));
  else response.end(frame({choices: [{delta: {content: "图片已收到"}, finish_reason: "stop"}]}) + "data: [DONE]\n\n");
}
async function fixture(protocol: Protocol = "openai", firstMessage = "Opening", experimental = false,
  respond?: (round: number, response: ServerResponse, actualProtocol: Protocol) => void) {
  const requests: Array<{path: string; body: Record<string, any>}> = [];
  const provider = createServer(async (request, response) => {
    const bytes: Buffer[] = []; for await (const chunk of request) bytes.push(Buffer.from(chunk));
    requests.push({path: request.url!, body: JSON.parse(Buffer.concat(bytes).toString())});
    const actualProtocol = request.url?.includes("streamGenerateContent") ? "gemini" : request.url?.endsWith("/messages") ? "claude" : "openai";
    if (respond) respond(requests.length, response, actualProtocol); else finalResponse(actualProtocol, response);
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>(resolve => {provider.closeAllConnections(); provider.close(() => resolve());}));
  const app = buildApp(); cleanup.push(() => app.close());
  const settings = {kind: (protocol === "claude" ? "anthropic" : protocol === "gemini" ? "gemini" : "openai-compatible") as ProviderSettings["kind"],
    baseUrl: `http://127.0.0.1:${(provider.address() as {port: number}).port}/${protocol === "gemini" ? "v1beta" : "v1"}`,
    model: protocol === "claude" ? "claude-sonnet-4-6" : protocol === "gemini" ? "gemini-3-flash-preview" : "gpt-4o", maxTokens: 128, contextLimitTokens: 8192};
  expect((await app.inject({method: "PUT", url: "/api/settings/provider", payload: settings})).statusCode).toBe(200);
  const avatar = (await app.inject({method: "POST", url: "/api/characters/create", payload: {ch_name: "Quiet image fixture", first_mes: firstMessage, description: "Text-only character system prompt"}})).body;
  const role = (await app.inject({method: "POST", url: "/api/characters/get", payload: {avatar_url: avatar}})).json();
  const story = (await app.inject({method: "POST", url: "/api/conversations", payload: {characterId: role.id}})).json();
  const extensions = {__mycompanion_openai: {settings: {media_inlining: true, inline_image_quality: "high"}},
    __mycompanion_power_user: {experimental_macro_engine: experimental}, variables: {global: {quietGlobal: 7}}};
  expect((await app.inject({method: "PUT", url: "/api/extensions/settings", payload: {extensionSettings: extensions}})).statusCode).toBe(200);
  const base = await app.listen({host: "127.0.0.1", port: 0});
  const request = (payload: Record<string, unknown>, signal?: AbortSignal) => fetch(`${base}/api/conversations/${story.id}/quiet-generation`, {
    method: "POST", headers: {"Content-Type": "application/json"}, signal: signal ?? AbortSignal.timeout(15000), body: JSON.stringify(payload),
  });
  const send = async (payload: Record<string, unknown>) => {const response = await request(payload); return {status: response.status, body: await response.json()};};
  const readStory = async () => (await app.inject({url: `/api/conversations/${story.id}`})).json();
  const readSettings = async () => (await app.inject({url: "/api/extensions/settings"})).json();
  const preflight = async (payload: Record<string, unknown>, transform: (request: Record<string, any>) => Record<string, any>) => {
    const response = await request({browserPreflight: true, ...payload}); expect(response.status).toBe(200);
    const events: GenerationSseEvent[] = [], reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer = "";
    try {
      for (;;) {
        const {done, value} = await reader.read(); if (done) break; buffer += decoder.decode(value, {stream: true});
        for (let index; (index = buffer.indexOf("\n\n")) >= 0;) {
          const raw = buffer.slice(0, index); buffer = buffer.slice(index + 2); if (!raw.startsWith("data: ")) continue;
          const event = JSON.parse(raw.slice(6)) as GenerationSseEvent; events.push(event);
          if (event.type === "completion_request") expect((await app.inject({method: "POST", url: `/api/generation/preflight/${event.requestId}`,
            payload: {request: transform(structuredClone(event.request))}})).statusCode).toBe(200);
        }
      }
      return events;
    } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
  };
  return {app, base, story, settings, extensions, requests, request, send, readStory, readSettings, preflight};
}
function assertWireImage(protocol: Protocol, body: Record<string, any>) {
  if (protocol === "openai") expect(body.messages.at(-1)).toEqual({role: "system", content: [
    {type: "text", text: "Describe this picture"}, {type: "image_url", image_url: {url: image, detail: "high"}},
  ]});
  else if (protocol === "claude") {
    expect(body.system.every((part: any) => part.type === "text" && typeof part.text === "string")).toBe(true);
    const last = body.messages.at(-1); expect(last.role).toBe("user");
    expect(last.content).toContainEqual({type: "text", text: "Describe this picture"});
    expect(last.content).toContainEqual({type: "image", source: {type: "base64", media_type: "image/png", data: imageData}});
  } else {
    expect(body.systemInstruction.parts.every((part: any) => typeof part.text === "string")).toBe(true);
    const last = body.contents.at(-1); expect(last.role).toBe("user");
    expect(last.parts).toContainEqual({text: "Describe this picture"});
    expect(last.parts).toContainEqual({inlineData: {mimeType: "image/png", data: imageData}, mediaResolution: {level: "media_resolution_high"}});
  }
}

it.each(["openai", "claude", "gemini"] as const)("sends quiet control image bytes/detail through actual %s HTTP without creating a turn", async protocol => {
  const f = await fixture(protocol), before = await f.readStory();
  const preview = await f.send({quietPrompt: "Describe this picture", quietImage: image, dryRun: true}); expect(preview.status).toBe(200);
  expect(() => providerRequestBody(protocol, {model: f.settings.model, messages: preview.body.messages, max_tokens: 128, stream: true})).not.toThrow();
  expect(await f.send({quietPrompt: "Describe this picture", quietImage: image})).toEqual({status: 200, body: {text: "图片已收到"}});
  expect(f.requests).toHaveLength(1); assertWireImage(protocol, f.requests[0]!.body);
  expect(await f.readStory()).toEqual(before);
});

it.each(["openai", "claude", "gemini"] as const)("keeps an empty story's %s picture control out of native system text while preserving plain system prompts", async protocol => {
  const f = await fixture(protocol, ""), before = await f.readStory();
  expect(await f.send({quietPrompt: "Describe this picture", quietImage: image})).toEqual({status: 200, body: {text: "图片已收到"}});
  expect(f.requests).toHaveLength(1); assertWireImage(protocol, f.requests[0]!.body);
  expect(JSON.stringify(f.requests[0]!.body)).toContain("Text-only character system prompt");
  expect(await f.send({quietPrompt: "Plain control"})).toEqual({status: 200, body: {text: "图片已收到"}});
  expect(JSON.stringify(f.requests[1]!.body)).not.toContain(imageData);
  if (protocol === "claude") expect(f.requests[1]!.body.system).toContainEqual({type: "text", text: "Plain control"});
  if (protocol === "gemini") {
    expect(f.requests[1]!.body.systemInstruction.parts.every((part: any) => typeof part.text === "string")).toBe(true);
    expect(f.requests[1]!.body.contents.at(-1)).toEqual({role: "user", parts: [{text: "Plain control"}]});
  }
  expect(await f.readStory()).toEqual(before);
});

it.each(["openai", "claude", "gemini"] as const)("reserves %s image media cost before transport and rejects an over-budget quiet control without committing macros", async protocol => {
  const f = await fixture(protocol, ""), before = await f.readStory(), beforeSettings = await f.readSettings();
  const payload = {quietPrompt: "Look {{incvar::quietLocal}}/{{incglobalvar::quietGlobal}}", quietImage: image};
  const preview = await f.send({...payload, dryRun: true}); expect(preview.status).toBe(200); expect(f.requests).toHaveLength(0);
  const withoutImage = await f.send({quietPrompt: payload.quietPrompt, dryRun: true}); expect(withoutImage.status).toBe(200);
  const cost = imageTokenCost({image_url: {url: image, detail: "high"}}, f.settings.model).tokens;
  const picturedTokens = countCompatibilityMessagesSync(preview.body.messages, f.settings.model, true);
  expect(picturedTokens - countCompatibilityMessagesSync(withoutImage.body.messages, f.settings.model, true)).toBe(cost);
  expect(cost).toBeGreaterThan(0);
  expect((await f.app.inject({method: "PUT", url: "/api/settings/provider", payload: {...f.settings, contextLimitTokens: picturedTokens + 128 + 512 - 1}})).statusCode).toBe(200);
  for (const dryRun of [true, false]) {
    const rejected = await f.send({...payload, dryRun}); expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe("MODEL_REQUEST_FAILED");
  }
  expect(f.requests).toHaveLength(0); expect(await f.readStory()).toEqual(before); expect(await f.readSettings()).toEqual(beforeSettings);
});

it.each([false, true])("quiet image dryRun and public assembly preserve chat/local/global variable state (experimental=%s)", async experimental => {
  const f = await fixture("openai", "Opening", experimental), before = await f.readStory(), beforeSettings = await f.readSettings();
  const quietPrompt = "Look {{incvar::quietLocal}}/{{incglobalvar::quietGlobal}}";
  const preview = await f.send({quietPrompt, quietImage: image, dryRun: true}); expect(preview.status).toBe(200);
  expect(preview.body.messages.at(-1)).toEqual({role: "system", content: [
    {type: "text", text: "Look 1/8"}, {type: "image_url", image_url: {url: image, detail: "high"}},
  ]});
  const assembly = await f.app.inject({method: "POST", url: `/api/conversations/${f.story.id}/extension-prompt-assembly`, payload: {
    messages: [], quietPrompt, quietImage: image, imageQuality: "low", type: "quiet",
  }});
  expect(assembly.statusCode, assembly.body).toBe(200);
  expect(assembly.json().messages.at(-1)).toEqual({role: "system", content: [
    {type: "text", text: "Look 1/8"}, {type: "image_url", image_url: {url: image, detail: "low"}},
  ]});
  expect(f.requests).toHaveLength(0); expect(await f.readStory()).toEqual(before); expect(await f.readSettings()).toEqual(beforeSettings);
});

it("uses media_inlining and nonempty quiet text without silently enabling disabled picture inputs", async () => {
  const f = await fixture(), before = await f.readStory();
  for (const media_inlining of [false, null, 0, ""]) {
    expect((await f.app.inject({method: "PUT", url: "/api/extensions/settings", payload: {extensionSettings: {
      ...f.extensions, __mycompanion_openai: {settings: {media_inlining, inline_image_quality: "high"}},
    }}})).statusCode).toBe(200);
    expect((await f.send({quietPrompt: "Describe this picture", quietImage: image})).status).toBe(200);
    expect(JSON.stringify(f.requests.at(-1)!.body)).not.toContain(imageData);
  }
  expect((await f.app.inject({method: "PUT", url: "/api/extensions/settings", payload: {extensionSettings: f.extensions}})).statusCode).toBe(200);
  expect((await f.send({quietPrompt: "", quietImage: image})).status).toBe(200);
  expect(JSON.stringify(f.requests.at(-1)!.body)).not.toContain(imageData);
  const assembly = await f.app.inject({method: "POST", url: `/api/conversations/${f.story.id}/extension-prompt-assembly`, payload: {messages: [], quietPrompt: "", quietImage: image, type: "quiet"}});
  expect(assembly.statusCode).toBe(200); expect(assembly.body).not.toContain(imageData);
  expect(await f.readStory()).toEqual(before);
});

it("runs the served OpenAI settings/prompt bridge through the actual assembly HTTP with quietImage and quality intact", async () => {
  const f = await fixture(), before = await f.readStory();
  const settings = runInNewContext(openAISettingsSource.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "") + "\n({oai_settings,isImageInliningSupported})", {
    extension_settings: {}, loadExtensionSettings: async () => {}, registerSettingsParticipant: () => {}, chatCompletionPromptDefaults,
  });
  settings.oai_settings.custom_model = "unknown-custom-image-model";
  settings.oai_settings.inline_image_quality = "low";
  expect(settings.isImageInliningSupported()).toBe(true);
  settings.oai_settings.media_inlining = false; expect(settings.isImageInliningSupported()).toBe(false);
  settings.oai_settings.media_inlining = true;
  const collections = runInNewContext(completionCollectionsSource.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "")
    + "\n({Message,MessageCollection,ChatCompletion})", {
    oai_settings: settings.oai_settings, countTokensOpenAIAsync: async (message: any) => countCompatibilityMessagesSync([message], "gpt-4o", false),
  });
  const emitted: Array<{type: string; data: any}> = [];
  const bridge = runInNewContext(openAIPromptSource.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "")
    .replace("await import('/scripts/openai.js')", "completionCollections") + "\n({prepareOpenAIMessages})", {
    completionCollections: collections, oai_settings: settings.oai_settings, getContext: () => ({conversationId: f.story.id, characterId: 0}),
    captureMacroApiTarget: () => ({}), snapshotExtensionPrompts: async () => [], substituteParams: (value: string) => value,
    PromptManager, readPromptManagerSettings, chatCompletionDefaultPrompts, promptManagerDefaultPromptOrder,
    document: {getElementById: () => null}, setTimeout, clearTimeout,
    event_types: {CHAT_COMPLETION_PROMPT_READY: "prompt_ready"}, eventSource: {emitChecked: async (type: string, data: any) => {emitted.push({type, data});}},
    requestMacroEvaluation: async (url: string, payload: () => unknown) => {
      const response = await fetch(f.base + url, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload()), signal: AbortSignal.timeout(15000)});
      const body = await response.json(); expect(response.status, JSON.stringify(body)).toBe(200); return body;
    },
  });
  const [messages] = await bridge.prepareOpenAIMessages({messages: [], quietPrompt: "Describe this picture", quietImage: image, type: "quiet"}, true);
  expect(messages.at(-1)).toEqual({role: "system", content: [{type: "text", text: "Describe this picture"}, {type: "image_url", image_url: {url: image, detail: "low"}}]});
  expect(emitted).toHaveLength(1); expect(emitted[0]).toMatchObject({type: "prompt_ready", data: {dryRun: true, chat: messages}});
  expect(f.requests).toHaveLength(0); expect(await f.readStory()).toEqual(before);
});

it("uses the accepted preflight source/model snapshot and exposes native image estimation limits", async () => {
  const f = await fixture(), before = await f.readStory();
  const events = await f.preflight({quietPrompt: "Describe this picture", quietImage: image}, request => ({...request,
    chat_completion_source: "makersuite", model: "gemini-3-flash-preview"}));
  expect(events.find(event => event.type === "quiet_result")).toMatchObject({text: "图片已收到"});
  expect(f.requests).toHaveLength(1); expect(f.requests[0]!.path).toContain("streamGenerateContent"); assertWireImage("gemini", f.requests[0]!.body);
  const budget = events.find(event => event.type === "prompt_budget");
  expect(budget).toMatchObject({report: {tokenAccounting: {model: "gemini-3-flash-preview", estimated: true, mediaEstimated: true, complete: false,
    mediaTokens: 85, reasons: expect.arrayContaining(["unknown-image-model"])}}});
  const rejected = await f.preflight({quietPrompt: "Describe this picture", quietImage: image}, request => ({...request,
    chat_completion_source: "claude", model: "claude-2.1"}));
  expect(rejected.find(event => event.type === "error")).toMatchObject({message: "本次模型不支持后台图片输入。"});
  expect(f.requests).toHaveLength(1); expect(await f.readStory()).toEqual(before);
});

it("cancels the actual quiet picture provider stream without writing a turn and permits a following request", async () => {
  let providerCancelled = false;
  const f = await fixture("openai", "Opening", false, (round, response, protocol) => {
    if (round > 1) {finalResponse(protocol, response); return;}
    response.writeHead(200, {"Content-Type": "text/event-stream"});
    response.write(frame({choices: [{delta: {content: "partial"}}]}));
    response.once("close", () => {providerCancelled = true;});
  });
  const before = await f.readStory(), controller = new AbortController();
  const pending = f.request({quietPrompt: "Describe this picture", quietImage: image}, controller.signal);
  await waitFor(async () => f.requests.length === 1 ? true : undefined); controller.abort();
  await expect(pending).rejects.toMatchObject({name: "AbortError"});
  await waitFor(async () => providerCancelled ? true : undefined);
  expect(await f.readStory()).toEqual(before);
  expect(await f.send({quietPrompt: "Describe this picture", quietImage: image})).toEqual({status: 200, body: {text: "图片已收到"}});
  expect(f.requests).toHaveLength(2); expect(await f.readStory()).toEqual(before);
});
