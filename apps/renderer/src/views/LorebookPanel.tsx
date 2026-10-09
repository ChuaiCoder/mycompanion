import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import "../i18n";

import type {
  CharacterLorebookEntry,
  LorebookReport,
} from "@mycompanion/shared";

import {
  listLorebookEntries,
  setAllLorebookEntriesState,
  setLorebookEntryState,
  testCharacterLorebook,
} from "../api";
import { Icon } from "../components";
import { listWorldInfoNames } from "../world-info-api";

const entryStatusText: Record<string, string> = {
  injected: "已注入",
  no_match: "未触发",
  budget_dropped: "超出预算舍弃",
  disabled: "未启用",
};

export interface LorebookPanelProps {
  characterId: string;
  characterName: string;
  runtimeError: string | null;
  primaryWorld?: string | undefined;
}

/**
 * 角色世界书面板（FR-LORE-001/002/003）：
 * 逐条启用/停用、全部启用/停用，以及不修改真实聊天的匹配测试器。
 */
export function LorebookPanel({ characterId, characterName, runtimeError, primaryWorld }: LorebookPanelProps) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<CharacterLorebookEntry[] | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [testInput, setTestInput] = useState(() => t("我们现在在哪里？"));
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<LorebookReport | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [namedBinding, setNamedBinding] = useState("");
  useEffect(() => {
    let disposed = false;
    const update = () => {
      if (!primaryWorld) { setNamedBinding(""); return; }
      void listWorldInfoNames().then(names => {
        if (!disposed) setNamedBinding(names.includes(primaryWorld) ? primaryWorld : "");
      }).catch(() => {});
    };
    update(); window.addEventListener("mycompanion:world-info", update);
    return () => { disposed = true; window.removeEventListener("mycompanion:world-info", update); };
  }, [primaryWorld]);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setTestResult(null);
    setTestError(null);
    void listLorebookEntries(characterId)
      .then((value) => { if (!cancelled) setEntries(value); })
      .catch(() => { if (!cancelled) setPanelError("无法读取该角色的世界书条目。"); });
    return () => { cancelled = true; };
  }, [characterId]);

  const handleToggle = async (entry: CharacterLorebookEntry): Promise<void> => {
    setIsBusy(true);
    setPanelError(null);
    try {
      setEntries(await setLorebookEntryState(characterId, entry.index, !entry.enabled));
    } catch {
      setPanelError("无法更新条目状态，请重试。");
    } finally {
      setIsBusy(false);
    }
  };

  const handleAll = async (enabled: boolean): Promise<void> => {
    setIsBusy(true);
    setPanelError(null);
    try {
      setEntries(await setAllLorebookEntriesState(characterId, enabled));
    } catch {
      setPanelError("无法更新条目状态，请重试。");
    } finally {
      setIsBusy(false);
    }
  };

  const handleTest = async (): Promise<void> => {
    setIsTesting(true);
    setTestError(null);
    try {
      setTestResult(await testCharacterLorebook(characterId, testInput));
    } catch {
      setTestError("世界书匹配测试失败，请检查条目或重试。");
    } finally {
      setIsTesting(false);
    }
  };

  if (namedBinding) return <section className="document-section lorebook-panel" aria-label={t("角色世界书绑定")}>
    <h2>{t("世界书")}</h2><p>{t("当前角色使用 ")}<strong>{namedBinding}</strong>{t("。在世界书编辑器中修改条目和启用状态，原始随卡内容仍保留在角色卡中。")}</p>
    <button type="button" className="button button--primary button--small" onClick={() => window.dispatchEvent(new CustomEvent("mycompanion:world-editor", { detail: { name: namedBinding } }))}>{t("编辑绑定的世界书")}</button>
  </section>;
  return (
    <section className="document-section lorebook-panel" aria-labelledby="lorebook-panel-title">
      <h2 id="lorebook-panel-title">{t("世界书")}</h2>
      {entries === null ? (
        <p>{panelError ? t(panelError) : t("正在读取条目…")}</p>
      ) : entries.length === 0 ? (
        <p className="panel-empty">{t("这个角色卡没有可识别的世界书条目。")}</p>
      ) : (
        <>
          <p>
            {t("这里显示原始随卡条目的启用状态。编辑内容和高级匹配时，点击“编辑角色的世界书”保存并绑定到独立世界书。")}{" "}
            {t("对话实际使用的条目与预算可以在提示词预览中检查。")}
          </p>
          <div className="lorebook-panel__actions">
            <button className="button button--quiet button--small" disabled={isBusy} onClick={() => void handleAll(true)} type="button">{t("全部启用")}</button>
            <button className="button button--quiet button--small" disabled={isBusy} onClick={() => void handleAll(false)} type="button">{t("全部停用")}</button>
          </div>
          <ul className="lorebook-entry-list">
            {entries.map((entry) => (
              <li key={`${entry.index}-${entry.name}`} className={`lorebook-entry ${entry.enabled ? "" : "lorebook-entry--disabled"}`}>
                <div className="lorebook-entry__header">
                  <strong>{entry.name}</strong>
                  <button
                    aria-pressed={entry.enabled}
                    className="button button--quiet button--small"
                    disabled={isBusy}
                    onClick={() => void handleToggle(entry)}
                    type="button"
                  >
                    {entry.enabled ? t("停用") : t("启用")}
                  </button>
                </div>
                <dl>
                  <div><dt>{t("触发方式")}</dt><dd>{entry.constant ? t("常驻（每轮注入）") : (entry.keys.length > 0 ? `${t("关键词：{{keys}}", { keys: entry.keys.join(t("、")) })}${entry.secondaryKeys.length > 0 ? t("；可选：{{keys}}", { keys: entry.secondaryKeys.join(t("、")) }) : ""}` : t("无关键词，不会触发"))}</dd></div>
                  <div><dt>{t("大小写")}</dt><dd>{entry.caseSensitive ? t("区分") : t("不区分")}</dd></div>
                  <div><dt>{t("插入顺序")}</dt><dd>{entry.insertionOrder}</dd></div>
                  <div><dt>{t("卡内状态")}</dt><dd>{entry.sourceEnabled ? t("启用") : t("停用")}</dd></div>
                </dl>
                <code className="lorebook-entry__content">{entry.content}</code>
              </li>
            ))}
          </ul>
          {panelError ? <p role="alert" className="lorebook-panel__error">{t(panelError)}</p> : null}
          {runtimeError ? <p role="alert" className="lorebook-panel__error">{t(runtimeError)}</p> : null}
        </>
      )}
      {entries !== null && entries.length > 0 ? (
        <div className="lorebook-tester">
          <h3>{t("匹配测试器")}</h3>
          <p>{t("对示例文本跑一次关键词匹配，不会修改真实聊天。")}</p>
          <textarea
            aria-label={t("测试文本")}
            onChange={(event) => setTestInput(event.target.value)}
            value={testInput}
            rows={3}
          />
          <button className="button button--primary button--small" disabled={isTesting} onClick={() => void handleTest()} type="button">
            <Icon name="sparkles" size={14} />
            {isTesting ? t("正在测试…") : t("运行测试")}
          </button>
          {testError ? <p role="alert">{t(testError)}</p> : null}
          {testResult ? (
            <div className="lorebook-tester__result">
              {testResult.results.map((result) => (
                <div key={result.index} className={`lorebook-result lorebook-result--${result.status}`}>
                  <strong>{result.name}</strong>
                  <span>
                    {t(entryStatusText[result.status] ?? result.status)}
                    {result.matchedKey ? t(" · 命中“{{key}}”", { key: result.matchedKey }) : ""}
                    {t(" · 约 ")}{result.tokens} token
                  </span>
                  {result.diagnostics.length > 0 ? <small>{result.diagnostics.join("；")}</small> : null}
                </div>
              ))}
              <p>{t("注入位置：系统提示词“世界书”区域（{{count}} 条 · 预算 {{budget}} token）", { count: testResult.injectedCount, budget: testResult.budgetTokens })}</p>
              <p>{t("注入内容：")}<code className="lorebook-entry__content">{testResult.block || t("（本轮没有注入）")}</code></p>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
