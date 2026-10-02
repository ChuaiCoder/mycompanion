import { describe, expect, it } from "vitest";
import { messageFormatting, reloadMarkdownProcessor } from "./message-rendering";

const fragment = (text: string): HTMLDivElement => {
  const element = document.createElement("div"); element.innerHTML = text; return element;
};
describe("message rendering", () => {
  it("renders actual Markdown blocks, tables, line breaks and literal code", () => {
    const html = messageFormatting('**粗体** and *emphasis*\nnext\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```html\n<div title="quoted">&amp;</div>\n```');
    const element = fragment(html);
    expect(element.querySelector("strong")?.textContent).toBe("粗体");
    expect(element.querySelector("em")?.textContent).toBe("emphasis");
    expect(element.querySelector("br")).not.toBeNull();
    expect(element.querySelectorAll("td")).toHaveLength(2);
    expect(element.querySelector("code")?.textContent).toBe('<div title="quoted">&amp;</div>\n');
    expect(element.querySelector("code div")).toBeNull();
  });
  it("marks dialogue without corrupting attributes or code", () => {
    const element = fragment(messageFormatting('“你好” 「再见」 "Hello" <a title="attribute" href="https://example.com">link</a> `"code"`'));
    expect(Array.from(element.querySelectorAll("q"), node => node.textContent)).toEqual(['“你好”', '「再见」', '"Hello"']);
    expect(element.querySelector("a")?.title).toBe("attribute");
    expect(element.querySelector("code q")).toBeNull();
  });
  it("sanitizes rendered HTML and preserves normal interactive markup", () => {
    const element = fragment(messageFormatting('<div><button data-command="go">Go</button><img src="x" onerror="alert(1)"><script>alert(1)</script><a href="javascript:alert(1)">x</a></div>'));
    expect(element.querySelector("button")?.dataset.command).toBe("go");
    expect(element.querySelector("script, [onerror], a[href]")).toBeNull();
    expect(messageFormatting("**hidden**", "Narrator", true)).toBe("<p><strong>hidden</strong></p>");
    expect(messageFormatting("<b>system</b>", "SillyTavern", true)).toBe("<b>system</b>");
  });
  it("exposes a working converter and handles empty text, greeting macros and sanitizer options", () => {
    expect(reloadMarkdownProcessor().makeHtml("# Heading")).toContain("<h1>Heading</h1>");
    expect(messageFormatting(null)).toBe("");
    expect(fragment(messageFormatting("{{char}} greets {{user}}", "<script>bad()</script>Ada", false, false, 0)).textContent).toBe("Ada greets User");
    expect(messageFormatting("{{char}}", "Ada", false, false, 1)).toContain("{{char}}");
    expect(messageFormatting("**text**", "", false, false, -1, { FORBID_TAGS: ["strong"] })).not.toContain("<strong>");
  });
});
