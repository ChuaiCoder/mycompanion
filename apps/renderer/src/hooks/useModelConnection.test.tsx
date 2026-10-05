import { cleanup, renderHook, waitFor, act } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as api from "../api";
import { useModelConnection } from "./useModelConnection";

// 侧栏的模型状态：启动查一次，并在**已保存连接发生变化**时复查。
// 以前只监听 provider-tested，所以"保存（未测试）"与"切换到另一个连接档"都不会刷新状态，
// 侧栏会一直停在旧的在线/离线结论。

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const connected = { ok: true, message: "连接成功，读取到 2 个模型。", models: ["a", "b"] };

it("checks once on mount", async () => {
  const spy = vi.spyOn(api, "testProvider").mockResolvedValue(connected);
  const { result } = renderHook(() => useModelConnection());
  await waitFor(() => expect(result.current.state).toBe("online"));
  expect(spy).toHaveBeenCalledTimes(1);
  expect(result.current.modelCount).toBe(2);
});

it("rechecks when another connection profile is saved", async () => {
  // 切换连接档只发 provider-saved（不发 provider-tested）——这正是以前漏掉的路径。
  const spy = vi.spyOn(api, "testProvider").mockResolvedValue(connected);
  const { result } = renderHook(() => useModelConnection());
  await waitFor(() => expect(result.current.state).toBe("online"));
  expect(spy).toHaveBeenCalledTimes(1);

  // 让时间窗过去，再宣布"已保存连接变了"。
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(Date.now() + 5_000);
  const switched = { ok: false, message: "无法连接模型服务，请检查地址、网络和本地模型进程。", models: [] };
  spy.mockResolvedValue(switched);
  act(() => { window.dispatchEvent(new CustomEvent("mycompanion:provider-saved", { detail: { kind: "openai-compatible" } })); });

  await waitFor(() => expect(result.current.state).toBe("offline"));
  expect(spy).toHaveBeenCalledTimes(2);
  expect(result.current.reason).toContain("无法连接模型服务");
  vi.useRealTimers();
});

it("does not fire两次探测 for one save that also reports a successful test", async () => {
  // 测试成功后保存会先后发 provider-saved 与 provider-tested：只应复查一次。
  const spy = vi.spyOn(api, "testProvider").mockResolvedValue(connected);
  const { result } = renderHook(() => useModelConnection());
  await waitFor(() => expect(result.current.state).toBe("online"));

  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(Date.now() + 5_000);
  act(() => {
    window.dispatchEvent(new CustomEvent("mycompanion:provider-saved", { detail: { kind: "openai-compatible" } }));
    window.dispatchEvent(new CustomEvent("mycompanion:provider-tested", { detail: { ok: true, model: "a" } }));
  });

  await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  // 再等一会，确认没有出现第三次。
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(spy).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});
