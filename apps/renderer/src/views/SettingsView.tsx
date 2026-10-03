import { useState, type ChangeEvent, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { changeUiLanguage, type UiLanguage } from "../i18n";

import { MAX_CONTEXT_TOKENS, type ProviderConnectionResponse, type ProviderSettings } from "@mycompanion/shared";

import { Notice } from "../components";
import { PresetSettings } from "./PresetSettings";
import { BackupPanel } from "./BackupPanel";
import { ProviderProfiles } from "./ProviderProfiles";
import { providerCopy } from "../provider-translations";

export interface SettingsViewProps {
  provider: ProviderSettings | null;
  apiKeyDraft: string;
  isSavingProvider: boolean;
  runtimeError: string | null;
  providerNotice: string | null;
  onProviderField: (patch: Partial<ProviderSettings>) => void;
  onApiKeyDraft: (value: string) => void;
  onSave: () => void;
  onSaveAndTest: () => void;
  applicationBusy?: boolean;
  providerIssue?: ProviderConnectionResponse["issue"];
  isConnectionReady?: boolean;
  selectedCharacterName?: string | undefined;
  onContinue?: () => void;
}

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
  providerIssue, isConnectionReady, selectedCharacterName, onContinue,
}: SettingsViewProps) {
  const { t, i18n } = useTranslation();
  const copy = providerCopy(i18n.language);
  const [languageError, setLanguageError] = useState("");
  const handleKindChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    const kind = event.target.value as ProviderSettings["kind"];
    onProviderField({
      kind,
      baseUrl: kind === "ollama" ? "http://127.0.0.1:11434/v1" : kind === "anthropic" ? "https://api.anthropic.com/v1" : kind === "gemini" ? "https://generativelanguage.googleapis.com/v1beta" : "https://api.openai.com/v1",
      model: kind === "ollama" ? "llama3.2" : kind === "anthropic" ? "claude-sonnet-4-6" : kind === "gemini" ? "gemini-2.5-flash" : "gpt-4o-mini",
    });
  };
  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    onSaveAndTest();
  };
  return (
    <main className="settings-workspace">
      <section className="settings-card"><label>{t("language.label")}<select aria-label={t("language.label")} value={i18n.language === "en" ? "en" : "zh"} onChange={event => {
        setLanguageError(""); void changeUiLanguage(event.target.value as UiLanguage).catch(() => setLanguageError(t("language.failed")));
      }}><option value="zh">简体中文</option><option value="en">English</option></select></label>{languageError ? <p role="alert">{languageError}</p> : null}</section>
      <ProviderProfiles disabled={Boolean(applicationBusy || isSavingProvider)} />
      <section className="settings-card" aria-labelledby="provider-title">
        <header><p className="eyebrow">{t("settings.step")}</p><h1 id="provider-title">{t("settings.title")}</h1><p>{selectedCharacterName ? t("settings.roleReady", { name: selectedCharacterName }) : t("settings.importFirst")}{t("settings.intro")}</p></header>
        {runtimeError ? <Notice tone="error">{runtimeError}</Notice> : null}
        {providerNotice ? <Notice tone="success">{providerNotice}</Notice> : null}
        {providerIssue ? <div className="provider-correction"><p>{providerIssue.suggestion}</p><button type="button" className="button button--quiet" onClick={() => {
          const id = providerIssue.field === "apiKey" ? "provider-api-key" : providerIssue.field === "model" ? "provider-model" : "provider-base-url";
          document.getElementById(id)?.focus();
        }}>{t(providerIssue.field === "apiKey" ? "settings.fixKey" : providerIssue.field === "model" ? "settings.fixModel" : "settings.fixAddress")}</button></div> : null}
        {provider ? (
          <form className="settings-form" onSubmit={handleSubmit}>
            <label><span>{t("settings.source")}</span><select value={provider.kind} onChange={handleKindChange}><option value="openai-compatible">{t("settings.online")}</option><option value="ollama">{t("settings.local")}</option><option value="anthropic">{copy.anthropic}</option><option value="gemini">{copy.gemini}</option></select></label>
            <label><span>{t("settings.address")}</span><input id="provider-base-url" onChange={(event) => onProviderField({ baseUrl: event.target.value })} placeholder="https://api.openai.com/v1" required type="url" value={provider.baseUrl} /></label>
            <small>{t(provider.kind === "ollama" ? "settings.ollamaHelp" : "settings.onlineHelp")}</small>
            <label><span>{t("settings.model")}</span><input id="provider-model" onChange={(event) => onProviderField({ model: event.target.value })} placeholder={provider.kind === "ollama" ? "llama3.2" : "gpt-4o-mini"} required value={provider.model} /></label>
            <label><span>{t("settings.key")}</span><input id="provider-api-key" autoComplete="off" onChange={(event) => onApiKeyDraft(event.target.value)} placeholder={t(provider.hasApiKey ? "settings.existingKey" : "settings.optionalKey")} type="password" value={apiKeyDraft} /></label>
            <small>{t("settings.keyHelp")}</small>
            <details className="provider-advanced"><summary>{t("settings.advanced")}</summary>
              <div className="settings-form__row"><label><span>{t("settings.temperature")}</span><input max="2" min="0" onChange={(event) => onProviderField({ temperature: Number(event.target.value) })} step="0.1" type="number" value={provider.temperature} /></label><label><span>{t("settings.maxTokens")}</span><input max="131072" min="1" onChange={(event) => onProviderField({ maxTokens: Number(event.target.value) })} type="number" value={provider.maxTokens} /></label><label><span>{t("settings.context")}</span><input max={MAX_CONTEXT_TOKENS} min="1" onChange={(event) => onProviderField({ contextLimitTokens: Number(event.target.value) })} type="number" value={provider.contextLimitTokens} /></label></div>
              <div className="settings-actions"><button type="button" className="button button--quiet" onClick={() => onProviderField({ temperature: 0.8, maxTokens: 1024, contextLimitTokens: 32768 })}>{t("settings.recommended")}</button><button type="button" className="button button--quiet" disabled={isSavingProvider} onClick={onSave}>{t("settings.save")}</button></div>
            </details>
            <div className="settings-actions"><button className="button button--primary" disabled={isSavingProvider || applicationBusy} type="submit">{t(isSavingProvider ? "settings.testing" : "settings.test")}</button>{isConnectionReady && onContinue ? <button className="button button--primary" type="button" onClick={onContinue}>{t(selectedCharacterName ? "settings.next" : "settings.back")}</button> : null}</div>
          </form>
        ) : <p className="panel-empty">{t("settings.loading")}</p>}
      </section>
      <details className="settings-card"><summary>{t("settings.presets")}</summary><PresetSettings /></details>
      <BackupPanel busy={Boolean(applicationBusy)} />
    </main>
  );
}
