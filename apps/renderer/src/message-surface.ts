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
  private source: ChatMessage[] = [];
  private name = "";
  private firstIndex = 0;
  private order: string[] = [];
  readonly more = document.createElement("button");

  constructor() {
    this.auxiliary.style.display = "contents";
    this.more.id = "show_more_messages"; this.more.type = "button";
    this.more.className = "button button--quiet";
    this.more.addEventListener("click", () => {
      const container = this.container, height = container?.scrollHeight ?? 0, top = container?.scrollTop ?? 0;
      flushSync(() => this.loadMore());
      if (container) container.scrollTop = top + container.scrollHeight - height;
      window.dispatchEvent(new CustomEvent("mycompanion:more-messages-loaded"));
    });
  }
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
    this.reconcile(conversation?.messages ?? [], conversation?.characterName ?? "", scope);
  }
  loadMore() {
    this.firstIndex = Math.max(0, this.firstIndex - 100);
    this.reconcile(this.source, this.name, this.scope ?? "");
  }
  ensureVisible(messageId: string) {
    const index = this.source.findIndex(message => message.id === messageId);
    if (index < 0 || index >= this.firstIndex) return;
    this.firstIndex = Math.max(0, index - index % 100);
    this.reconcile(this.source, this.name, this.scope ?? "");
  }
  private reconcile(incoming: ChatMessage[], name: string, scope: string, reset = false) {
    const switched = scope !== this.scope;
    const firstId = this.source[this.firstIndex]?.id;
    const indices = new Map(incoming.map((message, index) => [message.id, index]));
    if (switched || reset) {
      this.container?.replaceChildren(); this.rows = []; this.previous.clear(); this.order = []; this.scope = scope;
      this.firstIndex = Math.max(0, incoming.length - 100);
    } else if (incoming !== this.source && firstId && indices.has(firstId)) this.firstIndex = indices.get(firstId)!;
    this.source = incoming; this.name = name;
    const ids = new Set(indices.keys());
    let changed = switched || reset;
    this.rows = this.rows.filter(row => {
      if (row.element.parentNode !== this.container || (this.previous.has(row.message.id) && !ids.has(row.message.id))) {
        row.element.remove(); changed = true; return false;
      }
      return true;
    });
    // Removal needs the last synchronized IDs. Dropping them first makes a
    // deleted persisted row indistinguishable from a pending extension add.
    for (const id of this.previous.keys()) if (!ids.has(id)) this.previous.delete(id);
    const rows = new Map(this.rows.map(row => [row.message.id, row]));
    // Explicit extension add/swipe may reveal an older message. Preserve that
    // capability while the default window stays at the recent 100 messages.
    const requested = new Set(this.rows.map(row => row.message.id));
    const visible = incoming.filter((message, index) => index >= this.firstIndex || requested.has(message.id));
    for (const message of visible) {
      const index = indices.get(message.id)!;
      const row = rows.get(message.id);
      // 流式增量下未变化的消息保持引用稳定（chat-stream-utils 只替换目标消息），
      // 引用相同即内容与名字相同：跳过重签名与属性重写，避免每个 delta 都对全部
      // 可见消息各做一次 JSON.stringify。
      if (row && row.message === message && row.name === name && row.index === index) {
        if (!this.previous.has(message.id)) this.previous.set(message.id, "");
        continue;
      }
      const signature = JSON.stringify([message, name]);
      if (!row && !this.previous.has(message.id)) {
        const created = this.row(message, index, name);
        rows.set(message.id, created);
        this.container?.insertBefore(created.element, this.auxiliary.parentNode === this.container ? this.auxiliary : null);
        changed = true;
      } else if (row && (JSON.stringify([row.message, row.name]) !== signature || row.index !== index)) {
        row.message = message; row.index = index; row.name = name; this.attributes(row); changed = true;
      }
      this.previous.set(message.id, signature);
    }
    const order = visible.map(message => message.id);
    if (order.length !== this.order.length || order.some((id, index) => id !== this.order[index])) {
      const fragment = document.createDocumentFragment();
      for (const message of visible) {
        const row = rows.get(message.id);
        if (row) fragment.append(row.element);
      }
      this.container?.insertBefore(fragment, this.auxiliary.parentNode === this.container ? this.auxiliary : null);
    }
    this.order = order;
    if (this.firstIndex > 0) {
      this.more.textContent = `加载更早消息（${this.firstIndex} 条）`;
      this.more.dataset.remaining = String(this.firstIndex); this.container?.prepend(this.more);
    } else this.more.remove();
    if (switched || reset) this.container?.append(this.auxiliary);
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
    this.reconcile(messages.map(raw => this.project(raw, context)), context.name2 ?? "", `${context.conversationId ?? ""}/${context.branchId ?? ""}`, true);
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
