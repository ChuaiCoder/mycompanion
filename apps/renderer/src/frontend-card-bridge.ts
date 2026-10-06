// 前端卡的能力桥：卡片脚本运行在不透明源 iframe 里，因此**必须**通过 postMessage 与
// 宿主通信（它没有任何直接访问应用的途径）。
//
// 能力策略是**黑名单**：默认放行，逐项禁止。这比白名单弱——未知能力默认是允许的——因此
// 安全不依赖这份名单，而依赖两道结构性边界：
//   1. 不透明源 iframe：卡脚本对应用 DOM／location／存储的访问被同源策略直接拒绝；
//   2. 隔离文档内的 `default-src 'none'`：卡脚本无法联网，名单因此无法被绕过用于外发数据。
// 名单的作用是拦住"应用自己暴露出去的能力"（读改数据、装扩展等），而不是充当沙箱。

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
 * 策略已按"开放优先"调整为**默认放行**：名单只保留两类——
 *  1. 本应用**没有实现**的方法（放行也只会得到"未实现"，留着只会误导卡片）；
 *  2. 与沙箱本身冲突的逃逸入口（`parent` / `top` / `eval` / `fetch` 等），
 *     它们的可用性由 iframe 的**不透明源**与隔离文档的 **CSP** 决定，
 *     名单在这里只是把"已被结构性阻断"这件事明确回给卡片。
 *
 * 真正的安全边界是 iframe 的 sandbox（不给 allow-same-origin）与 `default-src 'none'`，
 * 不是这份名单——名单拦不住结构性访问，结构性访问也不需要名单来拦。
 */
export const CARD_API_DENYLIST = [
  // 未实现：放行也只会得到"未实现"，保留以免卡片误判环境
  "generate", "generateRaw", "injectPrompts", "injectPromptsInMode", "getPrompts",
  "installExtension", "updateExtension", "uninstallExtension", "getExtensionStatus",
  "getTavernHelperVersion", "updateTavernHelper",
  "registerVariableSchema", "updateVariablesWith",
  // 逃逸入口：由不透明源与 CSP 结构性阻断，这里给出明确答复
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
  const rejected: string[] = [];
  for (const part of parts) {
    const match = /^\/([\w-]+)\s*([\s\S]*)$/.exec(part);
    if (!match) continue;
    const name = match[1]!.toLowerCase();
    const rest = match[2]!.trim();
    if (!SUPPORTED_SLASH.has(name)) { rejected.push(name); continue; }
    if (name === "trigger") { await host.onTrigger?.(); continue; }
    if (name === "cut") {
      // 允许 `/cut` 不带参数（默认删当前最后一条），也允许显式 id 或 "last"。
      const messageId = rest && rest !== "last" ? rest : host.messages.at(-1)?.id;
      if (messageId) await host.onDeleteMessage?.(messageId);
      continue;
    }
    // send / send-as-user / sys → 以用户身份发送
    if (rest) host.onSend(rest);
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
 * 注入隔离文档的桥脚本：在卡片脚本运行前挂上这些全局函数。
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
  window.waitGlobalInitialized = function () { return Promise.resolve(); };
})();`;
