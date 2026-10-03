import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChatMessage, ConversationDetail } from "@mycompanion/shared";
import { fetchStoryExport } from "../api";
import { replyBranches, type ReplyBranch } from "../branch-candidates";
import { selectMessageSwipe } from "../swipe-runtime";

export function ReplyCandidates({ message, conversation, disabled, onActivateBranch, onSwiped }: {
  message: ChatMessage; conversation: ConversationDetail; disabled: boolean;
  onActivateBranch?: ((conversationId: string, branchId: string) => Promise<void>) | undefined;
  onSwiped?: ((conversationId: string) => Promise<void> | void) | undefined;
}) {
  const { i18n } = useTranslation(), en = i18n.language.startsWith("en"), locale = en ? "en-US" : "zh-CN";
  const scope = `${conversation.id}/${conversation.activeBranchId}/${message.id}`;
  const current = useRef(scope); current.current = scope;
  const readRevision = useRef(""); readRevision.current = `${scope}/${conversation.updatedAt}`;
  const operation = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [branches, setBranches] = useState<ReplyBranch[]>([]), [open, setOpen] = useState(false);
  useEffect(() => { setBranches([]); setOpen(false); setError(""); }, [scope, conversation.updatedAt]);
  useEffect(() => { setBusy(false); }, [scope]);
  const raw = message.extensionData?.swipes, swipes = Array.isArray(raw) ? raw : [];
  const valid = swipes.flatMap((value, index) => typeof value === "string" ? [index] : []);
  const selected = typeof message.extensionData?.swipe_id === "number" ? message.extensionData.swipe_id : 0;
  const position = valid.indexOf(selected);
  const last = conversation.messages.at(-1)?.id === message.id;
  if (message.role !== "assistant" || message.status === "streaming") return null;
  async function run(action: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError("");
    const captured = scope;
    try { await action(); }
    catch (error) { if (current.current === captured) setError(error instanceof Error ? error.message : String(error)); }
    finally { operation.current = false; if (current.current === captured) setBusy(false); }
  }
  const select = (index: number) => run(async () => {
    await selectMessageSwipe({ conversationId: conversation.id, messageId: message.id }, index);
    await onSwiped?.(conversation.id);
  });
  return <>
    {valid.length > 1 ? <div className="message-actions swipe-controls" role="group" aria-label={en ? "Reply candidates" : "候选回复"}>
      <button type="button" className="message-action swipe_left" aria-label={en ? "Previous reply candidate" : "上一条候选回复"} disabled={disabled || busy || position <= 0} onClick={() => void select(valid[position - 1]!)}>{en ? "Previous" : "上一条"}</button>
      <span className="swipes-counter" aria-live="polite">{(position + 1).toLocaleString(locale)} / {valid.length.toLocaleString(locale)}</span>
      <button type="button" className="message-action swipe_right" aria-label={en ? "Next reply candidate" : "下一条候选回复"} disabled={disabled || busy || position < 0 || position >= valid.length - 1} onClick={() => void select(valid[position + 1]!)}>{en ? "Next" : "下一条"}</button>
    </div> : null}
    {last && message.parentMessageId && onActivateBranch ? <div className="reply-branches">
      <button type="button" className="message-action" aria-expanded={open} disabled={disabled || busy} onClick={() => {
        if (open) { setOpen(false); return; }
        void run(async () => {
          const captured = readRevision.current, story = await fetchStoryExport(conversation.id);
          if (readRevision.current !== captured) return;
          setBranches(replyBranches(story, conversation)); setOpen(true);
        });
      }}>{en ? "Reply branches" : "回复分支"}</button>
      {open ? branches.length > 1 ? <label>{en ? "Switch reply" : "切换回复"}<select aria-label={en ? "Switch reply branch" : "切换回复分支"} disabled={disabled || busy} value={conversation.activeBranchId} onChange={event => void run(() => onActivateBranch(conversation.id, event.target.value))}>
        {branches.map((branch, index) => <option key={branch.branchId} value={branch.branchId}>{en ? `Candidate ${(index + 1).toLocaleString(locale)}: ` : `候选 ${(index + 1).toLocaleString(locale)}：`}{branch.content.slice(0, 45) || (en ? "(Empty reply)" : "（空回复）")}</option>)}
      </select></label> : <small>{en ? "After regenerating, switch between replies to the same turn here." : "重新生成后，可以在这里切换同一轮的回复。"}</small> : null}
    </div> : null}
    {error ? <p role="alert" className="panel-error">{en ? "Reply candidate action failed: " : "候选回复操作失败："}{error}</p> : null}
  </>;
}
