import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "../../i18n";

import { buildCardDocument, CARD_HEIGHT_MESSAGE, CARD_IFRAME_SANDBOX, CARD_PANEL_MESSAGE, CARD_PANEL_STORAGE_KEY, CARD_STORAGE_MESSAGE, persistCardPanelPosition, persistCardStorage, readCardPanelPosition, readCardStorage } from "../../frontend-card-frame";
import { CARD_BRIDGE_RESPONSE, parseCardBridgeRequest, runCardBridgeRequest, type CardBridgeHost } from "../../frontend-card-bridge";
import { hasCardScript } from "../../frontend-card";

/** 卡片自报高度前的兜底高度，避免首帧塌陷。 */
const FALLBACK_HEIGHT = 420;
/** 上限：防止卡片脚本失控把消息撑成无限长。 */
const MAX_HEIGHT = 4000;

// 一条前端卡消息：卡片界面在独立子文档（srcdoc iframe）里渲染，自带脚本在其中运行。
//
// 这里刻意不消毒卡片 HTML —— 消毒会抹掉文档级结构（整段变空）。子文档的作用是隔离
// CSS 与文档结构；它不是安全边界——按产品决策（spec §5.10），卡脚本是可信的高权限代码。
export function FrontendCardMessage({ markup, messageId, bridge, runtimeSource, hostGlobals, conversationId }: {
  markup: string;
  messageId: string;
  /** 卡片可调用的宿主能力；缺省时卡片脚本会走自己的降级分支。 */
  bridge: CardBridgeHost;
  /** 卡自带运行时（MVU 等）的模块源码；缺省表示这张卡没有脚本库。 */
  runtimeSource?: string | undefined;
  /** 暴露给卡自带运行时的宿主数据（聊天记录、角色、当前故事）。 */
  hostGlobals?: Record<string, unknown> | undefined;
  /** 当前故事 id：卡存储按故事隔离，切故事不会串。 */
  conversationId: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(FALLBACK_HEIGHT);
  const { t } = useTranslation();
  const scripted = hasCardScript(markup);
  // 消息监听器只装一次，因此用 ref 取当前故事 id 来落盘。
  const storyRef = useRef(conversationId);
  storyRef.current = conversationId;

  // 桥的宿主信息放进 ref：消息按引用变化不应重建 iframe，否则卡片界面会被整块重载。
  const host = useRef(bridge);
  host.current = bridge;

  // 宿主数据只在文档构建时注入一次：它是卡片初始化阶段读取的静态快照（SillyTavern
  // 桩件等），此后卡片要数据一律走桥（host.current 始终是最新的）。
  // 绝不能把它放进 effect 依赖：流式期间消息内容逐 delta 变化，序列化值随之变化，
  // 会导致整个卡片文档每个 delta 重建一次（实测的卡顿来源）。
  const initialHostGlobals = useRef(hostGlobals);

  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    // 已保存的卡存储同步注入：卡在初始化阶段就同步读取它（面板位置、存档选择等）。
    element.srcdoc = buildCardDocument(markup, runtimeSource, initialHostGlobals.current, readCardStorage(conversationId), readCardPanelPosition(conversationId));
  }, [markup, runtimeSource, conversationId]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const element = frame.current;
      // 只接受本 iframe 发来的消息。
      if (!element || event.source !== element.contentWindow) return;

      const data = event.data as { type?: unknown; height?: unknown; kind?: unknown; key?: unknown; value?: unknown; left?: unknown; top?: unknown } | null;
      if (data && data.type === CARD_HEIGHT_MESSAGE) {
        const value = typeof data.height === "number" ? data.height : 0;
        if (!Number.isFinite(value) || value <= 0) return;
        setHeight(Math.min(Math.max(value, FALLBACK_HEIGHT), MAX_HEIGHT));
        return;
      }

      // 卡的助手报了浮动面板位置：由宿主代记，下一次文档重建时写回。
      if (data && data.type === CARD_PANEL_MESSAGE) {
        if (data.key !== CARD_PANEL_STORAGE_KEY) return;
        persistCardPanelPosition(storyRef.current, data.left, data.top);
        return;
      }

      // 卡改了 localStorage / sessionStorage：落盘到宿主，使状态跨文档重建保留。
      if (data && data.type === CARD_STORAGE_MESSAGE) {
        const kind = data.kind === "session" ? "session" : "local";
        const key = data.key === null ? null : typeof data.key === "string" ? data.key : null;
        const value = data.value === null ? null : typeof data.value === "string" ? data.value : null;
        // key 为 null 表示整表清空；value 为 null 表示删单个键。
        if (data.key !== null && typeof data.key !== "string") return;
        persistCardStorage(storyRef.current, { kind, key, value });
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
          {t("这张卡片包含交互脚本，会以完整权限运行：可读写本应用的数据并访问网络。请只使用你信任的卡片。")}
        </p>
      ) : null}
    </div>
  );
}
