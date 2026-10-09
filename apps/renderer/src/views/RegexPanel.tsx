import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import "../i18n";

import type {
  CharacterRegexRule,
  RegexTestResponse,
} from "@mycompanion/shared";

import {
  listRegexRules,
  setAllRegexRulesState,
  setRegexRuleState,
  testCharacterRegex,
} from "../api";
import { Icon, placementText } from "../components";

const stageText: Record<string, string> = {
  input: "用户输入",
  prompt: "模型上下文",
  output: "模型回复",
  display: "界面显示",
};

const ruleStatusText: Record<string, string> = {
  applied: "已替换",
  no_match: "无匹配",
  skipped: "已跳过",
  failed: "执行失败",
};

/** SillyTavern 数字 placement 的显示名（编号含义见 spec FR-REGEX-002）。 */
const numberPlacementText: Record<number, string> = {
  0: "界面显示",
  1: "用户输入",
  2: "模型回复",
  3: "斜杠命令",
  5: "世界书",
  6: "推理内容",
};

function placementLabel(value: unknown): string {
  if (typeof value === "number") return numberPlacementText[value] ?? `未知阶段 ${value}`;
  if (typeof value === "string") return placementText(value);
  return `未知阶段 ${String(value)}`;
}

export interface RegexPanelProps {
  characterId: string;
  characterName: string;
  runtimeError: string | null;
}

/**
 * 角色正则规则面板（FR-REGEX-001/005/007）：
 * 逐条启用/停用、全部启用/停用，以及不修改真实聊天的规则测试器。
 */
export function RegexPanel({ characterId, characterName, runtimeError }: RegexPanelProps) {
  const { t } = useTranslation();
  // 未知阶段值（数字或字符串）走插值；已知值直接按中文名查表。
  const placementDisplay = (value: unknown): string => {
    const label = placementLabel(value);
    return label.startsWith("未知阶段 ") ? t("未知阶段 {{value}}", { value: label.slice("未知阶段 ".length) }) : t(label);
  };
  const [rules, setRules] = useState<CharacterRegexRule[] | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [testInput, setTestInput] = useState(() => t("你好，世界。"));
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<RegexTestResponse | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRules(null);
    setTestResult(null);
    setTestError(null);
    void listRegexRules(characterId)
      .then((value) => { if (!cancelled) setRules(value); })
      .catch(() => { if (!cancelled) setPanelError("无法读取该角色的正则规则。"); });
    return () => { cancelled = true; };
  }, [characterId]);

  const handleToggle = async (rule: CharacterRegexRule): Promise<void> => {
    setIsBusy(true);
    setPanelError(null);
    try {
      setRules(await setRegexRuleState(characterId, rule.order, rule.disabled));
    } catch {
      setPanelError("无法更新规则状态，请重试。");
    } finally {
      setIsBusy(false);
    }
  };

  const handleAll = async (enabled: boolean): Promise<void> => {
    setIsBusy(true);
    setPanelError(null);
    try {
      setRules(await setAllRegexRulesState(characterId, enabled));
    } catch {
      setPanelError("无法更新规则状态，请重试。");
    } finally {
      setIsBusy(false);
    }
  };

  const handleTest = async (): Promise<void> => {
    setIsTesting(true);
    setTestError(null);
    try {
      setTestResult(await testCharacterRegex(characterId, testInput));
    } catch {
      setTestError("规则测试失败，请检查规则或重试。");
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <section className="document-section regex-panel" aria-labelledby="regex-panel-title">
      <h2 id="regex-panel-title">{t("正则规则")}</h2>
      {rules === null ? (
        <p>{panelError ? t(panelError) : t("正在读取规则…")}</p>
      ) : rules.length === 0 ? (
        <p className="panel-empty">{t("这个角色卡没有可识别的正则规则。")}</p>
      ) : (
        <>
          <p>
            {t("导入的规则默认停用；启用后会在对话中按阶段执行。")}{" "}
            {t("单条规则超过 250 ms 或输出超过 2 MiB 会被自动跳过。")}
          </p>
          <div className="regex-panel__actions">
            <button className="button button--quiet button--small" disabled={isBusy} onClick={() => void handleAll(true)} type="button">{t("全部启用")}</button>
            <button className="button button--quiet button--small" disabled={isBusy} onClick={() => void handleAll(false)} type="button">{t("全部停用")}</button>
          </div>
          <ul className="regex-rule-list">
            {rules.map((rule) => (
              <li key={`${rule.order}-${rule.scriptName}`} className={`regex-rule ${rule.disabled ? "regex-rule--disabled" : ""}`}>
                <div className="regex-rule__header">
                  <strong>{rule.scriptName}</strong>
                  <button
                    aria-pressed={!rule.disabled}
                    className="button button--quiet button--small"
                    disabled={isBusy}
                    onClick={() => void handleToggle(rule)}
                    type="button"
                  >
                    {rule.disabled ? t("启用") : t("停用")}
                  </button>
                </div>
                <code className="regex-source">{rule.findRegex}</code>
                <dl>
                  <div><dt>{t("作用阶段")}</dt><dd>{rule.promptOnly ? t("仅模型上下文") : (rule.placement.map(placementDisplay).join(t("、")) || t("输入、输出与显示"))}</dd></div>
                  <div><dt>{t("替换文本")}</dt><dd>{rule.replaceString || t("（空）")}</dd></div>
                  <div><dt>{t("编辑时运行")}</dt><dd>{rule.runOnEdit ? t("是") : t("否")}</dd></div>
                </dl>
              </li>
            ))}
          </ul>
          {panelError ? <p role="alert" className="regex-panel__error">{t(panelError)}</p> : null}
          {runtimeError ? <p role="alert" className="regex-panel__error">{t(runtimeError)}</p> : null}
        </>
      )}
      {rules !== null && rules.length > 0 ? (
        <div className="regex-tester">
          <h3>{t("规则测试器")}</h3>
          <p>{t("对示例文本跑一遍四个阶段，不会修改真实聊天。")}</p>
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
            <div className="regex-tester__result">
              {testResult.stages.map((stage) => (
                <details key={stage.stage} open={stage.output !== stage.input}>
                  <summary>
                    <strong>{t(stageText[stage.stage] ?? stage.stage)}</strong>
                    <span>{stage.output === stage.input ? t("无变化") : t("已改写")}</span>
                  </summary>
                  {stage.rules.length === 0 ? (
                    <p>{t("该阶段没有启用的规则。")}</p>
                  ) : (
                    <ul>
                      {stage.rules.map((rule) => (
                        <li key={rule.name} className={`regex-rule-result regex-rule-result--${rule.status}`}>
                          <strong>{rule.name}</strong>
                          <span>{t(ruleStatusText[rule.status] ?? rule.status)} · {rule.durationMs.toFixed(1)} ms</span>
                          {rule.diagnostics.length > 0 ? <small>{rule.diagnostics.join("；")}</small> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </details>
              ))}
              <p>{t("最终输出：")}<code className="regex-source">{testResult.finalOutput}</code></p>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
