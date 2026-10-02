import { useEffect, useState } from "react";

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
  const [rules, setRules] = useState<CharacterRegexRule[] | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [testInput, setTestInput] = useState("你好，世界。");
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
      <h2 id="regex-panel-title">正则规则</h2>
      {rules === null ? (
        <p>{panelError ?? "正在读取规则…"}</p>
      ) : rules.length === 0 ? (
        <p className="panel-empty">这个角色卡没有可识别的正则规则。</p>
      ) : (
        <>
          <p>
            导入的规则默认停用；启用后会在对话中按阶段执行。
            单条规则超过 250 ms 或输出超过 2 MiB 会被自动跳过。
          </p>
          <div className="regex-panel__actions">
            <button className="button button--quiet button--small" disabled={isBusy} onClick={() => void handleAll(true)} type="button">全部启用</button>
            <button className="button button--quiet button--small" disabled={isBusy} onClick={() => void handleAll(false)} type="button">全部停用</button>
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
                    {rule.disabled ? "启用" : "停用"}
                  </button>
                </div>
                <code className="regex-source">{rule.findRegex}</code>
                <dl>
                  <div><dt>作用阶段</dt><dd>{rule.promptOnly ? "仅模型上下文" : (rule.placement.map(placementLabel).join("、") || "输入、输出与显示")}</dd></div>
                  <div><dt>替换文本</dt><dd>{rule.replaceString || "（空）"}</dd></div>
                  <div><dt>编辑时运行</dt><dd>{rule.runOnEdit ? "是" : "否"}</dd></div>
                </dl>
              </li>
            ))}
          </ul>
          {panelError ? <p role="alert" className="regex-panel__error">{panelError}</p> : null}
          {runtimeError ? <p role="alert" className="regex-panel__error">{runtimeError}</p> : null}
        </>
      )}
      {rules !== null && rules.length > 0 ? (
        <div className="regex-tester">
          <h3>规则测试器</h3>
          <p>对示例文本跑一遍四个阶段，不会修改真实聊天。</p>
          <textarea
            aria-label="测试文本"
            onChange={(event) => setTestInput(event.target.value)}
            value={testInput}
            rows={3}
          />
          <button className="button button--primary button--small" disabled={isTesting} onClick={() => void handleTest()} type="button">
            <Icon name="sparkles" size={14} />
            {isTesting ? "正在测试…" : "运行测试"}
          </button>
          {testError ? <p role="alert">{testError}</p> : null}
          {testResult ? (
            <div className="regex-tester__result">
              {testResult.stages.map((stage) => (
                <details key={stage.stage} open={stage.output !== stage.input}>
                  <summary>
                    <strong>{stageText[stage.stage] ?? stage.stage}</strong>
                    <span>{stage.output === stage.input ? "无变化" : "已改写"}</span>
                  </summary>
                  {stage.rules.length === 0 ? (
                    <p>该阶段没有启用的规则。</p>
                  ) : (
                    <ul>
                      {stage.rules.map((rule) => (
                        <li key={rule.name} className={`regex-rule-result regex-rule-result--${rule.status}`}>
                          <strong>{rule.name}</strong>
                          <span>{ruleStatusText[rule.status] ?? rule.status} · {rule.durationMs.toFixed(1)} ms</span>
                          {rule.diagnostics.length > 0 ? <small>{rule.diagnostics.join("；")}</small> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </details>
              ))}
              <p>最终输出：<code className="regex-source">{testResult.finalOutput}</code></p>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
