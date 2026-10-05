import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ConversationSummary, MemoryRecord, ProviderSettings } from "@mycompanion/shared";
import i18n from "../i18n";
import { SettingsView, type SettingsViewProps } from "./SettingsView";
import { MemoryView } from "./MemoryView";
import { useConversations } from "../hooks/useConversations";
import { useChatGeneration } from "../hooks/useChatGeneration";
import * as api from "../api";

// 回归：用户报的 8 个缺陷里，属于渲染层的 #6 / #7 / #8。

vi.mock("./PresetSettings", () => ({ PresetSettings: () => <p>p</p> }));
vi.mock("./BackupPanel", () => ({ BackupPanel: () => <p>b</p> }));
afterEach(async () => { cleanup(); vi.restoreAllMocks(); await i18n.changeLanguage("zh"); });

// #6 获取模型期间切换服务商：旧响应不能覆盖新服务，也不能把新服务标成已连接。
it("ignores a model list that arrives after the user switched provider", async () => {
  let release: ((value: { ok: boolean; models: string[]; message: string }) => void) | undefined;
  const pendingResult = new Promise<{ ok: boolean; models: string[]; message: string }>(resolve => { release = resolve; });
  vi.spyOn(api, "listProviderModels").mockReturnValue(pendingResult);

  const onConnectionReady = vi.fn();
  const start: ProviderSettings = { kind: "openai-compatible", baseUrl: "https://old.test/v1", model: "old-model", hasApiKey: true, temperature: 0.8, maxTokens: 1024, contextLimitTokens: 32768 };
  function Parent() {
    const [provider, setProvider] = useState(start);
    return <SettingsView
      provider={provider} apiKeyDraft="" isSavingProvider={false} runtimeError={null} providerNotice={null}
      onProviderField={(patch) => setProvider(current => ({ ...current, ...patch }))}
      onApiKeyDraft={vi.fn()} onSave={vi.fn()} onSaveAndTest={vi.fn()} onConnectionReady={onConnectionReady}
    />;
  }
  render(<Parent />);

  fireEvent.click(screen.getByRole("button", { name: "测试获取模型" }));
  // 等待期间换成 DeepSeek，然后才让旧请求返回。
  fireEvent.change(screen.getByRole("combobox", { name: "模型来源" }), { target: { value: "deepseek" } });
  await act(async () => { release?.({ ok: true, models: ["stale-model-from-old-service"], message: "读取到 1 个模型。" }); });

  // 旧服务的模型不能落到新服务上，也不能因此把新服务标成已连接。
  expect((document.getElementById("provider-model") as HTMLInputElement).value).toBe("deepseek-flash");
  expect(screen.queryByRole("combobox", { name: "模型名称" })).toBeNull();
  expect(onConnectionReady).not.toHaveBeenCalled();
});

// #7 保存失败不能关闭编辑器，否则用户刚输入的内容丢失。
it("keeps the memory editor open with the typed content when saving fails", async () => {
  const memory: MemoryRecord = {
    id: "11111111-1111-4111-8111-111111111111", conversationId: "22222222-2222-4222-8222-222222222222",
    characterId: "33333333-3333-4333-8333-333333333333", type: "fact", content: "原文", scope: "story",
    importance: 3, status: "active", pinned: false, sourceMessageIds: [], supersededBy: null,
    previousContent: null, createdAt: "2026-10-03T00:00:00.000Z", lastUsedAt: null,
  };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    items: [{ memory, conversationId: memory.conversationId, conversationTitle: "《道渊》" }], total: 1,
  }), { status: 200, headers: { "Content-Type": "application/json" } })));
  vi.spyOn(api, "updateMemory").mockRejectedValue(new Error("boom"));

  render(<MemoryView online onOpenSource={vi.fn()} />);
  await screen.findByText("原文");
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  const editor = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(editor, { target: { value: "我改过的内容" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));

  // 保存失败：编辑器必须还在，且保留刚输入的内容，同时给出错误提示。
  expect(await screen.findByText("无法更新记忆，请重试。")).toBeInTheDocument();
  expect(screen.getByRole("textbox")).toHaveValue("我改过的内容");
});

// #3 获取模型期间换服务商：按钮必须释放，不能永久卡在"正在获取模型"。
it("releases the fetch button after switching provider mid-request", async () => {
  let release: ((value: { ok: boolean; models: string[]; message: string }) => void) | undefined;
  vi.spyOn(api, "listProviderModels").mockReturnValue(new Promise(resolve => { release = resolve; }));
  const start: ProviderSettings = { kind: "openai-compatible", baseUrl: "https://old.test/v1", model: "old-model", hasApiKey: true, temperature: 0.8, maxTokens: 1024, contextLimitTokens: 32768 };
  function Parent() {
    const [provider, setProvider] = useState(start);
    return <SettingsView
      provider={provider} apiKeyDraft="" isSavingProvider={false} runtimeError={null} providerNotice={null}
      onProviderField={(patch) => setProvider(current => ({ ...current, ...patch }))}
      onApiKeyDraft={vi.fn()} onSave={vi.fn()} onSaveAndTest={vi.fn()}
    />;
  }
  render(<Parent />);

  fireEvent.click(screen.getByRole("button", { name: "测试获取模型" }));
  expect(screen.getByRole("button", { name: "正在获取模型…" })).toBeDisabled();
  fireEvent.change(screen.getByRole("combobox", { name: "模型来源" }), { target: { value: "deepseek" } });
  await act(async () => { release?.({ ok: true, models: ["stale"], message: "读取到 1 个模型。" }); });

  // 关键：按钮回到可点击状态（以前会永久 disabled，用户无法重试）。
  const retry = await screen.findByRole("button", { name: "测试获取模型" });
  expect(retry).not.toBeDisabled();
});

// #4 获取模型期间手改地址：旧响应不能落到新配置上。
it("ignores a model list that arrives after the address was edited", async () => {
  let release: ((value: { ok: boolean; models: string[]; message: string }) => void) | undefined;
  vi.spyOn(api, "listProviderModels").mockReturnValue(new Promise(resolve => { release = resolve; }));
  const onConnectionReady = vi.fn();
  const start: ProviderSettings = { kind: "openai-compatible", baseUrl: "https://old.test/v1", model: "old-model", hasApiKey: true, temperature: 0.8, maxTokens: 1024, contextLimitTokens: 32768 };
  function Parent() {
    const [provider, setProvider] = useState(start);
    return <SettingsView
      provider={provider} apiKeyDraft="" isSavingProvider={false} runtimeError={null} providerNotice={null}
      onProviderField={(patch) => setProvider(current => ({ ...current, ...patch }))}
      onApiKeyDraft={vi.fn()} onSave={vi.fn()} onSaveAndTest={vi.fn()} onConnectionReady={onConnectionReady}
    />;
  }
  render(<Parent />);

  fireEvent.click(screen.getByRole("button", { name: "测试获取模型" }));
  // 服务商没换，但地址被手动改了 —— 旧响应同样不该生效。
  fireEvent.change(document.getElementById("provider-base-url") as HTMLInputElement, { target: { value: "https://new.test/v1" } });
  await act(async () => { release?.({ ok: true, models: ["stale-model"], message: "读取到 1 个模型。" }); });

  // 没有下拉说明模型列表没被写入，也不能因为旧响应把新地址标成已连接。
  expect(screen.queryByRole("combobox", { name: "模型名称" })).toBeNull();
  expect(onConnectionReady).not.toHaveBeenCalled();
});

// #1 发送失败要把草稿还给用户。
it("restores the draft into the composer when sending fails before acceptance", async () => {
  vi.spyOn(api, "streamChatMessage").mockRejectedValue(new TypeError("fetch failed"));
  const conversation = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "甲", characterName: "A", characterId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", activeBranchId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", messages: [], branches: [] };
  const setRuntimeError = vi.fn();
  let composer = "";
  function Harness() {
    const generation = useChatGeneration({
      initialInput: "",
      activeConversation: conversation as never,
      setConversations: vi.fn(),
      setActiveConversation: vi.fn(),
      setRuntimeError,
      providerModel: "test-model",
      setLastMemoryReport: vi.fn(),
      setLastLorebookReport: vi.fn(),
      setLastPromptBudget: vi.fn(),
    });
    composer = generation.chatInput;
    return <div>
      <span data-testid="composer">{generation.chatInput}</span>
      <button type="button" onClick={() => void generation.handleSendMessage("这句话不能丢")}>发送</button>
    </div>;
  }
  render(<Harness />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "发送" })); });

  // 请求没被接收：输入框必须拿回刚打的内容。
  await waitFor(() => expect(screen.getByTestId("composer").textContent).toBe("这句话不能丢"));
  expect(composer).toBe("这句话不能丢");
  expect(setRuntimeError).toHaveBeenCalled();
});

// #1b 切到别的故事后发送失败：原故事的**持久化草稿**也必须留住。
// 发送时 setChatInput("") 会把原故事的空草稿写进存储，只有按原故事 id 写回才不丢。
it("keeps the draft of the original story when the send fails after switching away", async () => {
  const firstId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const secondId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const story = (id: string) => ({ id, title: id, characterName: "A", characterId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", activeBranchId: id, messages: [], branches: [] });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    // 草稿存储：读得到、写得进。
    if (url.includes("/api/extensions/settings")) {
      return new Response(JSON.stringify({ extensionSettings: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  // 让发送挂住，以便在"发送中"切走。
  let failSend: (() => void) | undefined;
  vi.spyOn(api, "streamChatMessage").mockImplementation(() => new Promise((_resolve, reject) => {
    failSend = () => reject(new TypeError("fetch failed"));
  }));

  const setRuntimeError = vi.fn();
  function Harness({ conversation }: { conversation: unknown }) {
    const generation = useChatGeneration({
      initialInput: "",
      activeConversation: conversation as never,
      setConversations: vi.fn(),
      setActiveConversation: vi.fn(),
      setRuntimeError,
      providerModel: "test-model",
      setLastMemoryReport: vi.fn(),
      setLastLorebookReport: vi.fn(),
      setLastPromptBudget: vi.fn(),
    });
    return <div>
      <span data-testid="composer">{generation.chatInput}</span>
      <button type="button" onClick={() => void generation.handleSendMessage("这句话属于甲")}>发送</button>
    </div>;
  }

  const { rerender } = render(<Harness conversation={story(firstId)} />);
  // 等草稿存储挂载完成（否则 write 无处可写）。
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  // 发送还没回来就切到乙。
  rerender(<Harness conversation={story(secondId)} />);
  await act(async () => { failSend?.(); await Promise.resolve(); });

  // 甲故事的持久化草稿必须还在（这是防止"切走后永久丢失"的关键）。
  const store = await (await import("../composer-drafts")).loadComposerDraftStore();
  expect(store.read(firstId)).toBe("这句话属于甲");
  // 而且不能污染当前正在看的乙。
  expect(screen.getByTestId("composer").textContent).toBe("");
});

// 发送时的清空是程序性动作：**不能**把用户草稿写进存储。否则发送被挂起期间一旦重渲染，
// 存储里那条就变成空串（失败时只能靠写回兜住，是个隐患）。
it("does not persist an empty draft when the composer is cleared for sending", async () => {
  const storyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const story = { id: storyId, title: "甲", characterName: "A", characterId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", activeBranchId: storyId, messages: [], branches: [] };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ extensionSettings: {}, items: [] }), { status: 200, headers: { "Content-Type": "application/json" } })));
  // 让发送一直挂住：期间发生重渲染，看存储会不会被清空。
  vi.spyOn(api, "streamChatMessage").mockImplementation(() => new Promise(() => {}));

  function Harness() {
    const [tick, setTick] = useState(0);
    const generation = useChatGeneration({
      initialInput: "",
      activeConversation: story as never,
      setConversations: vi.fn(),
      setActiveConversation: vi.fn(),
      setRuntimeError: vi.fn(),
      providerModel: "test-model",
      setLastMemoryReport: vi.fn(),
      setLastLorebookReport: vi.fn(),
      setLastPromptBudget: vi.fn(),
    });
    return <div>
      <span data-testid="composer">{generation.chatInput}</span>
      <button type="button" onClick={() => generation.setChatInput("用户打的草稿")}>输入</button>
      <button type="button" onClick={() => void generation.handleSendMessage()}>发送</button>
      <button type="button" onClick={() => setTick(tick + 1)}>触发重渲染</button>
    </div>;
  }

  render(<Harness />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const store = await (await import("../composer-drafts")).loadComposerDraftStore();

  fireEvent.click(screen.getByRole("button", { name: "输入" }));
  await waitFor(() => expect(store.read(storyId)).toBe("用户打的草稿"));

  // 发送（清空输入）后强制重渲染——以前这一步会把存储写成空串。
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "触发重渲染" })); });

  expect(screen.getByTestId("composer").textContent).toBe("");
  expect(store.read(storyId)).toBe("用户打的草稿");
});

// 发送成功后刷新列表失败：不能把已发送的内容退回输入框（否则用户会重复发送）。
it("does not restore a successfully sent message when only the list refresh fails", async () => {
  const storyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const story = { id: storyId, title: "甲", characterName: "A", characterId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", activeBranchId: storyId, messages: [], branches: [] };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    // 刷新故事列表失败；草稿存储照常可用。
    if (url.includes("/api/extensions/settings")) {
      return new Response(JSON.stringify({ extensionSettings: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/api/conversations")) {
      return new Response(JSON.stringify({ error: { code: "BOOM", message: "列表读取失败。" } }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  // 发送本身是成功的（模型正常回了内容）。
  vi.spyOn(api, "streamChatMessage").mockImplementation(async (_story, _content, _signal, onEvent) => {
    onEvent({ type: "user_message", message: { id: "m1", conversationId: storyId, branchId: storyId, parentMessageId: null, role: "user", content: "已经发出去的话", status: "complete", createdAt: "2026-10-03T00:00:00.000Z" } } as never);
    onEvent({ type: "done", message: { id: "m2", conversationId: storyId, branchId: storyId, parentMessageId: "m1", role: "assistant", content: "好的。", status: "complete", createdAt: "2026-10-03T00:00:00.000Z" } } as never);
  });

  const setRuntimeError = vi.fn();
  function Harness() {
    const generation = useChatGeneration({
      initialInput: "",
      activeConversation: story as never,
      setConversations: vi.fn(),
      setActiveConversation: vi.fn(),
      setRuntimeError,
      providerModel: "test-model",
      setLastMemoryReport: vi.fn(),
      setLastLorebookReport: vi.fn(),
      setLastPromptBudget: vi.fn(),
    });
    return <div>
      <span data-testid="composer">{generation.chatInput}</span>
      <button type="button" onClick={() => generation.setChatInput("已经发出去的话")}>输入</button>
      <button type="button" onClick={() => void generation.handleSendMessage()}>发送</button>
    </div>;
  }

  render(<Harness />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const store = await (await import("../composer-drafts")).loadComposerDraftStore();
  fireEvent.click(screen.getByRole("button", { name: "输入" }));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "发送" })); });

  // 关键：消息已经发出，输入框必须保持空（列表刷新失败不得让它退回输入框）。
  expect(screen.getByTestId("composer").textContent).toBe("");
  // 刷新失败应当作为列表错误呈现，而不是被当成"发送失败"。
  expect(setRuntimeError).toHaveBeenCalledWith("列表读取失败。");
});

// #5 记忆库里的变更必须走"归属故事"，而不是记忆自带的（可能已被删除的）故事。
it("routes memory edits and deletes through the owning story, not the deleted source story", async () => {
  const sourceStory = "22222222-2222-4222-8222-222222222222"; // 已被删除的来源故事
  const ownerStory = "99999999-9999-4999-8999-999999999999";  // 后端给出的归属故事
  const memory: MemoryRecord = {
    id: "11111111-1111-4111-8111-111111111111", conversationId: sourceStory,
    characterId: "33333333-3333-4333-8333-333333333333", type: "fact", content: "全局记忆", scope: "user",
    importance: 3, status: "active", pinned: false, sourceMessageIds: [], supersededBy: null,
    previousContent: null, createdAt: "2026-10-03T00:00:00.000Z", lastUsedAt: null,
  };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    items: [{ memory, conversationId: ownerStory, conversationTitle: "另一条故事" }], total: 1,
  }), { status: 200, headers: { "Content-Type": "application/json" } })));
  const updateSpy = vi.spyOn(api, "updateMemory").mockResolvedValue({ ...memory, pinned: true });
  const deleteSpy = vi.spyOn(api, "deleteMemory").mockResolvedValue(undefined);
  vi.spyOn(window, "confirm").mockReturnValue(true);

  render(<MemoryView online onOpenSource={vi.fn()} />);
  await screen.findByText("全局记忆");

  fireEvent.click(screen.getByRole("button", { name: "固定" }));
  await waitFor(() => expect(updateSpy).toHaveBeenCalled());
  // 关键：不能拿已删除的来源故事去调接口（那样后端按可见性校验会 404）。
  expect(updateSpy.mock.calls[0]![0]).toBe(ownerStory);
  expect(updateSpy.mock.calls[0]![0]).not.toBe(sourceStory);

  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  await waitFor(() => expect(deleteSpy).toHaveBeenCalled());
  expect(deleteSpy.mock.calls[0]![0]).toBe(ownerStory);
});

// #8 删除期间切到另一个故事，删除成功后已删项不能残留。
it("removes the deleted story from the sidebar even if the user navigated away during the request", async () => {
  const base = { characterId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", characterName: "A", lastMessagePreview: "", messageCount: 1, createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z" };
  const first: ConversationSummary = { ...base, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "甲", activeBranchId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
  const second: ConversationSummary = { ...base, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", title: "乙", activeBranchId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };

  let release: (() => void) | undefined;
  vi.spyOn(api, "deleteConversation").mockReturnValue(new Promise(resolve => { release = () => resolve({ id: first.id, deletedAt: "2026-10-03T00:00:00.000Z" }); }));

  const seen: ConversationSummary[][] = [];
  function Harness() {
    const state = useConversations({
      navigationRevision: { current: 0 },
      resumeConversationId: undefined,
      selectedCharacterId: undefined,
      setWorkspaceView: vi.fn(),
      setRuntimeError: vi.fn(),
    });
    // 记录列表快照，直接观察 hook 的结果。
    seen.push(state.conversations);
    return <div>
      <button type="button" onClick={() => { state.setConversations([first, second]); void state.handleDeleteConversation(first.id); }}>删除甲</button>
      <button type="button" onClick={() => { void state.handleOpenConversation(second.id); }}>切到乙</button>
      <ul>{state.conversations.map(item => <li key={item.id}>{item.title}</li>)}</ul>
    </div>;
  }
  vi.spyOn(api, "fetchConversation").mockResolvedValue({ ...second, messages: [], branches: [] } as never);

  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "删除甲" }));
  // 删除还在飞的时候切走（这会推进 navigationRevision，旧代码因此跳过了列表更新）。
  fireEvent.click(screen.getByRole("button", { name: "切到乙" }));
  await act(async () => { release?.(); });

  await waitFor(() => expect(screen.queryByText("甲")).toBeNull());
  expect(screen.getByText("乙")).toBeInTheDocument();
});
