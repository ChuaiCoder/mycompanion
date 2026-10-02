import { useEffect, useRef, useState, type SetStateAction } from "react";

import type { ProviderConnectionResponse, ProviderSettings, UpdateProviderSettings } from "@mycompanion/shared";

import { ApiRequestError, saveProviderSettings, testProvider } from "../api";
import { observeProviderConnection } from "../provider-connection";

// 模型提供方设置：本地草稿、保存/测试，以及扩展保存后广播的 provider-saved 事件订阅。
export function useProviderSettings(deps: {
  setRuntimeError: (message: string | null) => void;
}) {
  const { setRuntimeError } = deps;
  const [provider, updateProvider] = useState<ProviderSettings | null>(null);
  const [apiKeyDraft, updateApiKey] = useState("");
  const [isSavingProvider, setIsSavingProvider] = useState(false);
  const [providerNotice, setProviderNotice] = useState<string | null>(null);
  const [providerIssue, setProviderIssue] = useState<ProviderConnectionResponse["issue"]>();
  const [isConnectionReady, setIsConnectionReady] = useState(false);
  const revision = useRef(0), operation = useRef(0);
  function changed() { revision.current++; setProviderNotice(null); setProviderIssue(undefined); setIsConnectionReady(false); }
  function setProvider(value: SetStateAction<ProviderSettings | null>) { changed(); updateProvider(value); }
  function setApiKeyDraft(value: string) { changed(); updateApiKey(value); }
  useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent<ProviderSettings & { connectionUnchanged?: boolean }>).detail;
      if (!detail.connectionUnchanged) { revision.current++; updateProvider(detail); setIsConnectionReady(false); setProviderNotice(null); setProviderIssue(undefined); }
    };
    window.addEventListener("mycompanion:provider-saved", update);
    return () => { revision.current++; window.removeEventListener("mycompanion:provider-saved", update); };
  }, []);

  const handleSaveProvider = async (shouldTest: boolean): Promise<void> => {
    if (!provider) return;
    const snapshot: UpdateProviderSettings = { kind: provider.kind, baseUrl: provider.baseUrl, model: provider.model,
      temperature: provider.temperature, maxTokens: provider.maxTokens, contextLimitTokens: provider.contextLimitTokens,
      clearApiKey: false, ...(apiKeyDraft ? { apiKey: apiKeyDraft } : {}) };
    const token = revision.current, attempt = ++operation.current;
    setIsSavingProvider(true);
    setProviderNotice(null);
    setRuntimeError(null);
    let connectionIsCurrent = observeProviderConnection();
    const current = () => attempt === operation.current && token === revision.current && connectionIsCurrent();
    setProviderIssue(undefined);
    try {
      let result: ProviderConnectionResponse | undefined;
      if (shouldTest) {
        result = await testProvider(snapshot);
        if (!current()) return;
        if (!result.ok) { setProviderIssue(result.issue); setRuntimeError(result.message); return; }
      }
      const saved = await saveProviderSettings(snapshot);
      if (!current()) return;
      updateProvider(saved); updateApiKey("");
      window.dispatchEvent(new CustomEvent("mycompanion:provider-saved", { detail: saved }));
      connectionIsCurrent = observeProviderConnection();
      setIsConnectionReady(Boolean(result?.ok));
      setProviderNotice(result ? `${result.message} 设置已安全保存，可以开始对话。` : "模型设置已安全保存到本机。");
      if (result) window.dispatchEvent(new CustomEvent("mycompanion:provider-tested", { detail: { ok: true, model: saved.model } }));
    } catch (error) {
      if (!current()) return;
      setRuntimeError(error instanceof ApiRequestError ? error.message : "无法完成连接检查或保存，请修改当前配置后重试。");
    } finally {
      if (attempt === operation.current) setIsSavingProvider(false);
    }
  };

  return {
    provider,
    setProvider,
    apiKeyDraft,
    setApiKeyDraft,
    isSavingProvider,
    providerNotice,
    providerIssue,
    isConnectionReady,
    handleSaveProvider,
  };
}
