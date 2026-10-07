import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ConversationDetail } from "@mycompanion/shared";
import { buildCardDocument, CARD_HEIGHT_MESSAGE, CARD_HEIGHT_SCRIPT, CARD_IFRAME_CSP, CARD_IFRAME_SANDBOX, CARD_STORAGE_SCRIPT } from "../frontend-card-frame";
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
  // 抛错会让整段脚本中断。实测确认 defineProperty 在该 sandbox 下可用，故用内存垫片。
  expect(CARD_STORAGE_SCRIPT).toContain("localStorage");
  expect(CARD_STORAGE_SCRIPT).toContain("sessionStorage");
  expect(CARD_STORAGE_SCRIPT).toContain("Object.defineProperty");
  expect(CARD_STORAGE_SCRIPT).toContain("configurable: true");
  // 垫片必须真的可用，而不只是把属性换成一个空对象。
  for (const method of ["getItem", "setItem", "removeItem", "clear"]) expect(CARD_STORAGE_SCRIPT).toContain(method);
  // 必须注入在卡片内容**之前**：卡脚本初始化阶段就要用。
  const document = buildCardDocument("<p>card</p>");
  expect(document.indexOf(CARD_STORAGE_SCRIPT)).toBeGreaterThan(-1);
  expect(document.indexOf(CARD_STORAGE_SCRIPT)).toBeLessThan(document.indexOf("<p>card</p>"));
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
