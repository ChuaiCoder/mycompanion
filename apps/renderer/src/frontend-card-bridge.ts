// 前端卡的能力桥：在卡片文档里注入 SillyTavern / 酒馆助手风格的 API（消息读写、变量、
// 世界书、斜杠命令等）。每次调用经 postMessage 转成一次宿主请求并等待回执，
// 卡片侧看到的是普通的 Promise。
//
// 能力策略是**黑名单**：默认放行，逐项禁止。这份名单**不是安全边界**——按产品决策
// （spec §5.10），卡脚本是可信的高权限代码，与父页面同源，可直接访问应用与本地服务。
// 名单管理的是"宿主主动提供的 API 表面"：未实现的明确报"未实现"，与浏览器全局重名的
// 明确拒绝（见下），让卡片脚本走自己的降级分支而不是拿到假数据。

import type { CardVariableMutation, ChatMessage } from "@mycompanion/shared";

/** 卡片脚本发给宿主的请求。 */
export const CARD_BRIDGE_REQUEST = "mycompanion:card-api";
/** 宿主回给卡片的响应。 */
export const CARD_BRIDGE_RESPONSE = "mycompanion:card-api-result";
/** 宿主主动推给卡片的事件（例如故事内容变化）。 */
export const CARD_BRIDGE_EVENT = "mycompanion:card-event";

/**
 * 被禁止的宿主能力。
 *
 * 策略是**默认放行**：名单只保留两类——
 *  1. 本应用**没有实现**的方法（放行也只会得到"未实现"，留着只会误导卡片）；
 *  2. 与浏览器全局重名的名字（`parent` / `top` / `eval` / `fetch` 等）：卡脚本在同源
 *     文档里本就可以直接使用这些浏览器能力；把它们挡在桥外，是避免卡片把"桥方法"
 *     误当成"浏览器全局"——桥方法的语义由宿主定义，浏览器全局应由卡片直接调用。
 *
 * 再次强调：这份名单不是安全边界（卡脚本是可信代码，见 frontend-card-frame.ts）。
 */
export const CARD_API_DENYLIST = [
  // 未实现：放行也只会得到"未实现"，保留以免卡片误判环境
  "generate", "generateRaw", "injectPrompts", "injectPromptsInMode", "getPrompts",
  "installExtension", "updateExtension", "uninstallExtension", "getExtensionStatus",
  "getTavernHelperVersion", "updateTavernHelper",
  "registerVariableSchema", "updateVariablesWith",
  // 与浏览器全局重名：卡应直接调用浏览器全局，桥不提供这些名字的宿主版本
  "fetch", "XMLHttpRequest", "importScripts", "eval", "Function",
  "open", "localStorage", "sessionStorage", "indexedDB",
  "getHostDocument", "getHostWindow", "parent", "top",
] as const;

const DENIED = new Set<string>(CARD_API_DENYLIST);

/** 该能力是否被允许（黑名单即"不在名单里就允许"）。 */
export function isCardApiAllowed(method: string): boolean {
  return !DENIED.has(method);
}

/** 卡片视角的一条消息：贴近常见前端卡脚本期望的字段。 */
export interface CardMessageView {
  mes: string;
  is_user: boolean;
  role: string;
  name?: string;
  swipes: string[];
  swipe_id: number;
  send_date?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * 把应用消息投影成卡片能读的形状。
 *
 * `swipes` 取自已存的候选开场白：`extensionData.swipes` 是候选文本，`swipe_id` 是当前选中的
 * 序号。没有候选数据时退化为"只有一个候选"，即消息本身——卡片据此自然降级。
 */
export function toCardMessage(message: ChatMessage, characterName: string): CardMessageView {
  const extra = record(message.extensionData);
  const swipes = Array.isArray(extra.swipes) ? extra.swipes.filter((item): item is string => typeof item === "string") : [];
  const selected = typeof extra.swipe_id === "number" && Number.isSafeInteger(extra.swipe_id) && extra.swipe_id >= 0 ? extra.swipe_id : 0;
  const list = swipes.length ? swipes : [message.content];
  return {
    mes: message.content,
    is_user: message.role === "user",
    role: message.role,
    ...(message.role === "user" ? { name: "User" } : { name: characterName }),
    swipes: list,
    swipe_id: Math.min(selected, Math.max(list.length - 1, 0)),
    send_date: message.createdAt,
  };
}

/** 宿主为卡片提供能力时用到的东西，由聊天页注入。 */
export interface CardBridgeHost {
  messages: readonly ChatMessage[];
  characterName: string;
  /** 切换到指定候选开场白。 */
  onSelectSwipe: (messageId: string, swipeId: number) => Promise<void>;
  /** 以用户身份发送一条消息（对应 `/send`）。 */
  onSend: (text: string) => void;
  /** 读取变量：不给作用域时返回合并视图（消息级 > 故事级 > 全局）。 */
  onReadVariables: (target?: { type?: string; messageId?: string | "latest" }) => Promise<Record<string, unknown>>;
  /** 写入变量；实现方负责落到正确的层级。 */
  onWriteVariables: (mutation: CardVariableMutation) => Promise<void>;
  /** 世界书：列出名字（对应卡片的 getLorebooks）。 */
  onListLorebooks: () => Promise<string[]>;
  /** 世界书：读取整份文档。 */
  onReadLorebook: (name: string) => Promise<Record<string, unknown> | null>;
  /** 世界书：写入整份文档（不存在则创建）。 */
  onWriteLorebook: (name: string, document: Record<string, unknown>) => Promise<void>;
  /** 删除一条消息（对应 `/cut <id>`）。 */
  onDeleteMessage?: ((messageId: string) => Promise<void> | void) | undefined;
  /** 触发一次生成（对应 `/trigger`）。 */
  onTrigger?: (() => Promise<void> | void) | undefined;
  /**
   * 等待当前生成结束（若空闲则立即返回）。
   *
   * 卡片的开局管道是 `/sys … | /cut <序号> | /trigger`：`/sys` 自己会启动一次生成，
   * 于是紧随其后的 `/trigger` 会在"正在生成"时被宿主静默跳过（实测：管道三段都执行了，
   * 但游戏没有开场内容）。有了这个钩子，`/trigger` 可以等前一次生成结束后再触发。
   */
  onWaitForIdle?: (() => Promise<void>) | undefined;
  /**
   * 中止当前生成（若空闲则无操作）。
   *
   * `/cut` 要删掉的那条消息可能正在生成中：卡片的管道顺序是"先发内容、再删占位、最后触发"，
   * 而 `/sys` 会立刻启动一次生成。若删掉正在生成的消息，那次生成的输出就随消息一起消失，
   * 后面的 `/trigger` 也会因为状态不一致而无效。所以删除前先中止。
   */
  onCancelGeneration?: (() => Promise<void>) | undefined;
}

export interface CardBridgeRequest {
  id: number;
  method: string;
  args: unknown[];
}

export type CardBridgeResult = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };

/** 解析宿主收到的消息，非本协议的消息返回 null。 */
export function parseCardBridgeRequest(data: unknown): CardBridgeRequest | null {
  const value = record(data);
  if (value.type !== CARD_BRIDGE_REQUEST) return null;
  const id = value.id;
  const method = value.method;
  if (typeof id !== "number" || !Number.isSafeInteger(id)) return null;
  if (typeof method !== "string" || !method) return null;
  return { id, method, args: Array.isArray(value.args) ? value.args : [] };
}

/** `/send 文本` —— 卡片脚本表达"以用户身份发言"的常见写法。 */
export function parseSlashSend(command: string): string | null {
  const match = /^\s*\/send(?:-as-user)?\s+([\s\S]+)$/i.exec(command);
  return match ? match[1]!.trim() : null;
}

/** 支持的斜杠命令。未列出的会被明确拒绝，避免"看起来执行了其实没做"。 */
const SUPPORTED_SLASH = new Set(["send", "send-as-user", "sys", "trigger", "cut"]);

/**
 * 执行一条斜杠命令。
 *
 * 卡片的开局流程把多个命令用 `|` 串联（`/sys … | /cut <id> | /trigger`），因此这里按
 * 管道符切分后逐条执行。`/sys` 与 `/send` 都映射为"以用户身份发言"——本应用没有
 * system 角色消息，把它当成用户发言是语义上最接近且不会静默丢弃的做法。
 */
export async function executeSlashCommand(
  id: number,
  command: string,
  host: CardBridgeHost,
): Promise<CardBridgeResult> {
  // 按 ` | ` 切分，但不破坏文本里普通的分隔符：只在命令边界处切。
  const parts = command.split(/\s*\|\s*(?=\/)/).map(part => part.trim()).filter(Boolean);
  // 诊断开关（默认关闭）：地址栏加 #card-bridge-debug 时打印管道分段与结果。
  // 卡片把多个命令用竖线串起来，出问题时很难判断到底哪一段到达了宿主，
  // 这个开关让"管道里某一段是否执行"变成可观测事实。
  const debugging = typeof location !== "undefined" && location.hash.includes("card-bridge-debug");
  if (debugging) console.info("[card-bridge] 管道分段", parts);
  const rejected: string[] = [];
  for (const part of parts) {
    const match = /^\/([\w-]+)\s*([\s\S]*)$/.exec(part);
    if (!match) continue;
    const name = match[1]!.toLowerCase();
    const rest = match[2]!.trim();
    if (!SUPPORTED_SLASH.has(name)) { rejected.push(name); continue; }
    if (name === "trigger") {
      // 卡的收尾管道是 `/sys … | /cut <序号> | /trigger`，即"发出开局内容→删掉占位→让 AI 开场"。
      // `/sys` 自身会启动一次生成；若此时直接触发，宿主会因为"正在生成"而**静默跳过**这一次
      // （实测：管道三段都到达了宿主，游戏却没有开场内容）。所以先等生成空闲。
      if (host.onWaitForIdle) await host.onWaitForIdle();
      if (host.onTrigger) await host.onTrigger();
      if (debugging) console.info("[card-bridge] /trigger 已执行");
      continue;
    }
    if (name === "cut") {
      // 卡片传的是**会话内序号**（与 getChatMessages(0) / getCurrentMessageId() 同一套编号），
      // 而宿主删除消息需要真实 id。实测：卡的 `/cut 0` 原样当 id 处理时匹配不到任何消息，
      // 于是开场白占位消息永远不会被删除，且没有任何报错。
      // 允许 `/cut` 不带参数（默认删最后一条），也允许显式序号或 "last"。
      let messageId: string | undefined;
      if (!rest || rest === "last") {
        messageId = host.messages.at(-1)?.id;
      } else if (/^\d+$/.test(rest)) {
        messageId = host.messages[Number(rest)]?.id;
      } else {
        messageId = rest;
      }
      // 删掉正在生成的消息会连带丢弃那次生成的输出；先中止生成。
      if (host.onCancelGeneration) await host.onCancelGeneration();
      if (messageId) await host.onDeleteMessage?.(messageId);
      continue;
    }
    // send / send-as-user / sys → 以用户身份发送
    if (rest) {
      if (debugging) console.info("[card-bridge] /" + name + " 发送", rest.slice(0, 40));
      host.onSend(rest);
    }
  }
  if (rejected.length) return { id, ok: false, error: `本应用未支持这些指令：/${rejected.join(" /")}` };
  return { id, ok: true, value: "" };
}

const VARIABLE_TYPES = new Set(["chat", "character", "preset", "global", "message"]);

/**
 * 把卡片传来的 `{ type, message_id }` 归一成宿主的目标描述。
 *
 * 卡片按**会话内序号**引用消息（与 `getChatMessages(0)` 同一套编号），因此数值需要在宿主侧
 * 映射成真实消息 id；映射不到时明确报错，而不是静默写到别的消息上。
 */
function variableTargetOf(
  option: Record<string, unknown>,
  messages: readonly ChatMessage[],
): { type: string; messageId?: string } | { error: string } {
  const type = typeof option.type === "string" && VARIABLE_TYPES.has(option.type) ? option.type : "chat";
  if (type !== "message") return { type };
  const raw = option.message_id;
  if (raw === undefined || raw === "latest") {
    const last = messages.at(-1);
    return last ? { type, messageId: last.id } : { error: "当前故事没有可写入的消息。" };
  }
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) {
    const target = messages[raw];
    return target ? { type, messageId: target.id } : { error: `消息序号 ${raw} 不存在。` };
  }
  if (typeof raw === "string" && raw) return { type, messageId: raw };
  return { error: "message_id 无效。" };
}

/**
 * 执行一条卡片请求。
 *
 * 被禁止的能力返回明确错误；未知能力按黑名单策略**放行**，但只有这里实现的方法才真的有
 * 效果——其余会以"未实现"结束，卡片脚本因此会走自己的降级分支而不是拿到假数据。
 */
export async function runCardBridgeRequest(request: CardBridgeRequest, host: CardBridgeHost): Promise<CardBridgeResult> {
  const { id, method, args } = request;
  if (!isCardApiAllowed(method)) {
    return { id, ok: false, error: `该能力已在 MyCompanion 中被禁用：${method}` };
  }
  try {
    switch (method) {
      case "getChatMessages": {
        const range = args[0];
        const messages = host.messages.map(message => toCardMessage(message, host.characterName));
        if (typeof range === "number") {
          const picked = Number.isSafeInteger(range) && range >= 0 ? messages[range] : undefined;
          return { id, ok: true, value: picked ? [picked] : [] };
        }
        return { id, ok: true, value: messages };
      }
      case "setChatMessage": {
        const content = args[0];
        const index = args[1];
        const options = record(args[2]);
        if (typeof content !== "string") return { id, ok: false, error: "setChatMessage 需要文本内容。" };
        const targetIndex = typeof index === "number" && Number.isSafeInteger(index) && index >= 0 ? index : 0;
        const message = host.messages[targetIndex];
        if (!message) return { id, ok: false, error: "目标消息不存在。" };
        const swipe = options.swipe_id;
        if (typeof swipe === "number" && Number.isSafeInteger(swipe) && swipe >= 0) {
          await host.onSelectSwipe(message.id, swipe);
        } else if (content !== message.content) {
          return { id, ok: false, error: "本应用只允许通过切换候选改写开场白，不接受直接覆写消息。" };
        }
        return { id, ok: true, value: true };
      }
      case "triggerSlash": {
        const command = args[0];
        if (typeof command !== "string") return { id, ok: false, error: "triggerSlash 需要命令文本。" };
        return executeSlashCommand(id, command, host);
      }
      // 变量：本应用独立实现。作用域为 chat / character / preset / global / message。
      case "getVariables": {
        const option = record(args[0]);
        const target = variableTargetOf(option, host.messages);
        if ("error" in target) return { id, ok: false, error: target.error };
        return { id, ok: true, value: await host.onReadVariables(target) };
      }
      case "getAllVariables": {
        // 卡片侧期望"所有变量"的扁平视图；等价于不带作用域的合并读取。
        return { id, ok: true, value: await host.onReadVariables(undefined) };
      }
      case "replaceVariables": {
        const values = record(args[0]);
        const target = variableTargetOf(record(args[1]), host.messages);
        if ("error" in target) return { id, ok: false, error: target.error };
        await host.onWriteVariables({ action: "replace", values, ...target } as CardVariableMutation);
        return { id, ok: true, value: true };
      }
      case "insertVariables": {
        // 只补缺失的键，不覆盖已有值。
        const values = record(args[0]);
        const target = variableTargetOf(record(args[1]), host.messages);
        if ("error" in target) return { id, ok: false, error: target.error };
        await host.onWriteVariables({ action: "insert", values, ...target } as CardVariableMutation);
        return { id, ok: true, value: true };
      }
      case "insertOrAssignVariables": {
        // 逐键赋值：存在的覆盖、不存在的写入（与 insertVariables 的区别就在这里）。
        const values = record(args[0]);
        const target = variableTargetOf(record(args[1]), host.messages);
        if ("error" in target) return { id, ok: false, error: target.error };
        for (const [key, value] of Object.entries(values)) {
          await host.onWriteVariables({ action: "set", key, value, remove: false, ...target } as CardVariableMutation);
        }
        return { id, ok: true, value: true };
      }
      case "setVariables": {
        // 卡片常见形态：一次给一组键值，语义是"赋值"。
        const values = record(args[0]);
        const target = variableTargetOf(record(args[1]), host.messages);
        if ("error" in target) return { id, ok: false, error: target.error };
        for (const [key, value] of Object.entries(values)) {
          await host.onWriteVariables({ action: "set", key, value, remove: false, ...target } as CardVariableMutation);
        }
        return { id, ok: true, value: true };
      }
      case "deleteVariable": {
        const option = record(args[0]);
        const key = option.key;
        if (typeof key !== "string") return { id, ok: false, error: "deleteVariable 需要变量名。" };
        const target = variableTargetOf(option, host.messages);
        if ("error" in target) return { id, ok: false, error: target.error };
        await host.onWriteVariables({ action: "set", key, value: null, remove: true, ...target } as CardVariableMutation);
        return { id, ok: true, value: true };
      }
      // 世界书（对应卡片的 getLorebooks / createLorebook / createLorebookEntry）。
      case "getLorebooks":
      case "getWorldbookNames": {
        return { id, ok: true, value: await host.onListLorebooks() };
      }
      case "getLorebook":
      case "getWorldbook": {
        const name = args[0];
        if (typeof name !== "string") return { id, ok: false, error: "需要世界书名称。" };
        const document = await host.onReadLorebook(name);
        if (!document) return { id, ok: false, error: `世界书不存在：${name}` };
        // 卡片按 `entries` 为数组的形态读取时也给数组视图。
        const entries = record(document.entries);
        return { id, ok: true, value: { ...document, entries: Object.values(entries) } };
      }
      case "createLorebook": {
        const name = args[0];
        if (typeof name !== "string" || !name.trim()) return { id, ok: false, error: "需要世界书名称。" };
        // 已存在则保持原内容：创建不应清空既有世界书。
        const existing = await host.onReadLorebook(name);
        if (!existing) await host.onWriteLorebook(name, { entries: {} });
        return { id, ok: true, value: true };
      }
      case "createLorebookEntry":
      case "createWorldbookEntries": {
        const name = args[0];
        const entries = args[1];
        if (typeof name !== "string") return { id, ok: false, error: "需要世界书名称。" };
        const list = Array.isArray(entries) ? entries : [entries];
        const existing = (await host.onReadLorebook(name)) ?? { entries: {} };
        const current = record(existing.entries);
        // 条目 id：助手用递增字符串键；沿用同名条目时覆盖而不是重复追加。
        let next = Object.keys(current).reduce((max, key) => Math.max(max, Number(key) + 1 || 0), 0);
        for (const raw of list) {
          const entry = record(raw);
          if (!Object.keys(entry).length) continue;
          const comment = typeof entry.comment === "string" ? entry.comment : "";
          const duplicate = comment
            ? Object.entries(current).find(([, value]) => record(value).comment === comment)
            : undefined;
          if (duplicate) current[duplicate[0]] = { ...record(duplicate[1]), ...entry };
          else current[String(next++)] = entry;
        }
        await host.onWriteLorebook(name, { ...existing, entries: current });
        return { id, ok: true, value: true };
      }
      case "replaceLorebook":
      case "replaceWorldbook": {
        const name = args[0];
        if (typeof name !== "string") return { id, ok: false, error: "需要世界书名称。" };
        await host.onWriteLorebook(name, record(args[1]));
        return { id, ok: true, value: true };
      }
      // 斜杠命令：只实现开局真正需要的两个，其余明确拒绝而不是静默忽略。
      case "executeSlashCommands":
      case "executeSlashCommandsWithOptions": {
        const command = typeof args[0] === "string" ? args[0] : record(args[0]).command;
        if (typeof command !== "string") return { id, ok: false, error: "需要命令文本。" };
        return executeSlashCommand(id, command, host);
      }
      default:
        return { id, ok: false, error: `本应用尚未实现该能力：${method}` };
    }
  } catch (error) {
    return { id, ok: false, error: error instanceof Error ? error.message : "卡片请求执行失败。" };
  }
}

/**
 * 注入卡片文档的桥脚本：在卡片脚本运行前挂上这些全局函数。
 *
 * 每个调用都转成一次 postMessage 请求并等待回执，因此卡片侧看到的是正常的 Promise。
 */
export const CARD_BRIDGE_SCRIPT = `(function () {
  var REQUEST = ${JSON.stringify(CARD_BRIDGE_REQUEST)};
  var RESPONSE = ${JSON.stringify(CARD_BRIDGE_RESPONSE)};
  var EVENT = ${JSON.stringify(CARD_BRIDGE_EVENT)};
  var pending = {};
  var nextId = 1;
  var listeners = {};
  function call(method, args) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending[id] = { resolve: resolve, reject: reject };
      try { parent.postMessage({ type: REQUEST, id: id, method: method, args: args || [] }, '*'); }
      catch (error) { delete pending[id]; reject(error); }
    });
  }
  window.addEventListener('message', function (event) {
    var data = event.data || {};
    if (data.type === RESPONSE) {
      var entry = pending[data.id];
      if (!entry) return;
      delete pending[data.id];
      if (data.ok) entry.resolve(data.value);
      else entry.reject(new Error(String(data.error)));
      return;
    }
    if (data.type === EVENT) {
      (listeners[data.name] || []).forEach(function (handler) {
        try { handler(data.payload); } catch (error) {}
      });
    }
  });
  // 常见的前端卡 API。未实现的能力会以明确错误拒绝，卡片脚本据此走降级分支。
  window.getChatMessages = function (range, options) { return call('getChatMessages', [range, options]); };
  window.setChatMessage = function (content, index, options) { return call('setChatMessage', [content, index, options]); };
  window.setChatMessages = function (messages, options) { return call('setChatMessages', [messages, options]); };
  window.triggerSlash = function (command) { return call('triggerSlash', [command]); };
  // 变量：本应用独立实现，支持 chat / character / preset / global / message。
  window.getVariables = function (option) { return call('getVariables', [option]); };
  window.getAllVariables = function () { return call('getAllVariables', []); };
  window.replaceVariables = function (variables, option) { return call('replaceVariables', [variables, option]); };
  window.insertVariables = function (variables, option) { return call('insertVariables', [variables, option]); };
  window.insertOrAssignVariables = function (variables, option) { return call('insertOrAssignVariables', [variables, option]); };
  window.setVariables = function (variables, option) { return call('setVariables', [variables, option]); };
  window.deleteVariable = function (option) { return call('deleteVariable', [option]); };
  // 世界书：卡片开局会新建一本世界书并逐条注入（功法 / 气运 / 天定道侣）。
  window.getLorebooks = function () { return call('getLorebooks', []); };
  window.getLorebook = function (name) { return call('getLorebook', [name]); };
  window.createLorebook = function (name) { return call('createLorebook', [name]); };
  window.createLorebookEntry = function (name, entry) { return call('createLorebookEntry', [name, entry]); };
  window.replaceLorebook = function (name, document) { return call('replaceLorebook', [name, document]); };
  // 斜杠命令：executeSlashCommands 用于本应用支持的子集（/send /sys /cut /trigger）。
  window.executeSlashCommands = function (command) { return call('executeSlashCommands', [command]); };
  window.executeSlashCommandsWithOptions = function (command) { return call('executeSlashCommandsWithOptions', [command]); };
  window.TavernHelper = window.TavernHelper || {};
  window.TavernHelper.getChatMessages = window.getChatMessages;
  window.TavernHelper.setChatMessage = window.setChatMessage;
  window.TavernHelper.triggerSlash = window.triggerSlash;
  window.TavernHelper.getVariables = window.getVariables;
  window.TavernHelper.getAllVariables = window.getAllVariables;
  window.TavernHelper.replaceVariables = window.replaceVariables;
  window.TavernHelper.insertVariables = window.insertVariables;
  window.TavernHelper.insertOrAssignVariables = window.insertOrAssignVariables;
  window.TavernHelper.setVariables = window.setVariables;
  window.TavernHelper.deleteVariable = window.deleteVariable;
  window.TavernHelper.getLorebooks = window.getLorebooks;
  window.TavernHelper.createLorebook = window.createLorebook;
  window.TavernHelper.createLorebookEntry = window.createLorebookEntry;
  window.TavernHelper.executeSlashCommands = window.executeSlashCommands;
  window.eventOn = function (name, handler) { (listeners[name] = listeners[name] || []).push(handler); return { stop: function () {} }; };
  // 本脚本在**任何卡运行时之前**执行（lodash / jQuery / zod 都是之后才加载的模块），
  // 因此这里**绝不能引用下划线、美元符号或 z**。实测教训：原先用 _.has(window, target)
  // 判断全局是否就绪，导致 waitGlobalInitialized 抛
  // "ReferenceError: _ is not defined"，而卡正是在它自己的 DOMContentLoaded 回调里
  // 调用该函数——异常中断了整个回调，于是后面所有按钮的事件绑定都没执行，
  // 界面看起来完全正常但点任何按钮都没有反应。
  var hasGlobal = function (object, key) {
    return object != null && typeof object[key] !== 'undefined';
  };
  window.waitGlobalInitialized = function (name) {
    // 真实机制（读酒馆助手源码 src/function/global.ts 得到）：宿主在某个全局就绪时
    // 发出 global_<name>_initialized 事件，waitGlobalInitialized 就是等这个事件。
    // MVU 自己会发 global_Mvu_initialized（它把实例挂到 window.parent.Mvu 之后）。
    var target = String(name);
    if (hasGlobal(window, target)) return Promise.resolve();
    return new Promise(function (resolve) {
      var done = false;
      var finish = function () { if (!done) { done = true; resolve(); } };
      window.eventOn('global_' + target + '_initialized', finish);
      // 兜底：父窗口（同源）上已经就绪时立即返回。
      try { if (hasGlobal(window.parent, target)) { finish(); return; } } catch (error) {}
      // 若始终没有事件（例如运行时未启用该功能），不要永久挂起调用方。
      setTimeout(finish, 4000);
    });
  };

  // ── 宿主桩件：对齐酒馆前端的对象形状 ──────────────────────────────────────
  //
  // 卡自带的运行时（本卡为 MVU 与配置助手）直接引用这些对象，例如
  // SillyTavern.extensionSettings / SillyTavern.chat / TavernHelper.getWorldbookNames()。
  // 缺了它们，模块会在顶层抛 ReferenceError 而完全不执行（实测过）。
  //
  // 这里的取舍是：按调用点实测出的成员逐个提供，而不是伪造一个完整的酒馆。
  // 读操作尽量给出真实数据（聊天记录、角色、世界书），写操作交给宿主桥；
  // 纯界面类成员（弹窗、宏注册、日志）给出不会崩的安全实现。
  var noop = function () {};
  var context = function () {
    return {
      chat: (window.__hostChat || []),
      characters: {},
      characterId: undefined,
      name1: 'User',
      name2: (window.__hostCharacterName || 'Character'),
      extensionSettings: {},
      chatCompletionSettings: {},
      extensionPrompts: {},
      getCurrentChatId: function () { return window.__hostConversationId || ''; },
      getRequestHeaders: function () { return {}; },
      saveChat: noop, saveSettingsDebounced: noop, saveMetadataDebounced: noop,
      registerMacro: noop, unregisterMacro: noop,
      registerFunctionTool: noop, unregisterFunctionTool: noop,
      callGenericPopup: function () { return Promise.resolve(1); },
      getTokenizerModel: function () { return 'gpt-3.5-turbo'; },
      getChatCompletionModel: function () { return window.__hostModel || ''; },
      eventSource: { on: window.eventOn, emit: window.eventEmit, once: window.eventOn, removeListener: noop },
      eventTypes: {},
    };
  };
  // 事件名常量表：MVU 用它注册 MESSAGE_DELETED / MESSAGE_RECEIVED 等监听，
  // 缺少它时注册阶段会抛 ReferenceError。常量名取自助手源码 src/function/event.ts
  // （接口契约，不是实现代码）。
  window.tavern_events = {APP_READY:'app_ready',EXTRAS_CONNECTED:'extras_connected',MESSAGE_SWIPED:'message_swiped',MESSAGE_SENT:'message_sent',MESSAGE_RECEIVED:'message_received',MESSAGE_EDITED:'message_edited',MESSAGE_DELETED:'message_deleted',MESSAGE_UPDATED:'message_updated',MESSAGE_FILE_EMBEDDED:'message_file_embedded',MESSAGE_REASONING_EDITED:'message_reasoning_edited',MESSAGE_REASONING_DELETED:'message_reasoning_deleted',MESSAGE_SWIPE_DELETED:'message_swipe_deleted',MORE_MESSAGES_LOADED:'more_messages_loaded',IMPERSONATE_READY:'impersonate_ready',CHAT_CHANGED:'chat_id_changed',GENERATION_AFTER_COMMANDS:'GENERATION_AFTER_COMMANDS',GENERATION_STARTED:'generation_started',GENERATION_STOPPED:'generation_stopped',GENERATION_ENDED:'generation_ended',SD_PROMPT_PROCESSING:'sd_prompt_processing',EXTENSIONS_FIRST_LOAD:'extensions_first_load',EXTENSION_SETTINGS_LOADED:'extension_settings_loaded',SETTINGS_LOADED:'settings_loaded',SETTINGS_UPDATED:'settings_updated',MOVABLE_PANELS_RESET:'movable_panels_reset',SETTINGS_LOADED_BEFORE:'settings_loaded_before',SETTINGS_LOADED_AFTER:'settings_loaded_after',CHATCOMPLETION_SOURCE_CHANGED:'chatcompletion_source_changed',CHATCOMPLETION_MODEL_CHANGED:'chatcompletion_model_changed',OAI_PRESET_CHANGED_BEFORE:'oai_preset_changed_before',OAI_PRESET_CHANGED_AFTER:'oai_preset_changed_after',OAI_PRESET_EXPORT_READY:'oai_preset_export_ready',OAI_PRESET_IMPORT_READY:'oai_preset_import_ready',WORLDINFO_SETTINGS_UPDATED:'worldinfo_settings_updated',WORLDINFO_UPDATED:'worldinfo_updated',CHARACTER_EDITOR_OPENED:'character_editor_opened',CHARACTER_EDITED:'character_edited',CHARACTER_PAGE_LOADED:'character_page_loaded',USER_MESSAGE_RENDERED:'user_message_rendered',CHARACTER_MESSAGE_RENDERED:'character_message_rendered',FORCE_SET_BACKGROUND:'force_set_background',CHAT_DELETED:'chat_deleted',CHAT_CREATED:'chat_created',GENERATE_BEFORE_COMBINE_PROMPTS:'generate_before_combine_prompts',GENERATE_AFTER_COMBINE_PROMPTS:'generate_after_combine_prompts',GENERATE_AFTER_DATA:'generate_after_data',WORLD_INFO_ACTIVATED:'world_info_activated',TEXT_COMPLETION_SETTINGS_READY:'text_completion_settings_ready',CHAT_COMPLETION_SETTINGS_READY:'chat_completion_settings_ready',CHAT_COMPLETION_PROMPT_READY:'chat_completion_prompt_ready',CHARACTER_FIRST_MESSAGE_SELECTED:'character_first_message_selected',CHARACTER_DELETED:'characterDeleted',CHARACTER_DUPLICATED:'character_duplicated',CHARACTER_RENAMED:'character_renamed',CHARACTER_RENAMED_IN_PAST_CHAT:'character_renamed_in_past_chat',SMOOTH_STREAM_TOKEN_RECEIVED:'stream_token_received',STREAM_TOKEN_RECEIVED:'stream_token_received',STREAM_REASONING_DONE:'stream_reasoning_done',FILE_ATTACHMENT_DELETED:'file_attachment_deleted',WORLDINFO_FORCE_ACTIVATE:'worldinfo_force_activate',OPEN_CHARACTER_LIBRARY:'open_character_library',ONLINE_STATUS_CHANGED:'online_status_changed',IMAGE_SWIPED:'image_swiped',CONNECTION_PROFILE_LOADED:'connection_profile_loaded',CONNECTION_PROFILE_CREATED:'connection_profile_created',CONNECTION_PROFILE_DELETED:'connection_profile_deleted',CONNECTION_PROFILE_UPDATED:'connection_profile_updated',TOOL_CALLS_PERFORMED:'tool_calls_performed',TOOL_CALLS_RENDERED:'tool_calls_rendered',CHARACTER_MANAGEMENT_DROPDOWN:'charManagementDropdown',SECRET_WRITTEN:'secret_written',SECRET_DELETED:'secret_deleted',SECRET_ROTATED:'secret_rotated',SECRET_EDITED:'secret_edited',PRESET_CHANGED:'preset_changed',PRESET_DELETED:'preset_deleted',PRESET_RENAMED:'preset_renamed',PRESET_RENAMED_BEFORE:'preset_renamed_before',MAIN_API_CHANGED:'main_api_changed',WORLDINFO_ENTRIES_LOADED:'worldinfo_entries_loaded',WORLDINFO_SCAN_DONE:'worldinfo_scan_done',MEDIA_ATTACHMENT_DELETED:'media_attachment_deleted'};
  window.event_types = window.tavern_events;
  window.SillyTavern = new Proxy({
    getContext: context,
    extensionSettings: {},
    chatCompletionSettings: {},
    chat: [],
    characters: {},
    characterId: undefined,
    name2: (window.__hostCharacterName || 'Character'),
    getCurrentChatId: function () { return window.__hostConversationId || ''; },
    getRequestHeaders: function () { return {}; },
    getTokenizerModel: function () { return 'gpt-3.5-turbo'; },
    getChatCompletionModel: function () { return window.__hostModel || ''; },
    saveChat: noop, saveSettingsDebounced: noop,
    registerMacro: noop, unregisterMacro: noop,
    registerFunctionTool: noop, unregisterFunctionTool: noop,
    callGenericPopup: function () { return Promise.resolve(1); },
    POPUP_TYPE: { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4 },
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null },
    // 工具调用管理器：本应用没有同名设施，给一个不会崩的空实现。
    ToolManager: { registerFunctionTool: noop, unregisterFunctionTool: noop, isToolCallingSupported: function () { return false; } },
  }, {
    // 未实现的成员一律回落到"可调用的空函数"，避免任何一处读取就中断整个模块。
    get: function (target, key) {
      if (key in target) return target[key];
      return noop;
    },
  });
  window.TavernHelper = window.TavernHelper || {};
  // 配置助手读取的世界书/正则/脚本树接口；前四个已在桥里实现，这里补别名。
  window.TavernHelper.getWorldbookNames = function () { return call('getLorebooks', []); };
  window.TavernHelper.getCharWorldbookNames = function () { return call('getLorebooks', []); };
  window.TavernHelper.getWorldbook = function (name) { return call('getLorebook', [name]); };
  window.TavernHelper.replaceWorldbook = function (name, document) { return call('replaceLorebook', [name, document]); };
  // 正则与脚本树：本应用没有可写的对应设施，明确失败而不是假装成功。
  window.TavernHelper.getTavernRegexes = function () { return Promise.resolve([]); };
  window.TavernHelper.updateTavernRegexesWith = function () { return Promise.reject(new Error('本应用不支持通过卡片修改正则规则。')); };
  window.TavernHelper.getScriptTrees = function () { return Promise.resolve([]); };
  window.TavernHelper.updateScriptTreesWith = function () { return Promise.reject(new Error('本应用不支持通过卡片修改脚本库。')); };
  // 变量 schema 注册：本应用的变量存储不校验 schema，接受注册但不强制。
  window.registerVariableSchema = window.registerVariableSchema || function () { return true; };
  window.updateVariablesWith = window.updateVariablesWith || function (updater, option) {
    return call('getVariables', [option]).then(function (current) {
      var next = typeof updater === 'function' ? updater(current) : updater;
      return call('replaceVariables', [next, option]);
    });
  };
  window.substitudeMacros = window.substitudeMacros || function (text) { return Promise.resolve(String(text == null ? '' : text)); };
  window.getLastMessageId = window.getLastMessageId || function () { return Promise.resolve((window.__hostChat || []).length - 1); };
  window.toastr = window.toastr || {
    info: noop, success: noop, warning: noop, error: noop, clear: noop,
  };

  // 事件系统：酒馆助手用一套命名事件（VARIABLE_UPDATE_STARTED/ENDED 等）驱动脚本。
  // 这里复用桥脚本已有的监听表，保证 eventOn 注册的回调能被 eventEmit 触发。
  var emitTo = function (name, payload) {
    (listeners[name] || []).forEach(function (handler) { try { handler(payload); } catch (error) {} });
  };
  window.eventEmit = window.eventEmit || function (name, payload) { emitTo(name, payload); };
  window.eventOnce = window.eventOnce || window.eventOn;
  window.eventMakeFirst = window.eventMakeFirst || window.eventOn;
  window.eventRemoveListener = window.eventRemoveListener || noop;
  window.eventClearAll = window.eventClearAll || noop;
  // 脚本标识与版本：MVU 用它给 localStorage 键做命名空间（实测 getScriptId 在 window.parent 访问旁）。
  window.getScriptId = window.getScriptId || function () { return 'mycompanion-card'; };
  window.getPreferredScriptId = window.getPreferredScriptId || function () { return 'mycompanion-card'; };
  window.getTavernHelperVersion = window.getTavernHelperVersion || function () { return '4.11.3'; };
  window.getCurrentMessageId = window.getCurrentMessageId || function () { return (window.__hostChat || []).length - 1; };
  window.getCurrentMvuData = window.getCurrentMvuData || function (option) { return window.Mvu ? window.Mvu.getMvuData(option) : {}; };
  window.replaceCurrentMvuData = window.replaceCurrentMvuData || function (data, option) {
    return window.Mvu ? window.Mvu.replaceMvuData(data, option) : undefined;
  };
  // 点路径读写：自己实现，不依赖 lodash（见上文时序说明）。
  var pathParts = function (path) { return Array.isArray(path) ? path : String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean); };
  var getPath = function (object, path) {
    var current = object;
    for (var part of pathParts(path)) { if (current == null) return undefined; current = current[part]; }
    return current;
  };
  var setPath = function (object, path, value) {
    var parts = pathParts(path);
    var current = object;
    for (var i = 0; i < parts.length - 1; i++) {
      if (current[parts[i]] == null || typeof current[parts[i]] !== 'object') current[parts[i]] = {};
      current = current[parts[i]];
    }
    if (parts.length) current[parts[parts.length - 1]] = value;
    return object;
  };
  window.setMvuVariable = window.setMvuVariable || function (path, value, option) {
    if (!window.Mvu) return undefined;
    var data = window.Mvu.getMvuData(option) || {};
    setPath(data, path, value);
    return window.Mvu.replaceMvuData(data, option);
  };
  window.getMvuVariable = window.getMvuVariable || function (path, option) {
    return window.Mvu ? getPath(window.Mvu.getMvuData(option), path) : undefined;
  };
  // 世界书相关别名（桥里已有实现）。
  window.getCharLorebooks = window.getCharLorebooks || function () { return call('getLorebooks', []); };
  window.getCharWorldbookNames = window.getCharWorldbookNames || function () { return call('getLorebooks', []); };
  window.getCurrentCharPrimaryLorebook = window.getCurrentCharPrimaryLorebook || function () { return Promise.resolve(null); };
  window.getLorebookEntries = window.getLorebookEntries || function (name) { return call('getLorebook', [name]); };
  // 预设：本应用没有与酒馆同构的预设对象，给空结果而不是假装成功。
  window.getPreset = window.getPreset || function () { return Promise.resolve({}); };
  window.getPresetNames = window.getPresetNames || function () { return Promise.resolve([]); };
  // 未实现但被引用的名字：给可调用的占位，避免顶层 ReferenceError 中断整个模块。
  ['registerMacro', 'unregisterMacro', 'registerFunctionTool', 'unregisterFunctionTool',
    'getLorebookSettings', 'setLorebookSettings', 'getSettings', 'getPluginSettings',
    'setPluginSettings', 'getUnitSystem', 'waitForRuntimeApi', 'findParentWindow'].forEach(function (name) {
      if (typeof window[name] === 'undefined') window[name] = noop;
    });
  // 酒馆助手的界面辅助函数：MVU 在挂载自己的面板时会调用它们。
  // 本应用没有对应的酒馆 DOM，所以给不会崩的实现（返回空/无操作），
  // 这样面板逻辑继续走，而不是整个模块中断。
  var helperUi = {
    appendInexistentScriptButtons: noop,
    replaceScriptButtons: noop,
    getScriptButtons: function () { return []; },
    setScriptButtons: noop,
    appendInexistentScriptItems: noop,
    replaceScriptItems: noop,
    getScriptItems: function () { return []; },
    setScriptItems: noop,
    updateScriptButtons: noop,
    // 按钮事件：实测 MVU 的用法是 eventOn(getButtonEvent(name), handler)，
    // 即 getButtonEvent 只需返回一个稳定的事件标识字符串（同名多次调用必须一致）。
    getButtonEvent: function (name) { return 'mycompanion:button:' + String(name); },
    eventButtonOn: function (name, handler) { return window.eventOn('mycompanion:button:' + String(name), handler); },
    eventButtonEmit: function (name, payload) { emitTo('mycompanion:button:' + String(name), payload); },
    errorCatched: function (fn) { return fn; },
    getIframeName: function () { return window.__hostConversationId || 'mycompanion'; },
    getCurrentMessageId: function () { return (window.__hostChat || []).length - 1; },
  };
  Object.keys(helperUi).forEach(function (name) {
    if (typeof window[name] === 'undefined') window[name] = helperUi[name];
  });
  // YAML / EjsTemplate / CryptoJS：卡脚本引用它们；缺了会在使用时抛错，
  // 因此给不会崩的实现（YAML 解析失败时返回原文，加密相关明确报错）。
  window.YAML = window.YAML || {
    parse: function (text) { try { return JSON.parse(text); } catch (error) { return {}; } },
    stringify: function (value) { try { return JSON.stringify(value); } catch (error) { return ''; } },
  };
  window.EjsTemplate = window.EjsTemplate || { evalTemplate: function (text) { return Promise.resolve(String(text == null ? '' : text)); } };
  window.CryptoJS = window.CryptoJS || {};
})();`;
