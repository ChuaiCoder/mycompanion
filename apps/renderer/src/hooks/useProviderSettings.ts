import { useEffect, useRef, useState, type SetStateAction } from "react";

import type { ProviderConnectionResponse, ProviderSettings, UpdateProviderSettings } from "@mycompanion/shared";

import { ApiRequestError, saveProviderSettings, testProvider } from "../api";
import i18n from "../i18n";
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
  /** 供"测试获取模型"在拿到模型列表后放行下一步——那已经证明密钥与地址都通了。 */
  const markConnectionReady = () => setIsConnectionReady(true);
  const revision = useRef(0), operation = useRef(0);
  function changed() { revision.current++; setProviderNotice(null); setProviderIssue(undefined); setIsConnectionReady(false); }
  function setProvider(value: SetStateAction<ProviderSettings | null>) { changed(); updateProvider(value); }
  function setApiKeyDraft(value: string) { changed(); updateApiKey(value); }
  useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent<ProviderSettings & { connectionUnchanged?: boolean }>).detail;
      if (!detail.connectionUnchanged) { revision.current++; updateProvider(detail); updateApiKey(""); setIsConnectionReady(false); setProviderNotice(null); setProviderIssue(undefined); }
    };
    window.addEventListener("mycompanion:provider-saved", update);
    return () => { revision.current++; window.removeEventListener("mycompanion:provider-saved", update); };
  }, []);

  /**
   * 保存模型设置。返回**明确的成败信号**：调用方不能靠"有没有抛异常"判断，
   * 因为这里所有异常都被 catch 掉并转成界面提示，函数总是正常 resolve。
   * 之前界面因此把失败的保存当成成功，允许带着未保存的配置进聊天。
   */
  const handleSaveProvider = async (shouldTest: boolean): Promise<boolean> => {
    if (!provider) return false;
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
        if (!current()) return false;
        if (!result.ok) { setProviderIssue(result.issue); setRuntimeError(result.message); return false; }
      }
      const saved = await saveProviderSettings(snapshot);
      if (!current()) return false;
      updateProvider(saved); updateApiKey("");
      window.dispatchEvent(new CustomEvent("mycompanion:provider-saved", { detail: saved }));
      connectionIsCurrent = observeProviderConnection();
      setIsConnectionReady(Boolean(result?.ok));
      setProviderNotice(result ? i18n.t("{{message}} 设置已安全保存，可以开始对话。", { message: result.message }) : i18n.t("模型设置已安全保存到本机。"));
      if (result) window.dispatchEvent(new CustomEvent("mycompanion:provider-tested", { detail: { ok: true, model: saved.model } }));
      return true;
    } catch (error) {
      if (!current()) return false;
      setRuntimeError(error instanceof ApiRequestError ? error.message : "无法完成连接检查或保存，请修改当前配置后重试。");
      return false;
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
    markConnectionReady,
    handleSaveProvider,
  };
}
