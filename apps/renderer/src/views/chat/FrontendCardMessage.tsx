import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { buildCardDocument, CARD_HEIGHT_MESSAGE, CARD_IFRAME_SANDBOX } from "../../frontend-card-frame";
import { CARD_BRIDGE_RESPONSE, parseCardBridgeRequest, runCardBridgeRequest, type CardBridgeHost } from "../../frontend-card-bridge";
import { hasCardScript } from "../../frontend-card";

/** 卡片自报高度前的兜底高度，避免首帧塌陷。 */
const FALLBACK_HEIGHT = 420;
/** 上限：防止卡片脚本失控把消息撑成无限长。 */
const MAX_HEIGHT = 4000;

// 一条前端卡消息：卡片界面在隔离 iframe 里渲染，自带脚本在其中运行。
//
// 这里刻意不消毒卡片 HTML —— 消毒会抹掉文档级结构（整段变空），而且无法阻止卡片 CSS
// 污染应用界面。隔离文档 + 不透明源 iframe 才是有效边界。
export function FrontendCardMessage({ markup, messageId, bridge, runtimeSource }: {
  markup: string;
  messageId: string;
  /** 卡片可调用的宿主能力；缺省时卡片脚本会走自己的降级分支。 */
  bridge: CardBridgeHost;
  /** 卡自带运行时（MVU 等）的模块源码；缺省表示这张卡没有脚本库。 */
  runtimeSource?: string | undefined;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(FALLBACK_HEIGHT);
  const { t } = useTranslation();
  const scripted = hasCardScript(markup);

  // 桥的宿主信息放进 ref：消息按引用变化不应重建 iframe，否则卡片界面会被整块重载。
  const host = useRef(bridge);
  host.current = bridge;

  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    element.srcdoc = buildCardDocument(markup, runtimeSource);
  }, [markup, runtimeSource]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const element = frame.current;
      // 只接受本 iframe 发来的消息。
      if (!element || event.source !== element.contentWindow) return;

      const data = event.data as { type?: unknown; height?: unknown } | null;
      if (data && data.type === CARD_HEIGHT_MESSAGE) {
        const value = typeof data.height === "number" ? data.height : 0;
        if (!Number.isFinite(value) || value <= 0) return;
        setHeight(Math.min(Math.max(value, FALLBACK_HEIGHT), MAX_HEIGHT));
        return;
      }

      const request = parseCardBridgeRequest(data);
      if (!request) return;
      void runCardBridgeRequest(request, host.current).then(result => {
        // 回执必须回到发来请求的那个 frame。
        element.contentWindow?.postMessage({ type: CARD_BRIDGE_RESPONSE, ...result }, "*");
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

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
