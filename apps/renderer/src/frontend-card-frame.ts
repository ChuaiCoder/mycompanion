// 前端卡的隔离渲染。
//
// 为什么隔离：卡片自带的 CSS 会直接写 `body`、`h1`、`:root` 这类选择器，放进主文档会
// 污染整个应用界面；卡片自带的脚本更不该拿到应用页面的任何东西。把它放进**不透明源
// iframe**（sandbox 只给 allow-scripts，不给 allow-same-origin）后：
//   - 同源策略直接切断它对父页面的访问，这是结构性边界，不依赖任何名单；
//   - CSS 天然只作用于该文档；
//   - 脚本照常运行（动画等能力保留）。

import { CARD_BRIDGE_SCRIPT } from "./frontend-card-bridge";

/**
 * iframe 的 sandbox。
 *
 * **已按要求加上 `allow-same-origin`，以便卡自带运行时能访问宿主环境。**
 * 这确实移除了唯一的结构性隔离：卡脚本因此可以读取应用页面（DOM、内存中的状态），
 * 也能直接调用本地服务的 HTTP 接口。保留它是为了让功能先跑通；
 * 相关影响记录在 spec §5.10，后续若要做防护，应在这里收紧并同时给本地服务加请求令牌。
 */
export const CARD_IFRAME_SANDBOX = "allow-scripts allow-same-origin";
/**
 * 隔离文档的内容安全策略。
 *
 * 网络已按需放开：卡片的运行时常常是**从外部 CDN 加载**的（实测这张卡的
 * `tavern_helper.scripts` 里有 3 条 import 指向 jsdelivr / 自有 CDN，MVU 就是其一），
 * 只允许内联脚本会让这些卡的核心逻辑完全不执行。
 *
 * 仍然保留的约束：
 *  - `base-uri 'none'` 与 `form-action 'none'`：不允许改基址或提交表单；
 *  - 其余能力靠 iframe 的**不透明源**兜底——文档与父页面不同源，脚本无法读取
 *    应用页面、`location` 或真实存储（storage 由内存垫片提供）。
 */
export const CARD_IFRAME_CSP = [
  "default-src * data: blob:",
  // 卡自带运行时（MVU 等）是通过 Blob 模块 URL 加载的；在不透明源文档里该 URL 形如
  // `blob:null/…`，因此 `script-src` 必须显式包含 `blob:`，否则模块装载直接失败
  // （实测报 "Failed to fetch dynamically imported module"）。
  "script-src * blob: 'unsafe-inline' 'unsafe-eval'",
  "style-src * 'unsafe-inline'",
  "img-src * data: blob:",
  "media-src * data: blob:",
  "font-src * data:",
  "connect-src *",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * 拼出隔离文档。
 *
 * 直接把卡片 HTML 放进 `srcdoc`（不做消毒）：消毒会把 `body`/`head` 这类文档级结构连同
 * 内容一起抹掉（实测整段变空），而且治不了 CSS 污染。隔离文档 + 不透明源才是正确的边界。
 */
/**
 * 内联脚本的安全化。
 *
 * `<script>` 标签里的内容是 raw text：只要出现 `</script`（不分大小写），HTML 解析器就会
 * 立刻结束这个脚本元素，后面的代码被当作标记文本丢掉——脚本因此被截断成语法错误，
 * 且不会有任何报错指向真正的原因。
 *
 * 这个坑本项目踩过两次（一次在宿主数据里的卡开场白，一次在我自己的高度脚本里），
 * 所以这里对**每一个**内联脚本统一处理：把 `</` 写成 `<\/`，JS 语义完全不变。
 */
function inlineScript(source: string): string {
  return source.replace(/<\/(script)/gi, "<\\/$1");
}

/**
 * 把宿主数据序列化成可安全内联进 `<script>` 的 JS 字面量。
 *
 * 两个都必须处理的陷阱（都实测踩到过）：
 *  1. **`<` 必须转义**。注入的 JSON 里若出现 `<script`，HTML 解析器会在解析外层脚本时
 *     进入 "script data escaped" 状态，把之后的内容一直吞到 EOF——实测宿主数据脚本
 *     因此在 19963 字符处被截断，`Object.assign` 从未执行，其后的桥脚本与全部卡脚本
 *     也一并失效。卡的开场白本身就是 HTML，内含 `<script>` 的概率很高。
 *  2. **U+2028 / U+2029**：`JSON.stringify` 不转义它们，而它们在 JS 字符串字面量里非法。
 */
function toInlineLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function buildCardDocument(
  markup: string,
  runtimeSource?: string,
  hostGlobals?: Record<string, unknown>,
  /** 该故事已保存的卡存储（local/session），在卡片初始化前同步注入。 */
  cardStorage?: Record<string, Record<string, string>>,
  /** 已保存的浮动面板位置（宿主代卡的助手记住的），缺省表示首次运行。 */
  panelPosition?: { left: number; top: number } | null,
): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${CARD_IFRAME_CSP}">`;
  return [
    "<!DOCTYPE html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    meta,
    "<style>",
    // 卡片常按整屏尺寸设计，但它在聊天里是一块内容，需要给它一个稳定的盒子。
    "*,*::before,*::after{box-sizing:border-box}",
    "html,body{margin:0;padding:0}",
    "body{min-height:100%}",
    "</style>",
    "</head>",
    "<body>",
    // 存储垫片必须在卡片脚本之前：卡脚本常在初始化阶段就读 localStorage。
    // 已保存的值同步内联进去——卡是同步读取的，不能等异步通道。
    `<script>${inlineScript(buildCardStorageScript(cardStorage))}</script>`,
    // 宿主数据（当前故事、角色、聊天记录）先落到全局，桥脚本的桩件会读它们。
    ...(hostGlobals ? [`<script>${inlineScript(`Object.assign(window, ${toInlineLiteral(hostGlobals)});`)}</script>`] : []),
    // 桥要在卡片脚本之前挂好，否则卡片的 `typeof getChatMessages !== 'undefined'` 判断
    // 会走降级分支；桩件（SillyTavern / TavernHelper）也必须先于卡自带运行时存在。
    `<script>${inlineScript(CARD_BRIDGE_SCRIPT)}</script>`,
    // 卡自带运行时（MVU 等）作为**模块**加载：它们是 ES module，且需要读取上面挂好的全局。
    // module 是延迟执行的，所以卡脚本里对运行时的使用必须是运行时判断（卡的脚本普遍如此）。
    ...(runtimeSource ? [`<script type="module">${inlineScript(runtimeSource)}</script>`] : []),
    markup,
    // 浮动面板位置由宿主代记：卡自己没存（见 buildCardPanelScript 的说明）。
    // 放在卡的内容之后，让它能在卡挂载出面板时立刻观察与恢复。
    `<script>${inlineScript(buildCardPanelScript(CARD_PANEL_STORAGE_KEY, panelPosition ?? null))}</script>`,
    `<script>${inlineScript(CARD_HEIGHT_SCRIPT)}</script>`,
    "</body>",
    "</html>",
  ].join("\n");
}

/** 子文档发给父页面的高度消息类型。 */
export const CARD_HEIGHT_MESSAGE = "mycompanion:card-height";

/** 子文档把 `localStorage` 的改动同步回宿主时使用的消息类型。 */
export const CARD_STORAGE_MESSAGE = "mycompanion:card-storage";

/**
 * 子文档请求宿主持久化一个**浮动面板的位置**时使用的消息类型。
 *
 * 与存储垫片分开：这不是卡自己写的 localStorage，而是宿主代它记住的界面状态，
 * 因此用独立通道，便于将来卡自己实现持久化时直接停用这一项。
 */
export const CARD_PANEL_MESSAGE = "mycompanion:card-panel";

/** 卡存储里保存浮动面板位置的键。 */
export const CARD_PANEL_STORAGE_KEY = "mycompanion:panel-position";

/**
 * 代理第三方助手记住浮动面板位置。
 *
 * 为什么需要：实测这张卡的配置助手把面板位置放在**内联样式**里（`bubble.style.left/top`），
 * 全文件只有两处 `setItem`（出生地、模式），位置从未落盘，所以每次文档重建都回到默认值。
 * 而酒馆助手自己的浮窗是**会存**的（`Dialog.vue`：`TH-Dialog-<id>:pos` 存 `{left, top}`，
 * 挂载时读取、拖动时保存、恢复后夹进视口）。这里按同一思路补上它缺的那一步。
 *
 * 三条约束：
 *  1. **只在本页首次出现时恢复一次**：之后完全由卡自己掌控。若卡将来自己实现了恢复，
 *     它会在我们之后再设一次样式，从而覆盖我们的值——以卡为准，不打架。
 *  2. **只接受像素值**：卡默认写的是 `40vh` 这类视口单位，忽略它，避免把视口单位当像素读。
 *  3. **恢复前夹进当前视口**：窗口变小后旧坐标可能落在屏幕外，与助手自己的
 *     `checkAndAdjustBounds` 同理。
 */
export function buildCardPanelScript(storageKey: string, stored: { left: number; top: number } | null): string {
  return `(function () {
  var MESSAGE = ${JSON.stringify(CARD_PANEL_MESSAGE)};
  var STORAGE_KEY = ${JSON.stringify(storageKey)};
  var SAVED = ${toInlineLiteral(stored)};
  var BUBBLE_ID = 'bp-switch-bubble';
  var host = null;
  try { host = window.parent && window.parent !== window ? window.parent : null; } catch (error) { host = null; }
  if (!host || !host.document) return;
  var restored = false;
  var observed = null;

  function pixels(value) {
    var text = String(value == null ? '' : value).trim();
    if (!/^-?[0-9.]+px$/.test(text)) return null;
    var number = parseFloat(text);
    return isFinite(number) ? number : null;
  }

  /** 把位置夹进当前视口；卡自己的越界回退逻辑同样会这么做。 */
  function clamp(left, top, element) {
    var width = element.offsetWidth || 66;
    var height = element.offsetHeight || 88;
    var viewportWidth = host.innerWidth || host.document.documentElement.clientWidth || 0;
    var viewportHeight = host.innerHeight || host.document.documentElement.clientHeight || 0;
    if (viewportWidth > 0) left = Math.max(0, Math.min(left, Math.max(0, viewportWidth - width)));
    if (viewportHeight > 0) top = Math.max(0, Math.min(top, Math.max(0, viewportHeight - height)));
    return { left: left, top: top };
  }

  function restore(element) {
    if (restored || !SAVED) return;
    restored = true;
    if (typeof SAVED.left !== 'number' || typeof SAVED.top !== 'number') return;
    var position = clamp(SAVED.left, SAVED.top, element);
    // 卡给气泡设了 transition: left/top。若直接改样式，会先按默认位置绘制、再动画到保存位置，
    // 看起来就是"先出现在最开始的位置"（实测确认）。恢复期间临时屏蔽过渡，让它直接落到目标位置。
    var suppress = null;
    try {
      suppress = host.document.createElement('style');
      suppress.textContent = '#' + BUBBLE_ID + '{transition:none !important}';
      (host.document.head || host.document.documentElement).appendChild(suppress);
      element.style.left = position.left + 'px';
      element.style.top = position.top + 'px';
      // 强制重排：让上面的值成为过渡的**起点**，否则解除屏蔽后仍会补一段动画。
      void element.offsetWidth;
    } catch (error) {
      // 插入样式失败时退回到直接赋值：位置仍然正确，可能多一段过渡动画。
      element.style.left = position.left + 'px';
      element.style.top = position.top + 'px';
    }
    if (suppress) {
      // 下一帧再移除，确保浏览器已经以最终位置绘制过一帧。
      (host.requestAnimationFrame || function (fn) { return host.setTimeout(fn, 16); })(function () {
        try { suppress.remove(); } catch (error) {}
      });
    }
  }

  function report(element) {
    var left = pixels(element.style.left);
    var top = pixels(element.style.top);
    // 卡默认写的是视口单位（如 40vh）：不把它当成像素存下来。
    if (left === null || top === null) return;
    var position = clamp(left, top, element);
    try { host.postMessage({ type: MESSAGE, key: STORAGE_KEY, left: position.left, top: position.top }, '*'); } catch (error) {}
  }

  function watch(element) {
    if (!element || observed === element) return;
    observed = element;
    restore(element);
    // 拖动与吸附都会改写内联样式，因此观察属性即可，无需介入它的事件处理。
    if (typeof host.MutationObserver === 'function') {
      new host.MutationObserver(function () { report(element); }).observe(element, { attributes: true, attributeFilter: ['style'] });
    }
  }

  watch(host.document.getElementById(BUBBLE_ID));
  // 助手是异步挂载气泡的（模块要等 CDN 加载），因此还要等它出现。
  if (typeof host.MutationObserver === 'function') {
    new host.MutationObserver(function () { watch(host.document.getElementById(BUBBLE_ID)); })
      .observe(host.document.body || host.document.documentElement, { childList: true, subtree: true });
  }
})();`;
}

/**
 * 宿主侧保存卡 `localStorage` 的键前缀。
 *
 * 卡的界面状态（面板位置、存档选择、出生地、MVU 模式等）本来就靠 `localStorage` 跨会话保留；
 * 若垫片只存在内存里，文档一重建就全部清零——实测可拖动的小助手每次切故事都会弹回默认位置。
 * `sessionStorage` 与 `localStorage` 分开命名空间，与浏览器语义保持一致。
 */
export const CARD_STORAGE_PREFIX = "mycompanion:card-storage";

/** 取某个故事的内嵌存储键；作用域按故事隔离，符合"每段对话是一次新游戏"。 */
export function cardStorageKey(conversationId: string, kind: "local" | "session"): string {
  return `${CARD_STORAGE_PREFIX}:${kind}:${conversationId}`;
}

/** 读取该故事已保存的卡存储；缺失或损坏时返回空表，绝不让卡因为坏数据起不来。 */
export function readCardStorage(conversationId: string): { local: Record<string, string>; session: Record<string, string> } {
  const read = (kind: "local" | "session"): Record<string, string> => {
    try {
      const raw = window.localStorage.getItem(cardStorageKey(conversationId, kind));
      if (!raw) return {};
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string") out[key] = value;
      }
      return out;
    } catch {
      return {};
    }
  };
  return { local: read("local"), session: read("session") };
}

/** 读取宿主代记的浮动面板位置；没有或数据不可用时返回 null（由卡用它自己的默认值）。 */
export function readCardPanelPosition(conversationId: string): { left: number; top: number } | null {
  try {
    const raw = readCardStorage(conversationId).local[CARD_PANEL_STORAGE_KEY];
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const { left, top } = parsed as { left?: unknown; top?: unknown };
    if (typeof left !== "number" || typeof top !== "number") return null;
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
    // 负值说明存下来的数据已不可信（窗口尺寸变化等），交给卡自己决定。
    if (left < 0 || top < 0) return null;
    return { left, top };
  } catch {
    return null;
  }
}

/** 保存宿主代记的浮动面板位置；数值不合法时忽略，避免把坏坐标写进去。 */
export function persistCardPanelPosition(conversationId: string, left: unknown, top: unknown): void {
  if (typeof left !== "number" || typeof top !== "number") return;
  if (!Number.isFinite(left) || !Number.isFinite(top) || left < 0 || top < 0) return;
  // 与卡自己的存储走同一条落盘路径，因此切故事/重载后一并恢复。
  persistCardStorage(conversationId, {
    kind: "local",
    key: CARD_PANEL_STORAGE_KEY,
    value: JSON.stringify({ left: Math.round(left), top: Math.round(top) }),
  });
}

/**
 * 落盘一次卡存储改动。
 *
 * `value === null` 表示删除该键；`key === null` 表示整表清空。写盘失败不抛出：
 * 卡的界面状态不值得让一次聊天渲染崩掉，保留内存中的值继续用即可。
 */
export function persistCardStorage(
  conversationId: string,
  change: { kind: "local" | "session"; key: string | null; value: string | null },
): void {
  try {
    const key = cardStorageKey(conversationId, change.kind);
    const current: unknown = JSON.parse(window.localStorage.getItem(key) ?? "{}");
    const table: Record<string, string> = current && typeof current === "object" && !Array.isArray(current)
      ? { ...(current as Record<string, string>) }
      : {};
    if (change.key === null) {
      for (const existing of Object.keys(table)) delete table[existing];
    } else if (change.value === null) {
      delete table[change.key];
    } else {
      table[change.key] = change.value;
    }
    if (Object.keys(table).length === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(table));
  } catch {
    // 忽略：存储不可用（配额、隐私模式）时卡仍应正常工作，只是状态不跨文档保留。
  }
}

/**
 * 构造注入隔离文档的存储垫片。
 *
 * 不透明源文档里访问 `localStorage` / `sessionStorage` 会直接抛 SecurityError，
 * 而卡脚本常在初始化阶段就读它（实测：一张卡在 `updateArchiveSelect` 里读取，
 * 抛错后整段脚本中断，后续界面逻辑全不执行），因此必须由宿主提供实现。
 *
 * 持久化方式：宿主在构建文档时把已保存的键值**内联注入**（卡在初始化阶段是同步读取的，
 * 不能等异步通道），此后每次写入再通过 postMessage 同步回宿主落盘。这样既保证同步语义，
 * 又让状态跨文档重建保留。
 */
export function buildCardStorageScript(seed: Record<string, Record<string, string>> = {}): string {
  return `(function () {
  var MESSAGE = ${JSON.stringify(CARD_STORAGE_MESSAGE)};
  var SEED = ${toInlineLiteral(seed)};
  var DEBUG = typeof location !== 'undefined' && location.hash.indexOf('card-storage-debug') >= 0;
  function createStorage(kind) {
    var map = Object.create(null);
    var initial = (SEED && SEED[kind]) || {};
    for (var key in initial) { if (Object.prototype.hasOwnProperty.call(initial, key)) map[key] = String(initial[key]); }
    function persist(key, value) {
      try { parent.postMessage({ type: MESSAGE, kind: kind, key: key, value: value }, '*'); } catch (error) {}
      // 只记录"实际发生了持久化"的键名，不含值：卡常把整份存档写进来，值可能很大。
      if (DEBUG) console.info('[card-storage] ' + kind + ' 已保存 ' + key);
    }
    return {
      getItem: function (key) { key = String(key); return key in map ? map[key] : null; },
      setItem: function (key, value) { key = String(key); value = String(value); map[key] = value; persist(key, value); },
      removeItem: function (key) { key = String(key); delete map[key]; persist(key, null); },
      clear: function () { map = Object.create(null); persist(null, null); },
      key: function (index) { var keys = Object.keys(map); return index >= 0 && index < keys.length ? keys[index] : null; },
      get length() { return Object.keys(map).length; }
    };
  }
  var local = createStorage('local');
  var session = createStorage('session');
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    var shim = name === 'localStorage' ? local : session;
    try {
      Object.defineProperty(window, name, { configurable: true, enumerable: true, get: function () { return shim; } });
    } catch (error) {
      // 定义失败时保持浏览器原行为（抛出同样的 SecurityError），不静默改变语义。
    }
  });
})();`;
}

/**
 * 注入到隔离文档里的高度上报脚本。
 *
 * 为什么由子文档自己测：iframe 是不透明源，父页面读不到 `contentDocument`，必须由子文档
 * 测量后 postMessage 上报。
 *
 * 两条必须遵守的约束（都来自实测）：
 *  1. **绝不能读滚动高度**。卡片普遍把最小高度写成视口单位，而视口单位在 iframe 里等于
 *     frame 高度；若再把它作为新的 frame 高度上报，就会形成"帧变高 → 视口变大 → 上报更大"
 *     的无界自增（实测一度涨到 14502px，远超 1552px 的真实内容）。所以只量**排布子元素的
 *     真实范围**，它只取决于内容。
 *  2. **不要给 body 强制最小高度**。撑高 body 会改变下一次测量，同样构成反馈。
 *     只覆盖会让内容被裁或错位的几条属性：溢出、对齐、高度。
 */
export const CARD_HEIGHT_SCRIPT = `(function () {
  var TYPE = ${JSON.stringify(CARD_HEIGHT_MESSAGE)};
  var PADDING = 2;

  function post(height) {
    if (!isFinite(height) || height <= 0) return;
    try { parent.postMessage({ type: TYPE, height: Math.ceil(height) }, '*'); } catch (error) {}
  }

  // 解开卡片的"整屏"约束。
  //
  // 实测这张卡的布局：start-screen 与 character-creation-screen 是 position:absolute，
  // 所以它们**不参与 body 文档流**；100vh 在 iframe 里等于 frame 高度（实测 420px），
  // 于是创建屏被锁成 378px 高、且带 overflow:auto——它的滚动内容高 2399px，
  // 确认按钮位于滚动区第 2030px 处。用户根本看不到按钮，卡脚本对自身尺寸的判断也会失真。
  // 对策：让这些"整屏"元素改为按内容撑高，帧高再跟着内容增长。
  // 刻意不设 body 的 min-height —— 那会让 body 撑高并改变下一次测量，形成反馈。
  function relaxViewportUnits() {
    var style = document.getElementById('mycompanion-card-height');
    if (!style) {
      style = document.createElement('style');
      style.id = 'mycompanion-card-height';
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = [
      'body{min-height:0 !important;height:auto !important;overflow:visible !important;align-items:flex-start !important}',
      // 绝对定位的"整屏"容器：取消视口高度锁与裁切，并让它们参与布局高度计算。
      'body > .screen{position:relative !important;height:auto !important;max-height:none !important;min-height:0 !important;overflow:visible !important;top:auto !important;left:auto !important;right:auto !important;bottom:auto !important;transform:none !important}',
    ].join(String.fromCharCode(10));
  }

  /** 排布子元素的真实范围；固定/绝对定位的装饰层不参与。 */
  function contentExtent() {
    var children = document.body ? document.body.children : [];
    var top = Infinity, bottom = 0;
    for (var i = 0; i < children.length; i++) {
      var el = children[i];
      if (getComputedStyle(el).position === 'fixed') continue;
      var rect = el.getBoundingClientRect();
      if (rect.height <= 0 && rect.width <= 0) continue;
      var childTop = rect.top + window.scrollY;
      if (childTop < top) top = childTop;
      if (childTop + rect.height > bottom) bottom = childTop + rect.height;
    }
    if (!isFinite(top) || bottom <= 0) return 0;
    return bottom - Math.max(top, 0);
  }

  function measure() {
    relaxViewportUnits();
    var height = contentExtent();
    if (height > 0) post(height + PADDING);
  }

  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    (window.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); })(function () { scheduled = false; measure(); });
  }

  function start() {
    measure();
    if (typeof ResizeObserver === 'function') new ResizeObserver(schedule).observe(document.body);
    window.addEventListener('load', schedule);
    window.addEventListener('resize', schedule);
    // 卡片常带入场动画与异步内容，多测几次直到稳定。
    [60, 200, 600, 1500].forEach(function (delay) { setTimeout(schedule, delay); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();`;
