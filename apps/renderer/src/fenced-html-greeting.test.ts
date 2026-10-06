import { describe, expect, it } from "vitest";
import fixtureSource from "../../../examples/cards/fenced-html-greeting.card.json?raw";
import { messageFormatting } from "./message-rendering";

// 复现：前端卡式开场白被包在 ```html 围栏里时，会被 markdown-it 当成**代码块**，
// 于是整段 HTML 被转义、以裸标签形式显示在聊天里（而不是渲染成界面）。
//
// 直接读仓库里的可导入夹具，保证「文档说的」和「应用看到的」是同一份内容。
const card = JSON.parse(fixtureSource) as { data: { first_mes: string; name: string } };
const fm = card.data.first_mes;

/** 去掉首尾围栏行，取出内部 HTML。 */
function unfence(text: string): string {
  return text.replace(/^```[a-z]*\r?\n/i, "").replace(/\r?\n```\s*$/, "");
}

describe("fenced HTML greeting（复现）", () => {
  it("ships an importable fixture whose opening message is one fenced HTML document", () => {
    expect(card.data.name).toBe("围栏卡复现");
    // 围栏必须真的存在，否则这份夹具复现不了问题。
    expect(fm.startsWith("```html\n")).toBe(true);
    expect(fm.trimEnd().endsWith("```")).toBe(true);
    expect(fm).toContain("<style>");
    expect(fm).toContain("仙途将启");
    // 去掉围栏后应当就是一整份 HTML 文档。
    const inner = unfence(fm);
    expect(inner.startsWith("<html>")).toBe(true);
    expect(inner.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("renders the whole document as an escaped code block instead of a card", () => {
    const host = document.createElement("div");
    host.innerHTML = messageFormatting(fm, card.data.name, false, false, 0);

    // 症状 1：整段被当成代码块。
    expect(host.querySelector("pre code")).not.toBeNull();
    // 症状 2：标签以**可见文本**出现（裸 <html><style> 就是这么来的）。
    expect(host.textContent).toContain("<html>");
    expect(host.textContent).toContain("<style>");
    // 症状 3：没有渲染成真正的元素，样式也没生效。
    expect(host.querySelector("style")).toBeNull();
    expect(host.querySelector(".card")).toBeNull();
    // 正文被埋进代码块里，而不是显示成一张卡片。
    expect(host.textContent).toContain("仙途将启");
  });

  it("documents why simply removing the fence is not enough either", () => {
    // 顺带固定住第二个事实：去掉围栏后，以 <html>/<head> 开头的文档级输入会被
    // DOMPurify **整段清空**（不是"剥掉外壳只留正文"）。所以修复不能只是解围栏，
    // 还必须先把外层文档结构摘掉再交给消毒器。
    expect(messageFormatting(unfence(fm), card.data.name, false, false, 0)).toBe("");
  });
});
