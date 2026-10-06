import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { buildCardDocument, CARD_HEIGHT_MESSAGE, CARD_IFRAME_SANDBOX } from "../../frontend-card-frame";
import { hasCardScript } from "../../frontend-card";

/** 卡片自报高度前的兜底高度，避免首帧塌陷。 */
const FALLBACK_HEIGHT = 420;
/** 上限：防止卡片脚本失控把消息撑成无限长。 */
const MAX_HEIGHT = 4000;

// 一条前端卡消息：卡片界面在隔离 iframe 里渲染，自带脚本在其中运行。
//
// 这里刻意不消毒卡片 HTML —— 消毒会抹掉文档级结构（整段变空），而且无法阻止卡片 CSS
// 污染应用界面。隔离文档 + 不透明源 iframe 才是有效边界。
export function FrontendCardMessage({ markup, messageId }: { markup: string; messageId: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(FALLBACK_HEIGHT);
  const { t } = useTranslation();
  const scripted = hasCardScript(markup);

  // 高度由子文档自己测量后上报 —— iframe 是不透明源，父页面读不到 contentDocument。
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; height?: unknown } | null;
      if (!data || data.type !== CARD_HEIGHT_MESSAGE) return;
      // 只接受本 iframe 发来的消息，避免同页面其它消息影响布局。
      if (frame.current && event.source !== frame.current.contentWindow) return;
      const value = typeof data.height === "number" ? data.height : 0;
      if (!Number.isFinite(value) || value <= 0) return;
      setHeight(Math.min(Math.max(value, FALLBACK_HEIGHT), MAX_HEIGHT));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    element.srcdoc = buildCardDocument(markup);
  }, [markup]);

  return (
    <div className="frontend-card" data-frontend-card={messageId}>
      <iframe
        className="frontend-card__frame"
        ref={frame}
        sandbox={CARD_IFRAME_SANDBOX}
        title={t("角色卡界面")}
        style={{ width: "100%", height: `${height}px`, border: 0, display: "block" }}
      />
      {scripted ? (
        <p className="frontend-card__notice">
          {t("这张卡片的交互脚本在本应用的隔离沙箱中运行；沙箱会阻断脚本对应用页面和外部网络的访问。")}
        </p>
      ) : null}
    </div>
  );
}
