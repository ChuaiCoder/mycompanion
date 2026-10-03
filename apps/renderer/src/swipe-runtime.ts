import { chatMessageStatusSchema, messageGenerationMetadataSchema, NATIVE_CANDIDATE_INFO_KEY, projectNativeCandidateMessage,
  type ExtensionChatMessage } from "@mycompanion/shared";

// 最后的兼容消费者：候选回复的“切换选择”仍依赖酒馆聊天运行时来持久化
// （原生 swipe 选择端点缺失；补齐端点后此模块应改为纯 REST）。
let hostPromise: Promise<unknown> | undefined;
function loadExtensionHost(): Promise<unknown> {
  return hostPromise ??= (async () => {
    const libraries = "/plugin-runtime/libraries.js";
    await import(/* @vite-ignore */ libraries);
    const path = "/plugin-runtime/desktop-host.js";
    return import(/* @vite-ignore */ path);
  })();
}

export interface SwipeTarget { conversationId: string; branchId: string; messageId: string }
interface SwipeContext { conversationId?: string; branchId?: string; chat: ExtensionChatMessage[]; chatMetadata: Record<string, unknown> }
export interface SwipeRuntime {
  getContext(): SwipeContext;
  flushChatSaves(): Promise<void>;
  saveMetadataDebounced(): void;
  saveChatConditional(): Promise<void>;
  reloadCurrentChat(options: { discardFailedSaves: boolean }): Promise<void>;
  addOneMessage(message: ExtensionChatMessage, options: { type: string; forceId: number; scroll: boolean }): unknown;
  eventSource: { emit(name: string, index: number): Promise<void> };
  event_types: { MESSAGE_SWIPED: string };
}
async function loadSwipeRuntime(): Promise<SwipeRuntime> {
  await loadExtensionHost();
  const paths = ["/plugin-runtime/compat-runtime.js", "/plugin-runtime/chat.js", "/plugin-runtime/message-rendering.js"];
  const [compat, chat, rendering] = await Promise.all(paths.map(path => import(/* @vite-ignore */ path)));
  return { ...compat, ...chat, ...rendering } as SwipeRuntime;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Uses the actual extension message and awaited event; navigation listeners
 * cannot turn a captured old-story save into a write to the new story. */
export async function selectMessageSwipe(target: SwipeTarget, selected: number, runtime?: SwipeRuntime): Promise<void> {
  const api = runtime ?? await loadSwipeRuntime();
  const same = () => api.getContext().conversationId === target.conversationId && api.getContext().branchId === target.branchId;
  if (!same()) return;
  await api.flushChatSaves();
  if (!same()) return;
  const context = api.getContext(), index = context.chat.findIndex(message => message.id === target.messageId), message = context.chat[index];
  if (!message || message.is_user || message.status === "streaming") throw new Error("此消息暂时不能切换候选回复。");
  const swipes = message.swipes;
  if (!Number.isInteger(selected) || !Array.isArray(swipes) || typeof swipes[selected] !== "string") throw new Error("候选回复已改变，请重新选择。");
  const old = typeof message.swipe_id === "number" ? message.swipe_id : 0;
  if (old === selected) return;
  const infos = Array.isArray(message.swipe_info) ? message.swipe_info : swipes.map(() => ({ send_date: message.send_date, extra: {} }));
  if (typeof swipes[old] === "string") {
    if (context.chatMetadata.tainted || context.chat.length > 1) swipes[old] = message.mes;
    const oldExtra = record(record(infos[old]).extra), currentExtra = record(structuredClone(message.extra ?? {}));
    // Native host provenance remains attached to its own candidate. All other
    // extension fields retain the original whole-extra synchronization semantics.
    if (Object.hasOwn(oldExtra, NATIVE_CANDIDATE_INFO_KEY) && !Object.hasOwn(currentExtra, NATIVE_CANDIDATE_INFO_KEY)) {
      currentExtra[NATIVE_CANDIDATE_INFO_KEY] = structuredClone(oldExtra[NATIVE_CANDIDATE_INFO_KEY]);
    }
    infos[old] = { ...record(infos[old]), send_date: message.send_date, gen_started: message.gen_started,
      gen_finished: message.gen_finished, extra: currentExtra };
  }
  const info = record(infos[selected]);
  message.swipe_info = infos; message.swipe_id = selected; message.mes = swipes[selected] as string;
  message.send_date = info.send_date; message.gen_started = info.gen_started; message.gen_finished = info.gen_finished;
  message.extra = structuredClone(info.extra ?? {});
  const generation = messageGenerationMetadataSchema.safeParse(message.generationMetadata);
  if (generation.success) {
    const status = chatMessageStatusSchema.safeParse(message.status);
    const projected = projectNativeCandidateMessage({ content: message.mes, status: status.success ? status.data : "complete",
      generationMetadata: generation.data, extensionData: message });
    message.generationMetadata = projected.generationMetadata; message.status = projected.status;
  }
  try {
    api.addOneMessage(message, { type: "swipe", forceId: index, scroll: false });
    // applyChatContext captures this pending snapshot before changing targets.
    api.saveMetadataDebounced();
    await api.eventSource.emit(api.event_types.MESSAGE_SWIPED, index);
    if (same()) await api.saveChatConditional();
    else await api.flushChatSaves();
  } catch (error) {
    if (same()) {
      try { await api.reloadCurrentChat({ discardFailedSaves: true }); }
      catch (recovery) { throw new Error(`候选回复未保存，重新读取失败：${recovery instanceof Error ? recovery.message : String(recovery)}`); }
    }
    throw error;
  }
}
