import { flushSync } from "react-dom";
import type { ChatMessage, ConversationDetail, ExtensionChatMessage } from "@mycompanion/shared";

export interface SurfaceRow {
  element: HTMLElement;
  message: ChatMessage;
  index: number;
  name: string;
  key: number;
}
interface SurfaceContext { conversationId?: string; branchId?: string; name2?: string }
interface AddOptions { type?: string; insertAfter?: number | null; insertBefore?: number | null; forceId?: number | null; scroll?: boolean; showSwipes?: boolean }
let current: MessageSurface | undefined;

/** React owns each message's contents through a portal. The visible outer nodes
 * belong to the surface, so extensions may insert/remove/reorder them directly. */
export class MessageSurface {
  rows: SurfaceRow[] = [];
  readonly auxiliary = document.createElement("div");
  private container: HTMLElement | null = null;
  private notify = () => {};
  private scope: string | undefined;
  private sequence = 0;
  private previous = new Map<string, string>();

  constructor() { this.auxiliary.style.display = "contents"; }
  bind(element: HTMLElement, notify: () => void): () => void {
    this.container = element; this.notify = notify; current = this;
    element.append(this.auxiliary);
    return () => { if (current === this) current = undefined; this.container = null; };
  }
  private attributes(row: SurfaceRow) {
    const { element, message, index } = row;
    element.classList.add("mes", "chat-message");
    for (const role of ["user", "assistant"]) element.classList.toggle(`chat-message--${role}`, message.role === role);
    for (const status of ["failed", "stopped"]) element.classList.toggle(`chat-message--${status}`, message.status === status);
    element.setAttribute("mesid", String(index)); element.dataset.messageId = message.id;
    element.setAttribute("is_user", String(message.role === "user"));
    element.setAttribute("is_system", String(message.extensionData?.is_system === true));
  }
  private row(message: ChatMessage, index: number, name: string): SurfaceRow {
    const row = { element: document.createElement("article"), message, index, name, key: ++this.sequence };
    this.attributes(row); this.rows.push(row); return row;
  }
  private last() {
    const elements = this.container?.querySelectorAll(":scope > .mes");
    elements?.forEach(element => element.classList.remove("last_mes"));
    elements?.item(elements.length - 1)?.classList.add("last_mes");
  }
  clear() {
    this.container?.replaceChildren(); this.rows = []; this.notify();
  }
  sync(conversation: ConversationDetail | null) {
    const scope = conversation ? `${conversation.id}/${conversation.activeBranchId}` : "";
    const switched = scope !== this.scope;
    if (switched) { this.container?.replaceChildren(); this.rows = []; this.previous.clear(); this.scope = scope; }
    const incoming = conversation?.messages ?? [], ids = new Set(incoming.map(message => message.id));
    let changed = switched;
    this.rows = this.rows.filter(row => {
      if (row.element.parentNode !== this.container || (this.previous.has(row.message.id) && !ids.has(row.message.id))) {
        row.element.remove(); changed = true; return false;
      }
      return true;
    });
    for (const [index, message] of incoming.entries()) {
      const name = conversation!.characterName, signature = JSON.stringify([message, name]);
      const row = this.rows.find(row => row.message.id === message.id);
      if (!row && !this.previous.has(message.id)) {
        const created = this.row(message, index, name);
        const after = this.rows.find(row => row.index > index && row.element.parentNode === this.container);
        this.container?.insertBefore(created.element, after?.element ?? (this.auxiliary.parentNode === this.container ? this.auxiliary : null));
        changed = true;
      } else if (row && (this.previous.get(message.id) !== signature || row.index !== index)) {
        row.message = message; row.index = index; row.name = name; this.attributes(row); changed = true;
      }
    }
    if ([...this.previous.keys()].join('/') !== incoming.map(message => message.id).join('/')) {
      for (const message of incoming) {
        const row = this.rows.find(row => row.message.id === message.id && row.element.parentNode === this.container);
        if (row) this.container?.insertBefore(row.element, this.auxiliary.parentNode === this.container ? this.auxiliary : null);
      }
    }
    this.previous = new Map(incoming.map(message => [message.id, JSON.stringify([message, conversation!.characterName])]));
    if (switched) this.container?.append(this.auxiliary);
    this.last(); if (changed) this.notify();
  }
  private project(raw: ExtensionChatMessage, context: SurfaceContext): ChatMessage {
    raw.id ||= crypto.randomUUID();
    const { id, mes, is_user, status, role: _role, content: _content, ...extensionData } = raw;
    return { id, conversationId: context.conversationId ?? "", branchId: context.branchId ?? "", parentMessageId: null,
      content: mes ?? "", role: is_user ? "user" : "assistant", status: status === "streaming" || status === "failed" || status === "stopped" ? status : "complete",
      createdAt: typeof raw.send_date === "string" ? raw.send_date : new Date().toISOString(), extensionData };
  }
  print(messages: ExtensionChatMessage[], context: SurfaceContext) {
    this.container?.replaceChildren(); this.rows = [];
    messages.forEach((raw, index) => this.container?.append(this.row(this.project(raw, context), index, context.name2 ?? "").element));
    this.container?.append(this.auxiliary); this.last(); this.notify();
  }
  add(raw: ExtensionChatMessage, index: number, options: AddOptions, context: SurfaceContext): HTMLElement {
    const existing = options.type === "swipe" ? this.rows.find(row => row.element.parentNode === this.container && Number(row.element.getAttribute("mesid")) === index) : undefined;
    const message = this.project(raw, context);
    if (existing) {
      existing.message = message; existing.name = context.name2 ?? ""; existing.index = index; this.attributes(existing);
      this.notify(); return existing.element;
    }
    const row = this.row(message, index, context.name2 ?? "");
    const after = options.insertAfter, before = options.insertBefore;
    if (typeof after === "number" && after >= 0) this.container?.querySelector(`:scope > .mes[mesid="${after}"]`)?.after(row.element);
    else if (typeof before === "number" && before >= 0) this.container?.querySelector(`:scope > .mes[mesid="${before}"]`)?.before(row.element);
    else this.container?.insertBefore(row.element, this.auxiliary.parentNode === this.container ? this.auxiliary : null);
    this.last(); this.notify(); return row.element;
  }
}

function surface(): MessageSurface { if (!current) throw new Error("消息界面尚未挂载。"); return current; }
export const messageSurface = {
  clear() { flushSync(() => surface().clear()); },
  print(messages: ExtensionChatMessage[], context: SurfaceContext) { flushSync(() => surface().print(messages, context)); },
  add(message: ExtensionChatMessage, index: number, options: AddOptions, context: SurfaceContext) {
    let element!: HTMLElement; flushSync(() => { element = surface().add(message, index, options, context); }); return element;
  },
};
