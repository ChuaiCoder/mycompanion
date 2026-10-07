import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ConversationDetail } from "@mycompanion/shared";
import { buildCardDocument, buildCardPanelScript, buildCardStorageScript, cardStorageKey, CARD_HEIGHT_MESSAGE, CARD_HEIGHT_SCRIPT, CARD_IFRAME_CSP, CARD_IFRAME_SANDBOX, CARD_PANEL_MESSAGE, CARD_PANEL_STORAGE_KEY, CARD_STORAGE_MESSAGE, CARD_STORAGE_PREFIX, persistCardPanelPosition, persistCardStorage, readCardPanelPosition, readCardStorage } from "../frontend-card-frame";
import { frontendCardOf, hasCardScript } from "../frontend-card";
import { ChatView, type ChatViewProps } from "./ChatView";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("emits only inline scripts that actually parse", () => {
  // 这个坑踩过两次，原因都是 <script> 是 raw text 元素：内容里只要出现结束标签序列
  // （哪怕是在 JS 字符串或 CSS 选择器里），解析器就立刻结束该脚本、把剩下的代码当标记丢掉，
  // 于是脚本被截断成语法错误，而且没有任何报错指向真正的原因。
  // 实测：我自己的高度脚本里写了 `body > *[style*="100vh"]`，其中的 `</` 就触发了这个问题。
  // 这里逐个解析来锁住它。
  const document = buildCardDocument("<p>card</p>", "window.__runtime = 1;", { html: "</div><script>x</script>" });
  const blocks = [...document.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)].map(match => ({ attrs: match[1]!, body: match[2]! }));
  // 存储垫片 + 宿主数据 + 桥 + 运行时 + 高度脚本
  expect(blocks.length).toBeGreaterThanOrEqual(5);
  for (const [index, block] of blocks.entries()) {
    // 模块脚本允许顶层 await，不能用 Function 构造器解析——它由真实文档解析器负责。
    if (/type\s*=\s*"module"/.test(block.attrs)) continue;
    expect(() => new Function(block.body), `第 ${index} 个内联脚本必须是合法 JS`).not.toThrow();
  }
  for (const block of blocks) {
    expect(block.body).not.toMatch(/<\/script/i);
  }
});

const CARD = [
  "```html",
  "<html>",
  "<head>",
  "<style>body { background: #030a16 }</style>",
  "</head>",
  "<body>",
  '<div class="card">你好，旅人。</div>',
  "<script>document.title = 'x';</script>",
  "</body>",
  "</html>",
  "```",
].join("\r\n");

it("detects a whole-message fenced HTML document as a frontend card", () => {
  const card = frontendCardOf(CARD);
  expect(card).not.toBeNull();
  // 取出的必须是**未转义**的原文，围栏本身不能带进去。
  expect(card!.markup.startsWith("<html>")).toBe(true);
  expect(card!.markup).not.toContain("```");
  expect(hasCardScript(card!.markup)).toBe(true);
});

it("detects a bare document without a fence, but never a mere HTML snippet", () => {
  // 无围栏但具备文档级结构 → 视为前端卡（部分卡作者直接写文档）。
  expect(frontendCardOf("<html><head></head><body>x</body></html>")).not.toBeNull();
  // 教学用的 HTML 片段不是界面，不能被渲染成 iframe。
  expect(frontendCardOf('<div class="demo"><span>示例</span></div>')).toBeNull();
  expect(frontendCardOf('<p>一段 <body> 文字</p>')).toBeNull();
  // 普通 Markdown 与代码示例照常。
  expect(frontendCardOf("**粗体** 普通消息")).toBeNull();
  expect(frontendCardOf("```js\nconst a = 1;\n```")).toBeNull();
  expect(frontendCardOf("")).toBeNull();
});

it("seeds the card's storage from the host and reports changes back", () => {
  // 卡的界面状态（面板位置、存档选择等）靠 localStorage 跨文档保留。垫片若只存在内存里，
  // 每次文档重建都会回到初始值——实测小助手每次都会被弹回默认位置。
  const seeded = buildCardStorageScript({ local: { panelLeft: "240px" }, session: { picked: "3" } });
  // 已保存的值必须**同步内联**：卡在初始化阶段就读取，不能等异步通道。
  expect(seeded).toContain("panelLeft");
  expect(seeded).toContain("240px");
  expect(seeded).toContain("picked");
  // 每次写入都要回报宿主，否则退出后改动就丢了。
  expect(seeded).toContain(CARD_STORAGE_MESSAGE);
  expect(seeded).toContain("parent.postMessage");
  // 读回来的初始值要真的进入 map，而不只是躺在 SEED 里。
  const seedSection = seeded.slice(seeded.indexOf("var initial"), seeded.indexOf("function persist"));
  expect(seedSection).toContain("map[key] = String(initial[key])");

  // 文档里带上该故事的已存状态。
  const document = buildCardDocument("<p>card</p>", undefined, undefined, { local: { panelLeft: "240px" } });
  expect(document).toContain("panelLeft");
  // 按故事隔离的键，且 local / session 分开命名空间。
  expect(cardStorageKey("story-1", "local")).toBe(`${CARD_STORAGE_PREFIX}:local:story-1`);
  expect(cardStorageKey("story-1", "session")).not.toBe(cardStorageKey("story-1", "local"));
  expect(cardStorageKey("story-2", "local")).not.toBe(cardStorageKey("story-1", "local"));
});

it("persists and clears card storage per story on the host side", () => {
  // 宿主侧落盘：写入、删除单键、整表清空，且不同故事互不影响。
  const story = "11111111-1111-4111-8111-111111111111";
  const other = "22222222-2222-4222-8222-222222222222";

  persistCardStorage(story, { kind: "local", key: "panelLeft", value: "240px" });
  persistCardStorage(story, { kind: "local", key: "mode", value: "mvu" });
  expect(readCardStorage(story).local).toEqual({ panelLeft: "240px", mode: "mvu" });
  // 另一个故事保持干净。
  expect(readCardStorage(other).local).toEqual({});

  persistCardStorage(story, { kind: "local", key: "panelLeft", value: null });
  expect(readCardStorage(story).local).toEqual({ mode: "mvu" });

  persistCardStorage(story, { kind: "local", key: null, value: null });
  expect(readCardStorage(story).local).toEqual({});

  // 坏数据不能让卡起不来。
  window.localStorage.setItem(cardStorageKey(other, "local"), "{ not json");
  expect(readCardStorage(other).local).toEqual({});

  window.localStorage.removeItem(cardStorageKey(story, "local"));
  window.localStorage.removeItem(cardStorageKey(other, "local"));
});

it("remembers the card assistant's panel position, which the card itself never saves", () => {
  // 实测这张卡的配置助手把面板位置放在内联样式里，全文件只有出生地与模式两处写入，
  // 所以每次文档重建都回到默认值。酒馆助手自己的浮窗是会存的（TH-Dialog-<id>:pos），
  // 这里按同一思路代它记住。
  const script = buildCardPanelScript(CARD_PANEL_STORAGE_KEY, { left: 321, top: 654 });
  // 位置同步内联进去（助手可能在窗口 resize 前就要恢复）。
  expect(script).toContain(CARD_PANEL_STORAGE_KEY);
  expect(script).toContain("321");
  expect(script).toContain("654");
  // 只恢复一次，之后完全由卡掌控——卡若自己会恢复，它的值必须胜出。
  expect(script).toContain("if (restored || !SAVED) return");
  expect(script).toContain("restored = true");
  // 恢复时必须临时屏蔽过渡：否则气泡先按默认位置绘制、再动画过去，
  // 用户看到的就是"先出现在最开始的位置"（实测确认）。
  expect(script).toContain("transition:none !important");
  expect(script).toContain("offsetWidth");
  // 只接受像素值：卡默认写的是 40vh 这类视口单位，不能当像素读。
  expect(script).toContain("px$");
  // 恢复前夹进当前视口，与助手自己的边界处理同理。
  expect(script).toContain("clamp");
  expect(script).toContain("innerWidth");
  // 拖动与吸附都改内联样式，因此观察属性而不是介入它的事件。
  expect(script).toContain("MutationObserver");
  expect(script).toContain(CARD_PANEL_MESSAGE);

  // 首次运行没有存过位置时，注入 null，由卡用默认值。
  expect(buildCardPanelScript(CARD_PANEL_STORAGE_KEY, null)).toContain("var SAVED = null");

  // 宿主侧读写：按故事隔离、坏值不写入、坏数据不返回。
  const story = "33333333-3333-4333-8333-333333333333";
  expect(readCardPanelPosition(story)).toBeNull();
  persistCardPanelPosition(story, 120, 240);
  expect(readCardPanelPosition(story)).toEqual({ left: 120, top: 240 });
  // 非有限值、负值、非数值一律忽略，避免把坏坐标覆盖上去。
  persistCardPanelPosition(story, Number.NaN, 10);
  persistCardPanelPosition(story, -5, 10);
  persistCardPanelPosition(story, "120", 10);
  expect(readCardPanelPosition(story)).toEqual({ left: 120, top: 240 });

  window.localStorage.setItem(cardStorageKey(story, "local"), JSON.stringify({ [CARD_PANEL_STORAGE_KEY]: "{ broken" }));
  expect(readCardPanelPosition(story)).toBeNull();
  window.localStorage.removeItem(cardStorageKey(story, "local"));
});

it("lays the card's screens out at full width, one at a time", () => {
  // 实测：卡给这些"整屏"容器写的是 width:50%，原本靠 position:absolute 不参与流式排布
  // 才各自横向占满。为了修高度裁切把它们改成 relative 后，它们就成了 body（flex 容器）
  // 里的普通项——先各占一半并排（248+248），改成 auto 后又按内容收缩（345/150）。
  // 因此必须显式 width:100%，并把未激活的屏移出排布，否则两个屏会同时占位、把卡片拉长。
  const script = CARD_HEIGHT_SCRIPT;
  const screenRule = script.slice(script.indexOf('body > .screen{'), script.indexOf('body > .screen:not(.active)'));
  expect(screenRule).toContain('width:100% !important');
  expect(screenRule).not.toContain('width:auto !important');
  expect(screenRule).toContain('position:relative !important');
  expect(script).toContain('body > .screen:not(.active){display:none !important}');
});

it("allows card runtimes to load from their CDNs while still refusing navigation", () => {
  const document = buildCardDocument("<style>body{background:#000}</style><script>1</script>");
  // 卡片内容原样进入隔离文档（不消毒，否则文档级结构会被整段抹掉）。
  expect(document).toContain("<style>body{background:#000}</style>");
  expect(document).toContain("<script>1</script>");
  expect(document.startsWith("<!DOCTYPE html>")).toBe(true);
  // 网络已放开：卡片的运行时（如 MVU）就是从外部 CDN 加载的，禁止网络会让核心逻辑不执行。
  expect(CARD_IFRAME_CSP).toContain("script-src *");
  expect(CARD_IFRAME_CSP).toContain("connect-src *");
  expect(CARD_IFRAME_CSP).toContain("img-src *");
  // 卡自带运行时通过 Blob 模块 URL 加载；不透明源下是 `blob:null/…`，
  // 所以 script-src 必须包含 blob:，否则模块装载直接失败（实测过）。
  expect(CARD_IFRAME_CSP).toContain("script-src * blob:");
  // 仍然拒绝改基址与提交表单。
  expect(CARD_IFRAME_CSP).toContain("form-action 'none'");
  expect(CARD_IFRAME_CSP).toContain("base-uri 'none'");
  expect(document).toContain('http-equiv="Content-Security-Policy"');
  // 脚本能力保留（卡片自带动画与运行时依赖它）。
  expect(CARD_IFRAME_CSP).toContain("'unsafe-inline'");
  // 卡自带运行时需要访问宿主环境（SillyTavern/TavernHelper 桩件、父页面状态），
  // 因此沙箱按需求已加上 allow-same-origin。这移除了结构性隔离，影响记录在 spec §5.10。
  expect(CARD_IFRAME_SANDBOX).toContain("allow-scripts");
  expect(CARD_IFRAME_SANDBOX).toContain("allow-same-origin");
});

it("expands the frame to the card's real content height instead of clipping it", () => {
  // 卡片普遍写 body{min-height:100vh;overflow:hidden}：在 iframe 里 100vh 就是 iframe 高度，
  // 内容更高时会被裁掉。测量脚本必须把这个约束解开，并把内容高度上报给父页面。
  expect(CARD_HEIGHT_SCRIPT).toContain(CARD_HEIGHT_MESSAGE);
  expect(CARD_HEIGHT_SCRIPT).toContain("postMessage");
  // 解开 100vh 锁死的高度 / 裁切 / 垂直居中
  expect(CARD_HEIGHT_SCRIPT).toContain("min-height:0");
  expect(CARD_HEIGHT_SCRIPT).toContain("overflow:visible");
  expect(CARD_HEIGHT_SCRIPT).toContain("align-items:flex-start");
  // 持续跟随内容变化（卡片有入场动画与异步内容）
  expect(CARD_HEIGHT_SCRIPT).toContain("ResizeObserver");
  // 装饰性固定层不参与撑高，否则全屏 canvas 会把页面推成整屏
  expect(CARD_HEIGHT_SCRIPT).toContain("'fixed'");
});

it("inlines host data so that markup and line separators cannot break the script", () => {
  // 实测缺陷一：宿主数据里若含 `<script`（卡的开场白就是 HTML），HTML 解析器会在
  // 解析外层脚本时进入 escaped 状态并吞掉后续内容，实测脚本被截断在 19963 字符。
  // 实测缺陷二：U+2028/U+2029 不被 JSON.stringify 转义，在字符串字面量里非法。
  const hostGlobals = {
    html: "</div><script>const a = 1;</script>",
    text: "a\u2028b\u2029c",
  };
  const document = buildCardDocument("<p>card</p>", undefined, hostGlobals);
  const start = document.indexOf("Object.assign(window,");
  const script = document.slice(start, document.indexOf("</script>", start));

  // 内联的这块里不能再出现任何会终止或逃逸脚本的标记。
  expect(script).not.toContain("<script");
  expect(script).not.toContain("<!--");
  expect(document).not.toContain("\u2028");
  expect(document).not.toContain("\u2029");
  // 转义后仍是合法脚本，且数据能完整还原（含 `<script>` 与行分隔符）。
  expect(() => new Function(script)).not.toThrow();
  const literal = script.slice("Object.assign(window, ".length, script.lastIndexOf(")"));
  const parsed = JSON.parse(literal.replace(/\\u003c/g, "<").replace(/\\u2028/g, "\u2028").replace(/\\u2029/g, "\u2029"));
  expect(parsed).toEqual(hostGlobals);
});

it("gives card scripts a working storage shim instead of a hard SecurityError", () => {
  // 不透明源文档里 localStorage 会抛 SecurityError，而卡脚本常在初始化就读它，
  // 抛错会让整段脚本中断。实测确认 defineProperty 在该 sandbox 下可用，故由宿主提供实现。
  const shim = buildCardStorageScript();
  expect(shim).toContain("localStorage");
  expect(shim).toContain("sessionStorage");
  expect(shim).toContain("Object.defineProperty");
  expect(shim).toContain("configurable: true");
  // 垫片必须真的可用，而不只是把属性换成一个空对象。
  for (const method of ["getItem", "setItem", "removeItem", "clear"]) expect(shim).toContain(method);
  // 必须注入在卡片内容**之前**：卡脚本初始化阶段就要用。
  const document = buildCardDocument("<p>card</p>");
  expect(document.indexOf("createStorage")).toBeGreaterThan(-1);
  expect(document.indexOf("createStorage")).toBeLessThan(document.indexOf("<p>card</p>"));
  // 沙箱已按需求放开同源（见上一处说明）；存储垫片仍然保留，作为
  // 将来收紧沙箱时的兜底。
  expect(CARD_IFRAME_SANDBOX).toContain("allow-scripts");
});

it("never feeds the frame height back into the measurement", () => {
  // 实测过的无界自增：旧实现读 body.scrollHeight 并把它设回 body 的 min-height，
  // 而卡片的 min-height:100vh 让 scrollHeight 永远等于 frame 高度，
  // 于是 frame 一路涨到 14502px（真实内容只有 1552px）。
  expect(CARD_HEIGHT_SCRIPT).not.toContain("scrollHeight");
  // 注入的样式也不能给 body 设 min-height（撑高 body 会改变下一次测量）。
  expect(CARD_HEIGHT_SCRIPT).not.toMatch(/min-height:\s*'\s*\+\s*height/);
  expect(CARD_HEIGHT_SCRIPT).not.toContain("min-height:' + height");
});

it("renders an escaped fenced greeting as an isolated card instead of visible markup", () => {
  const conversation: ConversationDetail = {
    id: "story", characterId: "character", characterName: "道渊", title: "Story", lastMessagePreview: "x", messageCount: 1,
    activeBranchId: "branch", createdAt: "2026-10-02", updatedAt: "2026-10-02",
    messages: [{ id: "greeting", conversationId: "story", branchId: "branch", parentMessageId: null, role: "assistant", content: CARD, status: "complete", createdAt: "2026-10-02" }],
  };
  const noop = () => {};
  const props: ChatViewProps = {
    activeConversation: conversation, chatInput: "", isGenerating: false, generationControlsBusy: false, runtimeError: null,
    editingMessageId: null, editingDraft: "", activeCommands: [], lastLorebookReport: null, lastMemoryReport: null,
    lastPromptBudget: null, memoryPanelOpen: false, messageListRef: { current: null },
    onChatInput: noop, onSendMessage: noop, onStopGeneration: noop, onRegenerate: noop, onGenerate: noop, onEditMessage: noop,
    onEditingDraft: noop, onSaveEdit: noop, onCancelEdit: noop, onDeleteMessage: noop, onOpenSettings: noop,
    onGoToLibrary: noop, onMemoryPanelToggle: noop,
  };
  const { container } = render(<ChatView {...props} />);

  // 关键回归：开场白不再以降级成可见文本的形式出现。
  const mesText = container.querySelector(".mes_text");
  expect(mesText?.textContent ?? "").not.toContain("<html>");
  // 而是渲染成一个隔离子文档。
  const frame = container.querySelector<HTMLIFrameElement>(".frontend-card__frame");
  expect(frame).not.toBeNull();
  expect(frame!.getAttribute("sandbox")).toBe(CARD_IFRAME_SANDBOX);
  expect(frame!.srcdoc).toContain("你好，旅人。");
  // 卡片脚本存在时给出可见提示（黑名单模式下仍要告知边界）。
  expect(container.querySelector(".frontend-card__notice")).not.toBeNull();
});
