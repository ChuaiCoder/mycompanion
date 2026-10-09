import { useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { changeUiLanguage, type UiLanguage } from "../i18n";

import { MAX_CONTEXT_TOKENS, type ProviderConnectionResponse, type ProviderSettings } from "@mycompanion/shared";

import { Notice } from "../components";
import { useAdvancedMode } from "../hooks/useAdvancedMode";
import { PresetSettings } from "./PresetSettings";
import { BackupPanel } from "./BackupPanel";
import { ProviderProfiles } from "./ProviderProfiles";
import { providerCopy } from "../provider-translations";
import { listProviderModels } from "../api";
import { PROVIDER_PRESETS, findPreset, isFixedEndpoint, presetLabel } from "./provider-presets";

export interface SettingsViewProps {
  provider: ProviderSettings | null;
  apiKeyDraft: string;
  isSavingProvider: boolean;
  runtimeError: string | null;
  providerNotice: string | null;
  onProviderField: (patch: Partial<ProviderSettings>) => void;
  onApiKeyDraft: (value: string) => void;
  onSave: () => boolean | void | Promise<boolean | void>;
  onSaveAndTest: () => boolean | void | Promise<boolean | void>;
  applicationBusy?: boolean;
  providerIssue?: ProviderConnectionResponse["issue"];
  isConnectionReady?: boolean;
  /** 「测试获取模型」成功后放行下一步（已证明密钥与地址可用）。 */
  onConnectionReady?: () => void;
  selectedCharacterName?: string | undefined;
  onContinue?: () => void;
}

/** 设置页分页：默认落在「模型」，其余页签按需挂载。 */
type SettingsTab = "model" | "language" | "advanced" | "backup";
const SETTINGS_TAB_ORDER: SettingsTab[] = ["model", "language", "advanced", "backup"];

export function SettingsView({
  provider,
  apiKeyDraft,
  isSavingProvider,
  runtimeError,
  providerNotice,
  onProviderField,
  onApiKeyDraft,
  onSave,
  onSaveAndTest,
  applicationBusy,
  providerIssue,
  isConnectionReady,
  selectedCharacterName,
  onContinue,
  onConnectionReady,
}: SettingsViewProps) {
  const { t, i18n } = useTranslation();
  const copy = providerCopy(i18n.language);
  const [languageError, setLanguageError] = useState("");
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelNotice, setModelNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const modelFetch = useRef(0);
  /**
   * 当前配置是否已经写进本机。
   * 「获取模型」成功只证明地址与密钥可用，**没有保存任何东西**；此前它直接放行
   * 「下一步」，用户会带着未保存的配置进聊天，实际仍用旧设置。
   */
  const [isSaved, setIsSaved] = useState(false);
  const [presetId, setPresetId] = useState<string | null>(null);
  // 设置页曾经一整页排到底，模型卡片之外的内容把页面拉得很长；
  // 改为页签后只挂载当前页，「模型」保持默认（新人引导落点不变）。
  const [activeTab, setActiveTab] = useState<SettingsTab>("model");
  const { advancedMode, setAdvancedMode } = useAdvancedMode();
  const settingsTabs: Array<{ id: SettingsTab; label: string }> = [
    { id: "model", label: t("settings.tab.model") },
    { id: "language", label: t("language.label") },
    { id: "advanced", label: t("settings.tab.advanced") },
    { id: "backup", label: t("settings.tab.backup") },
  ];
  /** WAI 页签键盘约定：方向键/Home/End 移动并立即激活。 */
  const handleTabKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = SETTINGS_TAB_ORDER.indexOf(activeTab);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? SETTINGS_TAB_ORDER.length - 1
      : (index + (event.key === "ArrowRight" ? 1 : -1) + SETTINGS_TAB_ORDER.length) % SETTINGS_TAB_ORDER.length;
    const id = SETTINGS_TAB_ORDER[next]!;
    setActiveTab(id);
    document.getElementById(`settings-tab-${id}`)?.focus();
  };
  const preset = presetId
    ? PROVIDER_PRESETS.find(entry => entry.id === presetId) ?? null
    : provider ? findPreset(provider) : null;
  // 固定端点的服务商（DeepSeek/OpenAI/Claude/Gemini/Ollama）不再暴露地址与协议，
  // 只有"自定义"才让用户自己填。
  const fixedEndpoint = preset !== null && isFixedEndpoint(preset);
  // 用户刚在下拉里选了服务商 = 打算换一家：此时"留空用已保存密钥"会误导，
  // 因为那个密钥属于上一家（后端也不会把它发到新地址）。但不需要密钥的服务商
  // （本机 Ollama）仍应说明留空即可。
  const changingProvider = presetId !== null && preset?.needsKey === true;

  // 保存是异步的，且**可能静默失败**（父 hook 会把异常转成界面提示后正常返回），
  // 所以必须依据它返回的明确成败信号，而不是"有没有抛异常"。
  const saveAttempt = useRef(0);
  /**
   * 任何配置改动都让"已保存"失效，并作废在途请求。
   * 包括**密钥**：密钥也是配置的一部分，改它同样意味着"当前验证结果与已保存状态
   * 不再代表用户眼前的这套配置"。以前密钥走的是另一个回调（onApiKeyDraft），
   * 两个计数器都不动，于是旧密钥的验证结果会被当成新密钥的结论。
   */
  const invalidatePending = (): void => {
    setIsSaved(false);
    modelFetch.current++;
    // 让在途的保存结果作废：否则它回来时仍会把 isSaved 置为 true。
    saveAttempt.current++;
  };
  const changeField = (patch: Partial<ProviderSettings>): void => {
    invalidatePending();
    onProviderField(patch);
  };
  const changeApiKey = (value: string): void => {
    invalidatePending();
    onApiKeyDraft(value);
  };
  const finishSave = async (operation: () => boolean | void | Promise<boolean | void>): Promise<void> => {
    const attempt = ++saveAttempt.current;
    // 保存期间又改了字段的话，这次结果不再代表当前配置。
    const revision = modelFetch.current;
    let succeeded = false;
    try {
      // 只有明确返回 true 才算确认保存；返回 false 或不返回（旧处理器）都不放行。
      succeeded = (await operation()) === true;
    } catch {
      // 失败原因由父组件的 runtimeError 呈现，这里只保证不放行。
      succeeded = false;
    }
    if (attempt !== saveAttempt.current || revision !== modelFetch.current) return;
    setIsSaved(succeeded);
  };
  const saveNow = (): void => { void finishSave(() => onSave()); };
  const saveAndTest = (): void => { void finishSave(() => onSaveAndTest()); };

  /** 切换服务商：填入该服务商的官方地址与默认模型；自定义则留空由用户填写。 */
  const handlePresetChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    const selected = PROVIDER_PRESETS.find(entry => entry.id === event.target.value);
    if (!selected) return;
    setPresetId(selected.id);
    modelFetch.current++;
    setModelOptions([]);
    setModelNotice(null);
    changeField({ kind: selected.kind, baseUrl: selected.baseUrl, model: selected.model });
  };

  /** 测试获取模型：按当前协议向服务商要一份真实模型名，拉到之后让用户挑。 */
  const handleFetchModels = async (): Promise<void> => {
    if (!provider) return;
    // 请求序号：用户可能在等待期间换了服务商或改了地址，旧响应回来时不能再写状态，
    // 否则会把旧服务的模型列表盖到新配置上、并把新配置误标为已连接。
    const attempt = ++modelFetch.current;
    // 比序号更直接：回来时确认"当时的那个配置"仍是当前配置。这样改地址、换服务商、
    // 改密钥三种情况都被覆盖，不需要在每个改字段的地方都记得递增序号。
    const requestedTarget = `${provider.kind}\u0000${provider.baseUrl}`;
    setIsFetchingModels(true);
    setModelNotice(null);
    try {
      const result = await listProviderModels({
        kind: provider.kind, baseUrl: provider.baseUrl, model: provider.model,
        temperature: provider.temperature, maxTokens: provider.maxTokens,
        contextLimitTokens: provider.contextLimitTokens, clearApiKey: false,
        ...(apiKeyDraft ? { apiKey: apiKeyDraft } : {}),
      });
      if (attempt !== modelFetch.current) return;
      // 二次确认：回来时当前配置必须仍是发起时的那一个。
      if (`${provider.kind}\u0000${provider.baseUrl}` !== requestedTarget) return;
      setModelOptions(result.models);
      setModelNotice({ ok: result.ok, message: result.message });
      // 拿到模型列表就说明密钥与地址都通了。注意顺序：自动补模型名会触发一次
      // onProviderField，而父组件会在那次更新里把"已连接"置回 false，
      // 所以必须在补完之后才放行，否则"下一步"会一闪而过。
      if (result.ok) {
        if (!provider.model && result.models[0]) onProviderField({ model: result.models[0] });
        onConnectionReady?.();
      }
    } catch (error) {
      if (attempt !== modelFetch.current) return;
      setModelOptions([]);
      setModelNotice({ ok: false, message: error instanceof Error ? error.message : t("settings.modelsFailed") });
    } finally {
      // 无条件释放加载标志：只在"仍是最新请求"时释放会让按钮永久卡在"正在获取模型"，
      // 用户连重试都点不了。
      setIsFetchingModels(false);
    }
  };

  const handleKindChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    const kind = event.target.value as ProviderSettings["kind"];
    setPresetId(null);
    modelFetch.current++;
    setModelOptions([]);
    setModelNotice(null);
    changeField({
      kind,
      baseUrl: kind === "ollama" ? "http://127.0.0.1:11434/v1" : kind === "anthropic" ? "https://api.anthropic.com/v1" : kind === "gemini" ? "https://generativelanguage.googleapis.com/v1beta" : "https://api.openai.com/v1",
      model: kind === "ollama" ? "llama3.2" : kind === "anthropic" ? "claude-sonnet-4-6" : kind === "gemini" ? "gemini-2.5-flash" : "gpt-4o-mini",
    });
  };
  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    saveAndTest();
  };
  return (
    <main className="settings-workspace">
      <header className="settings-page-head"><h1>{t("nav.settings")}</h1><p>{t("settings.pageIntro")}</p></header>
      <div className="settings-tabs" role="tablist" aria-label={t("nav.settings")} onKeyDown={handleTabKey}>
        {settingsTabs.map(tab => (
          <button key={tab.id} type="button" role="tab" id={`settings-tab-${tab.id}`}
            aria-selected={activeTab === tab.id} aria-controls={`settings-panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => setActiveTab(tab.id)}>{tab.label}</button>
        ))}
      </div>
      {activeTab === "model" ? (
      <div role="tabpanel" id="settings-panel-model" aria-labelledby="settings-tab-model">
      <section className="settings-card" aria-labelledby="provider-title">
        <header><h2 id="provider-title">{t("settings.title")}</h2><p>{selectedCharacterName ? t("settings.roleReady", { name: selectedCharacterName }) : t("settings.importFirst")}{t("settings.intro")}</p></header>
        {runtimeError ? <Notice tone="error">{t(runtimeError)}</Notice> : null}
        {providerNotice ? <Notice tone="success">{t(providerNotice)}</Notice> : null}
        {providerIssue ? <div className="provider-correction"><p>{providerIssue.suggestion}</p><button type="button" className="button button--quiet" onClick={() => {
          const id = providerIssue.field === "apiKey" ? "provider-api-key" : providerIssue.field === "model" ? "provider-model" : "provider-base-url";
          document.getElementById(id)?.focus();
        }}>{t(providerIssue.field === "apiKey" ? "settings.fixKey" : providerIssue.field === "model" ? "settings.fixModel" : "settings.fixAddress")}</button></div> : null}
        {provider ? (
          <form className="settings-form" onSubmit={handleSubmit}>
            <label><span>{t("settings.source")}</span><select aria-label={t("settings.source")} onChange={handlePresetChange} value={preset?.id ?? ""}>{preset === null ? <option value="">{t("settings.sourceChoose")}</option> : null}{PROVIDER_PRESETS.map(entry => <option key={entry.id} value={entry.id}>{presetLabel(entry, i18n.language)}</option>)}</select></label>
            {preset?.note ? <small>{i18n.language.startsWith("en") ? preset.noteEn : preset.note}</small> : null}
            {fixedEndpoint ? null : (
              <>
                <label><span>{t("settings.protocol")}</span><select aria-label={t("settings.protocol")} onChange={handleKindChange} value={provider.kind}><option value="openai-compatible">{t("settings.online")}</option><option value="ollama">{t("settings.local")}</option><option value="anthropic">{copy.anthropic}</option><option value="gemini">{copy.gemini}</option></select></label>
                <label><span>{t("settings.address")}</span><input id="provider-base-url" onChange={(event) => changeField({ baseUrl: event.target.value })} placeholder="https://api.openai.com/v1" required type="url" value={provider.baseUrl} /></label>
                <small>{t(provider.kind === "ollama" ? "settings.ollamaHelp" : "settings.onlineHelp")}</small>
              </>
            )}
            {modelOptions.length > 0 ? (
              // 拿到模型列表后换成真正的下拉：原生 datalist 只是输入建议，要双击才展开，
              // 用户根本"挑不到第二个"。
              <label><span>{t("settings.model")}</span><select aria-label={t("settings.model")} onChange={(event) => changeField({ model: event.target.value })} value={provider.model}>
                {/* 当前模型可能不在服务商返回的列表里（手填过或列表变动），保留它避免静默改写。 */}
                {provider.model && !modelOptions.includes(provider.model) ? <option value={provider.model}>{provider.model}</option> : null}
                {provider.model ? null : <option value="">{t("settings.modelChoose")}</option>}
                {modelOptions.map(name => <option key={name} value={name}>{name}</option>)}
              </select></label>
            ) : (
              <label><span>{t("settings.model")}</span><input id="provider-model" aria-label={t("settings.model")} onChange={(event) => changeField({ model: event.target.value })} placeholder={preset?.model || (provider.kind === "ollama" ? "llama3.2" : "gpt-4o-mini")} required value={provider.model} /></label>
            )}
            <div className="settings-actions">
              <button type="button" className="button button--quiet" disabled={isFetchingModels || isSavingProvider} onClick={() => void handleFetchModels()}>{t(isFetchingModels ? "settings.fetchingModels" : "settings.fetchModels")}</button>
            </div>
            {modelNotice && !modelNotice.ok ? <Notice tone="error">{modelNotice.message}</Notice> : null}
            <label><span>{t("settings.key")}</span><input id="provider-api-key" autoComplete="off" onChange={(event) => changeApiKey(event.target.value)} placeholder={t(changingProvider ? "settings.requiredKey" : provider.hasApiKey ? "settings.existingKey" : preset && !preset.needsKey ? "settings.optionalKey" : "settings.requiredKey")} type="password" value={apiKeyDraft} /></label>
            <small>{t("settings.keyHelp")}</small>
            <details className="provider-advanced"><summary>{t("settings.advanced")}</summary>
              <div className="settings-form__row"><label><span>{t("settings.temperature")}</span><input max="2" min="0" onChange={(event) => changeField({ temperature: Number(event.target.value) })} step="0.1" type="number" value={provider.temperature} /></label><label><span>{t("settings.maxTokens")}</span><input max="131072" min="1" onChange={(event) => changeField({ maxTokens: Number(event.target.value) })} type="number" value={provider.maxTokens} /></label><label><span>{t("settings.context")}</span><input max={MAX_CONTEXT_TOKENS} min="1" onChange={(event) => changeField({ contextLimitTokens: Number(event.target.value) })} type="number" value={provider.contextLimitTokens} /></label></div>
              <div className="settings-actions"><button type="button" className="button button--quiet" onClick={() => changeField({ temperature: 0.8, maxTokens: 4096, contextLimitTokens: 32768 })}>{t("settings.recommended")}</button><button type="button" className="button button--quiet" disabled={isSavingProvider} onClick={saveNow}>{t("settings.save")}</button></div>
            </details>
            <div className="settings-actions"><button className="button button--primary" disabled={isSavingProvider || applicationBusy} type="submit">{t(isSavingProvider ? "settings.testing" : "settings.test")}</button>{isConnectionReady && isSaved && onContinue ? <button className="button button--primary" type="button" onClick={onContinue}>{t(selectedCharacterName ? "settings.next" : "settings.back")}</button> : null}</div>
          </form>
        ) : <p className="panel-empty">{t("settings.loading")}</p>}
      </section>
      <ProviderProfiles disabled={Boolean(applicationBusy || isSavingProvider)} />
      <details className="settings-card"><summary>{t("settings.presets")}</summary><PresetSettings /></details>
      </div>
      ) : null}
      {activeTab === "language" ? (
      <div role="tabpanel" id="settings-panel-language" aria-labelledby="settings-tab-language">
      <section className="settings-card" aria-labelledby="language-title">
        <header><h2 id="language-title">{t("language.label")}</h2><p>{t("language.intro")}</p></header>
        <div className="settings-form">
          <select aria-label={t("language.label")} value={i18n.language === "en" ? "en" : "zh"} onChange={event => {
            setLanguageError(""); void changeUiLanguage(event.target.value as UiLanguage).catch(() => setLanguageError(t("language.failed")));
          }}><option value="zh">简体中文</option><option value="en">English</option></select>
        </div>
        {languageError ? <p role="alert">{languageError}</p> : null}
      </section>
      </div>
      ) : null}
      {activeTab === "advanced" ? (
      <div role="tabpanel" id="settings-panel-advanced" aria-labelledby="settings-tab-advanced">
      <section className="settings-card" aria-labelledby="advanced-title">
        <header><h2 id="advanced-title">{t("settings.advancedMode")}</h2><p>{t("settings.advancedModeIntro")}</p></header>
        <div className="settings-form">
          <label><input type="checkbox" checked={advancedMode} onChange={event => setAdvancedMode(event.target.checked)} />{t("settings.advancedModeToggle")}</label>
        </div>
      </section>
      </div>
      ) : null}
      {activeTab === "backup" ? (
      <div role="tabpanel" id="settings-panel-backup" aria-labelledby="settings-tab-backup">
        <BackupPanel busy={Boolean(applicationBusy)} />
      </div>
      ) : null}
    </main>
  );
}
