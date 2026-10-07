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

export function buildCardDocument(markup: string, runtimeSource?: string, hostGlobals?: Record<string, unknown>): string {
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
    `<script>${CARD_STORAGE_SCRIPT}</script>`,
    // 宿主数据（当前故事、角色、聊天记录）先落到全局，桥脚本的桩件会读它们。
    ...(hostGlobals ? [`<script>${`Object.assign(window, ${toInlineLiteral(hostGlobals)});`}</script>`] : []),
    // 桥要在卡片脚本之前挂好，否则卡片的 `typeof getChatMessages !== 'undefined'` 判断
    // 会走降级分支；桩件（SillyTavern / TavernHelper）也必须先于卡自带运行时存在。
    `<script>${CARD_BRIDGE_SCRIPT}</script>`,
    // 卡自带运行时（MVU 等）作为**模块**加载：它们是 ES module，且需要读取上面挂好的全局。
    // module 是延迟执行的，所以卡脚本里对运行时的使用必须是运行时判断（卡的脚本普遍如此）。
    ...(runtimeSource ? [`<script type="module">${runtimeSource}</script>`] : []),
    markup,
    `<script>${CARD_HEIGHT_SCRIPT}</script>`,
    "</body>",
    "</html>",
  ].join("\n");
}

/** 子文档发给父页面的高度消息类型。 */
export const CARD_HEIGHT_MESSAGE = "mycompanion:card-height";

/**
 * 注入隔离文档的存储垫片。
 *
 * 不透明源文档里访问 `localStorage` / `sessionStorage` 会直接抛 SecurityError，
 * 而卡脚本常在初始化阶段就读它（实测：一张卡在 `updateArchiveSelect` 里读取，
 * 抛错后整段脚本中断，后续界面逻辑全不执行）。
 *
 * 实测确认（在同款 sandbox iframe 里）：`Object.defineProperty(window,'localStorage',{configurable:true,get})`
 * 是允许的，因此可以给它一个内存实现，让卡脚本正常读写，而**不需要**加上
 * allow-same-origin（那会让卡脚本能访问应用页面）。
 * 数据只存在该文档的内存里：刷新即空，也不会写入用户真实存储。
 */
export const CARD_STORAGE_SCRIPT = `(function () {
  function createStorage() {
    var map = Object.create(null);
    return {
      getItem: function (key) { key = String(key); return key in map ? map[key] : null; },
      setItem: function (key, value) { map[String(key)] = String(value); },
      removeItem: function (key) { delete map[String(key)]; },
      clear: function () { map = Object.create(null); },
      key: function (index) { var keys = Object.keys(map); return index >= 0 && index < keys.length ? keys[index] : null; },
      get length() { return Object.keys(map).length; }
    };
  }
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    var shim = createStorage();
    try {
      Object.defineProperty(window, name, { configurable: true, enumerable: true, get: function () { return shim; } });
    } catch (error) {
      // 定义失败时保持浏览器原行为（抛出同样的 SecurityError），不静默改变语义。
    }
  });
})();`;

/**
 * 注入到隔离文档里的高度上报脚本。
 *
 * 为什么由子文档自己测：iframe 是不透明源，父页面读不到 `contentDocument`，必须由子文档
 * 测量后 postMessage 上报。
 *
 * 两条必须遵守的约束（都来自实测）：
 *  1. **绝不能读 `scrollHeight`**。卡片普遍写 `body{min-height:100vh}`，而 `100vh` 在 iframe 里
 *     等于 frame 高度；若再把它作为新的 frame 高度上报，就会形成 `frame ↑ → 100vh ↑ → 上报 ↑`
 *     的无界自增（实测一度涨到 14502px，远超 1552px 的真实内容）。所以只量**排布子元素的
 *     真实范围**，它只取决于内容。
 *  2. **不要给 body 设 `min-height`**。撑高 body 会改变下一次测量，同样构成反馈。
 *     只覆盖会让内容被裁或错位的三条属性：`overflow`、`align-items`、`height`。
 */
export const CARD_HEIGHT_SCRIPT = `(function () {
  var TYPE = ${JSON.stringify(CARD_HEIGHT_MESSAGE)};
  var PADDING = 2;

  function post(height) {
    if (!isFinite(height) || height <= 0) return;
    try { parent.postMessage({ type: TYPE, height: Math.ceil(height) }, '*'); } catch (error) {}
  }

  // 解开卡片的"整屏"约束：100vh 锁死的高度、裁切、以及会错位的垂直居中。
  // 刻意不设 min-height —— 那会让 body 撑高，进而改变下一次测量，形成反馈。
  function relaxViewportUnits() {
    var style = document.getElementById('mycompanion-card-height');
    if (!style) {
      style = document.createElement('style');
      style.id = 'mycompanion-card-height';
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = 'body{min-height:0 !important;height:auto !important;overflow:visible !important;align-items:flex-start !important}';
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
