import MarkdownIt from "markdown-it";
import DOMPurify, { type Config } from "dompurify";

// The application and extension bridge share these exact library instances.
export { DOMPurify };
let converter: { makeHtml(text: string): string };
export function reloadMarkdownProcessor(): typeof converter {
  const parser = new MarkdownIt({ html: true, breaks: true });
  // The helper calls makeHtml; rendering uses a maintained parser rather than
  // Showdown 2.1.0's unpatched link-parsing ReDoS. This is not its full SDK.
  converter = { makeHtml: text => parser.render(text) };
  return converter;
}
reloadMarkdownProcessor();
type RegexFormatter = (text: string, name: string, isSystem: boolean, isUser: boolean, messageId: number, isReasoning: boolean) => string;
let regexFormatter: RegexFormatter = text => text;
export function configureRegexFormatting(formatter: RegexFormatter): void { regexFormatter = formatter; }

// Work on rendered text nodes so quoted HTML attributes, fenced code and
// extension markup are never rewritten by a regex over the HTML source.
function markDialogue(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    if (node.parentElement?.closest("pre, code, q, style, script, textarea")) continue;
    const matches = [...node.data.matchAll(/"[^"\n]*"|“[^”\n]*”|«[^»\n]*»|「[^」\n]*」|『[^』\n]*』|＂[^＂\n]*＂/gu)];
    if (!matches.length) continue;
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const match of matches) {
      fragment.append(node.data.slice(offset, match.index));
      const quote = document.createElement("q"); quote.textContent = match[0]; fragment.append(quote);
      offset = match.index + match[0].length;
    }
    fragment.append(node.data.slice(offset)); node.replaceWith(fragment);
  }
  return template.innerHTML;
}

export function messageFormatting(
  value: unknown, name = "", isSystem = false, isUser = false, messageId = -1,
  sanitizerOverrides: Config = {}, isReasoning = false,
): string {
  let text = String(value ?? "");
  if (!text) return "";
  text = regexFormatter(text, name, isSystem, isUser, Number(messageId), isReasoning);
  if (Number(messageId) === 0 && !isSystem && !isUser && !isReasoning) {
    text = text.replace(/{{\s*char\s*}}/gi, () => name).replace(/{{\s*user\s*}}/gi, "User");
  }
  const rawSystemHtml = isSystem && name === "SillyTavern";
  const html = rawSystemHtml ? text : markDialogue(converter.makeHtml(text));
  return DOMPurify.sanitize(html, {
    ...sanitizerOverrides,
    RETURN_DOM: false, RETURN_DOM_FRAGMENT: false, RETURN_TRUSTED_TYPE: false,
  }).trim();
}

export function renderMessageContent(element: HTMLElement, text: string, name: string, isSystem: boolean, isUser: boolean, messageId: number): void {
  element.innerHTML = messageFormatting(text, name, isSystem, isUser, messageId);
}
