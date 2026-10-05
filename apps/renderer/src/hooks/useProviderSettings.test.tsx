import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderSettings } from "@mycompanion/shared";
import * as api from "../api";
import { useProviderSettings } from "./useProviderSettings";
vi.mock("../api", async original => ({ ...await original<typeof import("../api")>(), saveProviderSettings: vi.fn(), testProvider: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const configured: ProviderSettings = { kind: "ollama", baseUrl: "http://localhost:11434/v1", model: "fixture", hasApiKey: false, temperature: 0.8, maxTokens: 1024, contextLimitTokens: 32768 };

it("tests the unsaved model and key first and only saves a successful draft", async () => {
  vi.mocked(api.testProvider).mockResolvedValue({ ok: true, message: "Model replied", models: [], testedModel: "fixture", capability: "chat-completion" });
  vi.mocked(api.saveProviderSettings).mockResolvedValue({ ...configured, hasApiKey: true });
  const { result } = renderHook(() => useProviderSettings({ setRuntimeError: vi.fn() }));
  act(() => { result.current.setProvider(configured); result.current.setApiKeyDraft("unsaved-key"); });
  await act(async () => { await result.current.handleSaveProvider(true); });
  expect(api.testProvider).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "unsaved-key", model: "fixture" }));
  expect(vi.mocked(api.testProvider).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.saveProviderSettings).mock.invocationCallOrder[0]!);
  expect(result.current.isConnectionReady).toBe(true); expect(result.current.apiKeyDraft).toBe("");
});

it("retains a rejected draft and structured correction without writing provider settings", async () => {
  vi.mocked(api.testProvider).mockResolvedValue({ ok: false, message: "Missing model", models: [], issue: { code: "MODEL_NOT_FOUND", field: "model", suggestion: "Use an installed model", retryable: false } });
  const { result } = renderHook(() => useProviderSettings({ setRuntimeError: vi.fn() }));
  act(() => result.current.setProvider(configured)); await act(async () => { await result.current.handleSaveProvider(true); });
  expect(api.saveProviderSettings).not.toHaveBeenCalled(); expect(result.current.providerIssue?.field).toBe("model"); expect(result.current.provider?.model).toBe("fixture");
});

it("reports save failure as an explicit false instead of resolving silently", async () => {
  // 这是界面判断"能否进聊天"的依据：hook 吞掉异常后必须返回 false，
  // 否则调用方只能靠"有没有抛异常"猜，会把失败当成成功。
  vi.mocked(api.testProvider).mockResolvedValue({ ok: true, message: "Model replied", models: [] });
  vi.mocked(api.saveProviderSettings).mockRejectedValue(new Error("磁盘写入失败"));
  const setRuntimeError = vi.fn();
  const { result } = renderHook(() => useProviderSettings({ setRuntimeError }));
  act(() => result.current.setProvider(configured));

  let outcome: boolean | undefined;
  await act(async () => { outcome = await result.current.handleSaveProvider(true); });
  // 明确返回 false，同时仍然给出可读的错误提示。
  expect(outcome).toBe(false);
  expect(setRuntimeError).toHaveBeenCalled();
  expect(result.current.isConnectionReady).toBe(false);
  expect(result.current.providerNotice).toBeNull();
});

it("reports a refused connection test as false too", async () => {
  vi.mocked(api.testProvider).mockResolvedValue({ ok: false, message: "Missing model", models: [], issue: { code: "MODEL_NOT_FOUND", field: "model", suggestion: "x", retryable: false } });
  const { result } = renderHook(() => useProviderSettings({ setRuntimeError: vi.fn() }));
  act(() => result.current.setProvider(configured));
  let outcome: boolean | undefined;
  await act(async () => { outcome = await result.current.handleSaveProvider(true); });
  expect(outcome).toBe(false);
});

it("reports a successful save as true", async () => {
  vi.mocked(api.testProvider).mockResolvedValue({ ok: true, message: "Model replied", models: [] });
  vi.mocked(api.saveProviderSettings).mockResolvedValue({ ...configured, hasApiKey: true });
  const { result } = renderHook(() => useProviderSettings({ setRuntimeError: vi.fn() }));
  act(() => result.current.setProvider(configured));
  let outcome: boolean | undefined;
  await act(async () => { outcome = await result.current.handleSaveProvider(true); });
  expect(outcome).toBe(true);
});

it("discards a late draft test after the user edits the model or key", async () => {
  let resolve!: (value: { ok: boolean; message: string; models: string[] }) => void;
  vi.mocked(api.testProvider).mockReturnValue(new Promise(yes => { resolve = yes; }));
  const { result } = renderHook(() => useProviderSettings({ setRuntimeError: vi.fn() }));
  act(() => result.current.setProvider(configured)); let operation!: Promise<boolean>;
  await act(async () => { operation = result.current.handleSaveProvider(true); await Promise.resolve(); });
  act(() => { result.current.setProvider({ ...configured, model: "new-model" }); result.current.setApiKeyDraft("new-key"); });
  await act(async () => { resolve({ ok: true, message: "Old model replied", models: [] }); await operation; });
  expect(api.saveProviderSettings).not.toHaveBeenCalled(); expect(result.current.provider?.model).toBe("new-model"); expect(result.current.apiKeyDraft).toBe("new-key"); expect(result.current.providerNotice).toBeNull();
});

it.each(["success", "failure"])("ignores a late connection test %s after another connection was saved", async outcome => {
  const old: ProviderSettings = { kind: "openai-compatible", baseUrl: "https://old.test/v1", model: "same-model",
    hasApiKey: true, temperature: 0.8, maxTokens: 1024, contextLimitTokens: 32768 };
  let resolve!: (value: { ok: boolean; message: string; models: string[] }) => void, reject!: (error: Error) => void;
  const pending = new Promise<{ ok: boolean; message: string; models: string[] }>((yes, no) => { resolve = yes; reject = no; });
  vi.mocked(api.saveProviderSettings).mockResolvedValue(old);
  vi.mocked(api.testProvider).mockReturnValue(pending);
  const error = vi.fn(), onConnection = vi.fn();
  window.addEventListener("mycompanion:provider-tested", onConnection);
  const { result } = renderHook(() => useProviderSettings({ setRuntimeError: error }));
  try {
    act(() => result.current.setProvider(old));
    let operation!: Promise<boolean>;
    await act(async () => { operation = result.current.handleSaveProvider(true); await Promise.resolve(); });
    expect(api.testProvider).toHaveBeenCalledOnce();
    const current = { ...old, baseUrl: "https://new.test/v1" };
    act(() => window.dispatchEvent(new CustomEvent("mycompanion:provider-saved", { detail: current })));
    await act(async () => {
      if (outcome === "success") resolve({ ok: true, message: "old connection OK", models: [] });
      else reject(new Error("old connection failed"));
      await operation;
    });
    expect(result.current.provider?.baseUrl).toBe(current.baseUrl);
    expect(onConnection).not.toHaveBeenCalled();
    expect(error.mock.calls.every(([value]) => value === null)).toBe(true);
    expect(result.current.providerNotice).not.toBe("old connection OK");
  } finally { window.removeEventListener("mycompanion:provider-tested", onConnection); }
});

it("clears a transient key when a saved profile is selected so the old draft cannot be saved to its new endpoint", () => {
  const { result } = renderHook(() => useProviderSettings({ setRuntimeError: vi.fn() }));
  act(() => { result.current.setProvider(configured); result.current.setApiKeyDraft("old-profile-transient-key"); });
  act(() => window.dispatchEvent(new CustomEvent("mycompanion:provider-saved", { detail: { ...configured, baseUrl: "https://another.test/v1", model: "another" } })));
  expect(result.current.provider?.baseUrl).toBe("https://another.test/v1");
  expect(result.current.apiKeyDraft).toBe(""); expect(result.current.isConnectionReady).toBe(false);
});
