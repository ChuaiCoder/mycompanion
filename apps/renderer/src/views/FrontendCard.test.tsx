import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ConversationDetail } from "@mycompanion/shared";
import { buildCardDocument, CARD_HEIGHT_MESSAGE, CARD_HEIGHT_SCRIPT, CARD_IFRAME_CSP, CARD_IFRAME_SANDBOX, CARD_STORAGE_SCRIPT } from "../frontend-card-frame";
import { frontendCardOf, hasCardScript } from "../frontend-card";
import { ChatView, type ChatViewProps } from "./ChatView";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

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

it("keeps the card markup but blocks the network and outside navigation in the sandboxed document", () => {
  const document = buildCardDocument("<style>body{background:#000}</style><script>1</script>");
  // 卡片内容原样进入隔离文档（不消毒，否则文档级结构会被整段抹掉）。
  expect(document).toContain("<style>body{background:#000}</style>");
  expect(document).toContain("<script>1</script>");
  expect(document.startsWith("<!DOCTYPE html>")).toBe(true);
  // 网络与导航必须拒绝：这是能力黑名单的前提，卡脚本不能把数据发出去。
  expect(CARD_IFRAME_CSP).toContain("default-src 'none'");
  expect(CARD_IFRAME_CSP).toContain("connect-src 'none'");
  expect(CARD_IFRAME_CSP).toContain("form-action 'none'");
  expect(document).toContain('http-equiv="Content-Security-Policy"');
  // 脚本能力保留（卡片自带动画等依赖它）。
  expect(CARD_IFRAME_CSP).toContain("script-src 'unsafe-inline'");
  // 沙箱不能给 allow-same-origin，否则卡脚本可直接访问父页面。
  expect(CARD_IFRAME_SANDBOX).toBe("allow-scripts");
  expect(CARD_IFRAME_SANDBOX).not.toContain("allow-same-origin");
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
  // 不能为了存储而放宽沙箱。
  expect(CARD_IFRAME_SANDBOX).not.toContain("allow-same-origin");
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
    onChatInput: noop, onSendMessage: noop, onStopGeneration: noop, onRegenerate: noop, onEditMessage: noop,
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
  expect(frame!.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame!.srcdoc).toContain("你好，旅人。");
  // 卡片脚本存在时给出可见提示（黑名单模式下仍要告知边界）。
  expect(container.querySelector(".frontend-card__notice")).not.toBeNull();
});
