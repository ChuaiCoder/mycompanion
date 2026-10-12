// 前端卡的独立文档渲染。
//
// 为什么用独立子文档（srcdoc iframe）：卡片自带的 CSS 会直接写 `body`、`h1`、`:root`
// 这类选择器，放进主文档会污染整个应用界面；独立文档让卡片 CSS 只作用于卡片自身，
// 同时脚本照常运行（动画等能力保留）。
//
// 注意：这里**不提供安全边界**。按产品决策（spec §5.10），卡脚本是可信的高权限代码——
// sandbox 含 allow-same-origin，卡脚本可以访问应用页面并直接调用本地服务接口。

import { CARD_BRIDGE_SCRIPT } from "./frontend-card-bridge";

/**
 * iframe 的 sandbox。
 *
 * **按产品决策（spec §5.10）保留 `allow-same-origin`**：卡脚本被视为可信的高权限代码，
 * 可以读取应用页面（DOM、内存中的状态），也能直接调用本地服务的 HTTP 接口——
 * 卡自带运行时依赖这些能力（SillyTavern/TavernHelper 桩件、父页面状态）。
 * 因此安全边界不在"应用 vs 卡"，而在"应用 vs 外部"：本地服务只监听回环地址，
 * 对外部进程／网页的防护由请求令牌承担；卡在同源渲染层内运行，天然持有令牌，不受影响。
 */
export const CARD_IFRAME_SANDBOX = "allow-scripts allow-same-origin";
/**
 * 卡片文档的内容安全策略。
 *
 * 网络已按需放开：卡片的运行时常常是**从外部 CDN 加载**的（实测这张卡的
 * `tavern_helper.scripts` 里有 3 条 import 指向 jsdelivr / 自有 CDN，MVU 就是其一），
 * 只允许内联脚本会让这些卡的核心逻辑完全不执行。
 *
 * 仍然保留的约束只有 `base-uri 'none'` 与 `form-action 'none'`（不允许改基址或提交表单）。
 * 这份 CSP **不是安全边界**：文档与父页面同源（见 CARD_IFRAME_SANDBOX），脚本可以读取
 * 应用页面与 `location`；卡存储由宿主垫片按故事隔离（见 buildCardStorageScript）。
 */
export const CARD_IFRAME_CSP = [
  "default-src * data: blob:",
  // 卡自带运行时（MVU 等）是通过 Blob 模块 URL 加载的；`script-src` 必须显式包含
  // `blob:`，否则模块装载直接失败（实测报 "Failed to fetch dynamically imported module"）。
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
 * 拼出卡片文档。
 *
 * 直接把卡片 HTML 放进 `srcdoc`（不做消毒）：消毒会把 `body`/`head` 这类文档级结构连同
 * 内容一起抹掉（实测整段变空）。独立子文档的作用是隔离 CSS 与文档结构；
 * 它不是安全边界——卡脚本是可信代码（见 CARD_IFRAME_SANDBOX）。
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
  /** 浮动面板位置的宿主存档（按角色卡）；缺省表示首次运行，由卡用默认值。 */
  panel?: { characterId: string; positions: CardPanelPositions | null },
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
    `<script>${inlineScript(buildCardPanelScript(CARD_PANEL_STORAGE_KEY, panel?.characterId ?? "", panel?.positions ?? null))}</script>`,
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

/** 面板位置消息里的键名（位置实际存在 `CARD_PANEL_POSITION_PREFIX` 下，按角色卡记忆）。 */
export const CARD_PANEL_STORAGE_KEY = "mycompanion:panel-position";

/**
 * 一个浮动面板的存档位置。`at` 是保存时的时间戳：重建文档内联的存档可能落后于
 * 拖动途中的最新值（流式期间文档每个 delta 都重建），守卫按它只采纳更新的存档。
 */
export interface CardPanelPosition {
  left: number;
  top: number;
  at: number;
}

/** 各浮动面板的存档：`bubble` 是悬浮球（launcher），`panel` 是点开后的配置面板。 */
export interface CardPanelPositions {
  bubble?: CardPanelPosition;
  panel?: CardPanelPosition;
}

/**
 * 代理第三方助手记住浮动面板位置。
 *
 * 为什么需要：实测这张卡的配置助手（远程脚本 道渊配置小助手.min.js）把悬浮球与面板
 * 挂到**父页面文档**（`p.document.body`，p = window.parent），位置写在**内联样式**里
 * （`bubble.style.left/top`），从未落盘，所以每次文档重建都回到默认值（气泡
 * `left:60px; top:40vh`，面板 `left:110px; top:35vh`）。酒馆助手自己的浮窗
 * （`Dialog.vue`）是另一种架构：位置是组件状态、DOM 只是投影，存储只在拖动结束等
 * 显式事件里写（`TH-Dialog-<id>:pos`），恢复在挂载时同步完成——卡的任何代码都插不进来。
 *
 * 我们改不了卡，只能把这个思路移植到宿主侧，三条对应关系：
 *  1. **页面级单例**：守卫装在父页面全局（`__mycompanionPanelGuard`），全页只有一套
 *     监听器；卡文档重建时新脚本按角色 id 决定是整表替换（换了卡）还是按时间戳采纳
 *     （同一张卡的重建——内联存档可能比拖动中的内存值旧，绝不用旧值覆盖新值）。
 *  2. **让卡的写入打不进来**：位置用 `!important` CSS 规则锁定，而不是改内联样式——
 *     卡的初始化/重建写任何默认值都赢不了 `!important`；选择器按 id 匹配，元素
 *     销毁重建也自动生效。悬浮球与配置面板是两个独立目标，各锁各的。
 *  3. **拖动途中就记值**：用户 `pointerdown` 落在目标上才解锁（先把锁定位置写成内联
 *     样式防止跳变），`pointermove` 期间持续把 px 位置记入内存（带时间戳），
 *     `pointerup` 后等吸附动画停稳再落盘并重新上锁。这样即使松手后的 800ms 窗口里
 *     文档被重建（新元素内联样式是默认值、vh 单位读不出 px），拖动成果也不会丢——
 *     实测"发消息后弹回最初位置"正是这个竞态。
 */
export function buildCardPanelScript(storageKey: string, characterId: string, stored: CardPanelPositions | null): string {
  return `(function () {
  var MESSAGE = ${JSON.stringify(CARD_PANEL_MESSAGE)};
  var STORAGE_KEY = ${JSON.stringify(storageKey)};
  var CHARACTER_ID = ${JSON.stringify(characterId)};
  var SAVED = ${toInlineLiteral(stored)};
  var LOCK_ID = 'mycompanion:panel-lock';
  var TARGETS = { bubble: 'bp-switch-bubble', panel: 'bp-switch-panel' };
  var host = null;
  try { host = window.parent && window.parent !== window ? window.parent : null; } catch (error) { host = null; }
  if (!host || !host.document) return;

  function now() { return Date.now(); }
  function valid(pos) { return pos && typeof pos.left === 'number' && typeof pos.top === 'number'; }
  function at(pos) { return pos && typeof pos.at === 'number' && isFinite(pos.at) ? pos.at : 0; }
  function adoptable(pos) { return valid(pos) ? { left: pos.left, top: pos.top, at: at(pos) } : null; }

  // 守卫已存在（卡文档重建）：换了卡就整表替换（无存档也要清，否则上一张卡的坐标
  // 会被锁到这张卡的气泡上）；同一张卡的重建按时间戳采纳，内联旧值不覆盖内存新值。
  var existing = host.__mycompanionPanelGuard;
  if (existing) {
    if (existing.characterId !== CHARACTER_ID) existing.reset(SAVED);
    else existing.adopt(SAVED);
    existing.relock();
    return;
  }

  var positions = { bubble: null, panel: null };
  var dragging = null;

  function pixels(value) {
    var text = String(value == null ? '' : value).trim();
    if (!/^-?[0-9.]+px$/.test(text)) return null;
    var number = parseFloat(text);
    return isFinite(number) ? number : null;
  }

  /** 把位置夹进当前视口；卡自己的越界回退逻辑同样会这么做。 */
  function clamp(key, left, top) {
    var el = host.document.getElementById(TARGETS[key]);
    var width = el && el.offsetWidth || 66;
    var height = el && el.offsetHeight || 88;
    var viewportWidth = host.innerWidth || host.document.documentElement.clientWidth || 0;
    var viewportHeight = host.innerHeight || host.document.documentElement.clientHeight || 0;
    if (viewportWidth > 0) left = Math.max(0, Math.min(left, Math.max(0, viewportWidth - width)));
    if (viewportHeight > 0) top = Math.max(0, Math.min(top, Math.max(0, viewportHeight - height)));
    return { left: left, top: top };
  }

  // 锁定用一条 CSS 规则（id 选择器 + !important），正在拖动的目标不锁。
  function relock() {
    var stale = host.document.getElementById(LOCK_ID);
    if (stale) { try { stale.remove(); } catch (error) {} }
    var css = '';
    for (var key in TARGETS) {
      if (key === dragging) continue;
      var pos = positions[key];
      if (!pos) continue;
      var clamped = clamp(key, pos.left, pos.top);
      pos.left = clamped.left; pos.top = clamped.top;
      css += '#' + TARGETS[key] + '{left:' + pos.left + 'px !important;top:' + pos.top + 'px !important;transition:none !important;}';
    }
    if (!css) return;
    try {
      var rule = host.document.createElement('style');
      rule.id = LOCK_ID;
      rule.textContent = css;
      (host.document.head || host.document.documentElement).appendChild(rule);
    } catch (error) {}
  }

  function targetOf(event) {
    for (var key in TARGETS) {
      var el = host.document.getElementById(TARGETS[key]);
      if (el && (event.target === el || el.contains(event.target))) return key;
    }
    return null;
  }

  host.document.addEventListener('pointerdown', function (event) {
    var key = targetOf(event);
    if (!key) return;
    dragging = key;
    // 解锁前把锁定位置写成内联样式：否则解锁瞬间元素跳回卡的默认值再被拖走。
    var pos = positions[key];
    var el = host.document.getElementById(TARGETS[key]);
    if (pos && el) {
      el.style.left = pos.left + 'px';
      el.style.top = pos.top + 'px';
      void el.offsetWidth;
    }
    relock();
  }, true);

  // 拖动途中持续把 px 位置记入内存：松手后即使文档立刻重建（新元素内联是默认值），
  // 最后已知位置仍在，不会读不到值而丢弃整次拖动。
  host.document.addEventListener('pointermove', function () {
    if (!dragging) return;
    var el = host.document.getElementById(TARGETS[dragging]);
    if (!el) return;
    var left = pixels(el.style.left);
    var top = pixels(el.style.top);
    if (left === null || top === null) return;
    positions[dragging] = { left: left, top: top, at: now() };
  }, true);

  host.document.addEventListener('pointerup', scheduleFinish, true);
  // 拖动被系统打断（触摸取消、窗口失焦）时 pointerup 不触发：cancel 同样收尾。
  host.document.addEventListener('pointercancel', scheduleFinish, true);

  function scheduleFinish() {
    if (!dragging) return;
    var key = dragging;
    dragging = null;
    // 吸附动画在松手后仍写 px：等它停稳再读最终位置。
    setTimeout(function () { finishDrag(key); }, 800);
  }

  function finishDrag(key) {
    // 等待期间用户又抓住了面板：推迟到这次拖动结束，绝不在拖动途中读值/上锁。
    if (dragging) { setTimeout(function () { finishDrag(key); }, 300); return; }
    // DOM 读得出 px 就刷新内存值（保留原时间戳）；读不出（重建后的 vh 默认值）
    // 就落拖动途中记下的最后已知位置——两种来源都不会丢。
    var el = host.document.getElementById(TARGETS[key]);
    if (el) {
      var left = pixels(el.style.left);
      var top = pixels(el.style.top);
      if (left !== null && top !== null) {
        var prev = positions[key];
        positions[key] = { left: left, top: top, at: prev ? prev.at : now() };
      }
    }
    var pos = positions[key];
    if (pos) {
      var clamped = clamp(key, pos.left, pos.top);
      pos.left = clamped.left; pos.top = clamped.top;
      try { host.postMessage({ type: MESSAGE, key: STORAGE_KEY, target: key, left: pos.left, top: pos.top, at: pos.at }, '*'); } catch (error) {}
    }
    relock();
  }

  // 窗口尺寸变化后重新夹取并锁定。
  host.addEventListener('resize', function () { if (!dragging) relock(); });

  host.__mycompanionPanelGuard = {
    characterId: CHARACTER_ID,
    relock: relock,
    // 同卡重建：逐目标按时间戳采纳，内存里的新拖动成果优先于内联旧存档。
    adopt: function (incoming) {
      for (var key in TARGETS) {
        var inc = incoming ? adoptable(incoming[key]) : null;
        if (inc && (!positions[key] || inc.at > positions[key].at)) positions[key] = inc;
      }
    },
    // 换卡：整表替换（含 null），绝不把上一张卡的坐标锁到这张卡上。
    reset: function (incoming) {
      for (var key in TARGETS) positions[key] = incoming ? adoptable(incoming[key]) : null;
    },
  };
  for (var key in TARGETS) positions[key] = SAVED ? adoptable(SAVED[key]) : null;
  relock();
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

/**
 * 浮动面板位置的存储键前缀。
 *
 * 面板位置是**界面偏好**而非游戏存档，因此按**角色卡**记忆（同一张卡无论开多少
 * 新故事都保持用户调好的位置），与按故事隔离的卡存储（`CARD_STORAGE_PREFIX`）分开。
 */
export const CARD_PANEL_POSITION_PREFIX = "mycompanion:panel-position";

/** 浮动面板目标的合法名字（悬浮球 / 配置面板）。 */
export type CardPanelTarget = "bubble" | "panel";

function validPanelEntry(value: unknown): CardPanelPosition | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { left, top, at } = value as { left?: unknown; top?: unknown; at?: unknown };
  if (typeof left !== "number" || typeof top !== "number") return null;
  if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
  // 负值说明存下来的数据已不可信（窗口尺寸变化等），交给卡自己决定。
  if (left < 0 || top < 0) return null;
  return { left, top, at: typeof at === "number" && Number.isFinite(at) ? at : 0 };
}

/** 读取宿主代记的浮动面板位置；没有或数据不可用时返回 null（由卡用它自己的默认值）。 */
export function readCardPanelPositions(characterId: string): CardPanelPositions | null {
  try {
    const raw = window.localStorage.getItem(`${CARD_PANEL_POSITION_PREFIX}:${characterId}`);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    // 旧版存档是单个 {left, top}（只有气泡）：迁成 bubble 条目，时间戳记 0，
    // 任何一次新的拖动都会凭更大的 at 盖过它。
    const legacy = validPanelEntry(parsed);
    const record = parsed as { bubble?: unknown; panel?: unknown };
    const bubble = validPanelEntry(record.bubble) ?? legacy;
    const panel = validPanelEntry(record.panel);
    if (!bubble && !panel) return null;
    return { ...(bubble ? { bubble } : {}), ...(panel ? { panel } : {}) };
  } catch {
    return null;
  }
}

/**
 * 保存宿主代记的浮动面板位置；数值不合法时忽略，避免把坏坐标写进去。
 *
 * `at` 是拖动方记值的时间戳：只有更新的存档才覆盖旧的——松手后的落盘与文档重建
 * 可能乱序到达，绝不让旧值把新拖动成果顶掉。
 */
export function persistCardPanelPosition(characterId: string, target: unknown, left: unknown, top: unknown, at: unknown): void {
  if (target !== "bubble" && target !== "panel") return;
  if (typeof left !== "number" || typeof top !== "number") return;
  if (!Number.isFinite(left) || !Number.isFinite(top) || left < 0 || top < 0) return;
  const stamp = typeof at === "number" && Number.isFinite(at) ? at : Date.now();
  try {
    const key = `${CARD_PANEL_POSITION_PREFIX}:${characterId}`;
    const existing = readCardPanelPositions(characterId) ?? {};
    const current = existing[target];
    if (current && current.at > stamp) return;
    const next: CardPanelPositions = {
      ...existing,
      [target]: { left: Math.round(left), top: Math.round(top), at: stamp },
    };
    window.localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // 忽略：存储不可用（配额、隐私模式）时面板仍可拖动，只是位置不保留。
  }
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
 * 构造注入卡片文档的存储垫片。
 *
 * 为什么需要垫片：卡文档与父页面**同源**，不用垫片时卡的 localStorage 会直接落在应用
 * 自己的存储上——不同故事的卡互相串数据，也会污染应用自身的键。垫片把卡的读写接管到
 * 按故事隔离的命名空间（见 CARD_STORAGE_PREFIX），由宿主代管。同步语义同样必要：
 * 卡脚本常在初始化阶段就读 localStorage（实测：一张卡在 `updateArchiveSelect` 里读取），
 * 不能等异步通道。
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
      // 定义失败时保持浏览器原行为，不静默改变语义。
    }
  });
})();`;
}

/**
 * 注入到卡片文档里的高度上报脚本。
 *
 * 为什么由子文档自己测：测量的两条硬性约束（不读滚动高度、不撑高 body，见下）与
 * "整屏"样式的放宽都发生在子文档里，就近测量再 postMessage 上报最简单，
 * 也不依赖父页面能否访问 `contentDocument`。
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
      // 绝对定位的"整屏"容器：取消视口高度锁与裁切，并让**当前显示的**那一屏参与布局高度。
      //
      // 两个要点（都是实测得出的）：
      //  1. 必须给 width:100%，否则它们会成为 body（flex 容器）里的普通 flex 项而按内容收缩，
      //     实测两块各占 345px / 150px。
      //  2. 卡用 .active 类互斥切换这些屏，但原来的 position:absolute 让**所有**屏都横向占满、
      //     彼此叠放。改成 relative 后它们会同时参与排布（两个屏会并排或上下堆叠，加长页面）。
      //     所以把未激活的屏直接移出排布；卡切换 .active 时状态随之变化。
      'body > .screen{position:relative !important;width:100% !important;height:auto !important;max-height:none !important;min-height:0 !important;overflow:visible !important;top:auto !important;left:auto !important;right:auto !important;bottom:auto !important;transform:none !important}',
      'body > .screen:not(.active){display:none !important}',
    ].join(String.fromCharCode(10));
  }

  /** 排布子元素的真实范围；固定/绝对定位的装饰层不参与。 */
  function contentExtent() {
    var children = document.body ? document.body.children : [];
    var top = Infinity, bottom = 0;
    for (var i = 0; i < children.length; i++) {
      var el = children[i];
      // 固定/绝对定位的装饰层不参与（卡片的"整屏"容器已被上方规则改为 relative）。
      var positioned = getComputedStyle(el).position;
      if (positioned === 'fixed' || positioned === 'absolute') continue;
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
