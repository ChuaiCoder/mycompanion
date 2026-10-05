import type { MemoryRecord } from "@mycompanion/shared";
import { memorySimilarity } from "./memory-engine.js";

export type MemoryRelationKind = NonNullable<MemoryRecord["reconciliation"]>["kind"];
export interface MemoryRelation {
  kind: MemoryRelationKind;
  action: "keep" | "pending" | "supersede";
  reason: string;
}

const normalize = (value: string) => value.normalize("NFC").trim().replace(/\s+/gu, " ");
export const isProtectedMemory = (memory: MemoryRecord): boolean => memory.pinned
  || memory.manuallyEdited === true || memory.previousContent !== null || memory.sourceMessageIds.length === 0;

/** Lexical overlap only discovers uncertain candidates. It is not semantic evidence. */
export function classifyMemoryRelation(old: MemoryRecord, incoming: MemoryRecord, evidence: {
  laterSources?: boolean;
  verifiedTransition?: boolean;
} = {}): MemoryRelation {
  const left = old.claim, right = incoming.claim;
  if (old.type !== incoming.type && !(left && right)) {
    return { kind: "unrelated", action: "keep", reason: "记忆类型不同且无完整结构化依据，保留各自来源。" };
  }
  // Repeated events may have identical wording while describing different occurrences.
  const distinctEvents = left?.temporality === "event" && right?.temporality === "event"
    && !incoming.sourceMessageIds.some(id => old.sourceMessageIds.includes(id));
  if (!distinctEvents && normalize(old.content) === normalize(incoming.content)) {
    return { kind: "duplicate", action: "pending", reason: "正文相同，保留原记忆；新来源保存在待确认记录中。" };
  }
  if (left && right) {
    if (normalize(left.subject) !== normalize(right.subject) || normalize(left.predicate) !== normalize(right.predicate)) {
      return { kind: "unrelated", action: "keep", reason: "结构化主体或属性不同，文字相似不构成替代依据。" };
    }
    if (left.temporality === "event" || right.temporality === "event") {
      return { kind: "unrelated", action: "keep", reason: "事件可能属于不同时点，缺少同一事件依据，分别保留。" };
    }
    if (old.manuallyEdited) {
      return { kind: "uncertain", action: "pending", reason: "该主体和属性已有人工维护；结构化字段保留原提取依据，不能代表人工更正后的值，需用户选择。" };
    }
    if (normalize(left.value) === normalize(right.value)) {
      return { kind: "duplicate", action: "pending", reason: "结构化主体、属性和值相同；措辞不同的新来源保留待确认。" };
    }
    if (left.temporality === "current" && right.temporality === "current"
      && evidence.laterSources && evidence.verifiedTransition) {
      if (isProtectedMemory(old) || old.scope !== incoming.scope || old.conversationId !== incoming.conversationId) {
        return { kind: "temporal_update", action: "pending", reason: "来源记录了状态变化，但已有记忆由用户维护、固定或处于其他作用域，需用户选择。" };
      }
      return { kind: "temporal_update", action: "supersede", reason: "同一分支后续原文明确记录旧值到新值的变化，保留旧记录并建立替代关系。" };
    }
    return { kind: "conflict", action: "pending", reason: "相同主体和属性的值不同，缺少可核实的时序更新依据，等待用户选择。" };
  }
  if (memorySimilarity(old.content, incoming.content) > 0.5) {
    return { kind: "uncertain", action: "pending", reason: "措辞接近但没有完整结构化证据，不能判断重复、矛盾或时间变化。" };
  }
  return { kind: "unrelated", action: "keep", reason: "未发现可核实的同一事实依据，保留各自来源。" };
}

/** Deliberately narrow transition grammar: a model's assertion alone cannot authorize replacement. */
export function quoteProvesTransition(quote: string, from: string, to: string): boolean {
  if (from === to || !quote.includes(from) || !quote.includes(to)) return false;
  if (/(?:如果|假如|也许|可能|梦见|传闻|听说|希望|计划|打算|将会|并未|没有|不曾|不会)|\b(?:if|would|could|might|not)\b/iu.test(quote)) return false;
  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const previous = escaped(from), next = escaped(to);
  return new RegExp(`从\\s*${previous}\\s*(?:改为|变成|变为|改成|搬到|迁到|转为|到)\\s*${next}`, "u").test(quote)
    || new RegExp(`from\\s+${previous}\\s+to\\s+${next}`, "iu").test(quote);
}

export function isCompleteSourceQuote(source: string, quote: string): boolean {
  const index = source.indexOf(quote);
  if (index < 0) return false;
  const before = source.slice(0, index).trimEnd().at(-1);
  const after = source.slice(index + quote.length).trimStart().at(0);
  const boundary = /[。！？.!?\n]/u;
  return (!before || boundary.test(before)) && (!after || boundary.test(after) || boundary.test(quote.trimEnd().at(-1) ?? ""));
}

export function quoteDirectlyNamesClaim(quote: string, claim: NonNullable<MemoryRecord["claim"]>, role: "user" | "assistant"): boolean {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const property = escape(claim.predicate);
  const subject = escape(claim.subject);
  return new RegExp(`^${subject}(?:的|'s|’s)?\\s*${property}`, "u").test(quote.trimStart())
    || (claim.subject === "玩家" && role === "user" && new RegExp(`^我的\\s*${property}`, "u").test(quote.trimStart()));
}
