import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ChatMessage } from "@mycompanion/shared";

import { transformDisplayText } from "./api";
import { frontendCardOf } from "./frontend-card";

// 显示阶段正则的结果：消息渲染前用它替换要显示的文本。
//
// 只影响渲染——不落库、不产生副作用。卡把整段界面放在 `markdownOnly` 规则里时，
// 正是靠这条通路把占位符换成真实界面。
//
// 只对"看起来需要转换"的消息发请求：前端卡内容，或含方括号占位符的短文本
// （`[重塑仙缘]` 这类）。这样普通消息不产生任何额外请求与开销。

const DisplayTextContext = createContext<ReadonlyMap<string, string>>(new Map());

export const useDisplayText = (): ReadonlyMap<string, string> => useContext(DisplayTextContext);

/** 该消息是否值得做显示转换。 */
export function needsDisplayTransform(content: string): boolean {
  if (!content) return false;
  if (frontendCardOf(content)) return true;
  // 占位符形态：整条短消息被方括号包裹（卡用它指代"这里放一段界面"）。
  const trimmed = content.trim();
  return trimmed.length <= 120 && /^\[[^\]\n]{1,60}\]$/.test(trimmed);
}

export function DisplayTextProvider({ conversationId, messages, children }: {
  conversationId: string;
  messages: readonly ChatMessage[];
  children: ReactNode;
}) {
  const [texts, setTexts] = useState<ReadonlyMap<string, string>>(new Map());
  // 只依赖"需要转换的那些消息"的内容，避免普通消息变化触发无谓转换。
  const targets = useMemo(
    () => messages.filter(message => needsDisplayTransform(message.content)).map(message => ({ messageId: message.id, text: message.content })),
    [messages],
  );
  const signature = useMemo(
    () => conversationId + "|" + targets.map(target => `${target.messageId}:${target.text}`).join("\u0000"),
    [conversationId, targets],
  );

  useEffect(() => {
    if (!targets.length) {
      setTexts(current => (current.size ? new Map() : current));
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const results = await transformDisplayText(conversationId, targets, controller.signal);
        const next = new Map<string, string>();
        for (const result of results) if (result.text !== undefined) next.set(result.messageId, result.text);
        setTexts(next);
      } catch {
        // 转换失败时保持原文：显示层不应因为正则问题而丢内容。
      }
    })();
    return () => controller.abort();
    // signature 已涵盖 conversationId 与目标内容，用它作为唯一触发条件。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return <DisplayTextContext.Provider value={texts}>{children}</DisplayTextContext.Provider>;
}
