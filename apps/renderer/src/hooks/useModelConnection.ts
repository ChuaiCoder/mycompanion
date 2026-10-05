import { useEffect, useRef, useState } from "react";

import type { ProviderConnectionResponse } from "@mycompanion/shared";

import { testProvider } from "../api";
import { observeProviderConnection } from "../provider-connection";

export type ModelConnectionState = "checking" | "online" | "offline";

export interface ModelConnection {
  state: ModelConnectionState;
  /** 连接成功时后端读到的模型数（服务没返回列表时为 0）。 */
  modelCount: number;
  /** 失败原因（用于界面给出可操作提示），成功时为 null。 */
  reason: string | null;
  /** 失败时的问题定位：是地址、密钥还是模型名的问题。 */
  issueField: NonNullable<ProviderConnectionResponse["issue"]>["field"] | undefined;
}

/**
 * 模型连通性（启动检查一次）。
 *
 * 侧栏原来显示的是"本地 HTTP 服务是否响应"——那个服务与界面同进程，几乎永远成功，
 * 所以那个绿灯提供不了任何信息。这里改为真正探测模型：后端用已保存的设置请求一次
 * 模型列表。不轮询：只在启动时查一次，用户保存新设置后再查一次。
 *
 * 注意：判断依据是响应体的 `ok`，不是 HTTP 状态码——后端在连接失败时也会返回
 * 200 + `{ok:false}`，只看状态码会把失败读成成功。
 */
export function useModelConnection(): ModelConnection {
  const [state, setState] = useState<ModelConnectionState>("checking");
  const [modelCount, setModelCount] = useState(0);
  const [reason, setReason] = useState<string | null>(null);
  const [issueField, setIssueField] = useState<ModelConnection["issueField"]>(undefined);
  const reads = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;

    const check = async (): Promise<void> => {
      const revision = ++reads.current;
      if (!disposed) { setState("checking"); setReason(null); setIssueField(undefined); }
      // 观察连接版本：期间若保存了新的模型设置，这次结果就作废，避免旧结果覆盖新状态。
      const isCurrentConnection = observeProviderConnection();
      try {
        const result = await testProvider(undefined, controller.signal);
        if (disposed || revision !== reads.current || !isCurrentConnection()) return;
        setModelCount(result.models.length);
        if (result.ok) { setState("online"); setReason(null); setIssueField(undefined); }
        else { setState("offline"); setReason(result.message); setIssueField(result.issue?.field); }
      } catch (error) {
        if (disposed || revision !== reads.current || !isCurrentConnection()) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState("offline");
        setReason(error instanceof Error ? error.message : "无法连接模型。");
      }
    };

    // 记下启动探测的时间，避免挂载后紧跟着的事件又立刻发一次。
    let lastCheckedAt = Date.now();
    void check();
    /**
     * 任何"已保存连接发生变化"的时机都要复查，否则状态会停在旧值：
     *  - provider-saved：用户在设置里保存、或**切换到另一个连接档**（这个路径不发 provider-tested）
     *  - provider-tested：测试成功后保存（同时也会发 provider-saved）
     * 两者可能先后紧邻触发，用一个时间窗去重，避免连发两次探测。
     */
    const recheck = () => {
      const now = Date.now();
      if (now - lastCheckedAt < 1_500) return;
      lastCheckedAt = now;
      void check();
    };
    window.addEventListener("mycompanion:provider-saved", recheck);
    window.addEventListener("mycompanion:provider-tested", recheck);
    return () => {
      disposed = true;
      reads.current++;
      controller.abort();
      window.removeEventListener("mycompanion:provider-saved", recheck);
      window.removeEventListener("mycompanion:provider-tested", recheck);
    };
  }, []);

  return { state, modelCount, reason, issueField };
}
