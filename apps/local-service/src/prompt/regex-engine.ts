import { Worker } from "node:worker_threads";
import { createTavernRegexEngine } from "./tavern-regex-core.js";
import {
  characterRegexRuleSchema,
  type CharacterRegexRule,
  type RegexRuleResult,
  type RegexStage,
} from "@mycompanion/shared";

/**
 * 卡内正则的离线诊断测试器（FR-REGEX-001…007）。实际聊天使用 TavernRegexExecutor。
 *
 * - 诊断界面依次显示 input/prompt/output/display，替换复用同一酒馆兼容内核；
 * - prompt 与 display 只作用于副本，不覆盖已保存原文；
 * - 替换文本支持 JS 捕获组（$1、$<name>）与 {{char}}/{{user}} 宏，
 *   未知宏保持原文并产生非阻断警告；
 * - 硬预算：单条规则 250 ms、单阶段 1000 ms、表达式 4 KiB、输入 1 MiB、输出 2 MiB。
 *
 * 安全模型：规则表达式在一次性 worker 线程中求值。表达式是卡片导入的不可信数据
 * （如 "/北行/gi"），但 worker 内仍执行宿主运行时，因此：
 * - worker 在每条规则后 terminate()，规则之间互不继承状态，死循环无法逃逸 250 ms 预算；
 * - 超时、语法错误、超输出上限都只记录诊断并保留原输入，不阻断其余规则。
 */

export const REGEX_RULE_TIMEOUT_MS = 250;
export const REGEX_STAGE_BUDGET_MS = 1_000;
export const REGEX_EXPRESSION_MAX_BYTES = 4 * 1024;
export const REGEX_INPUT_MAX_BYTES = 1024 * 1024;
export const REGEX_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;

const REGEX_SCRIPTS_EXTENSION_KEY = "regex_scripts";

/** SillyTavern placement 编号 → 本应用阶段名（见 spec FR-REGEX-002）。 */
const PLACEMENT_TO_STAGES: Record<number, RegexStage[]> = {
  0: [],
  1: ["input"],
  2: ["output"],
  3: [],
  5: [],
  6: [],
};

const STAGE_NAMES: Record<string, RegexStage[]> = {
  input: ["input"],
  prompt: ["prompt"],
  output: ["output"],
  display: ["display"],
};

const KNOWN_MACROS = /\{\{\s*(char|user)\s*\}\}/gi;

/** 从角色卡原始扩展字段解析规则（FR-REGEX-001：未映射字段保留在 original 中）。 */
export function parseCharacterRegexRules(
  rawExtensions: Record<string, unknown>,
): CharacterRegexRule[] {
  const scripts = rawExtensions[REGEX_SCRIPTS_EXTENSION_KEY];
  if (!Array.isArray(scripts)) return [];
  return scripts.flatMap((value, index) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return [];
    }
    const parsed = characterRegexRuleSchema.safeParse(value);
    if (!parsed.success) return [];
    // FR-REGEX-002：没有显式顺序时保持导入顺序。
    if (!("order" in (value as Record<string, unknown>))) {
      parsed.data.order = index;
    }
    return [parsed.data];
  });
}

export function stagesForRule(rule: CharacterRegexRule): RegexStage[] {
  const stages = new Set<RegexStage>();
  for (const placement of rule.placement) {
    if (typeof placement === "number") {
      for (const stage of PLACEMENT_TO_STAGES[placement] ?? []) {
        stages.add(stage);
      }
    } else if (typeof placement === "string") {
      for (const stage of STAGE_NAMES[placement.toLowerCase()] ?? []) {
        stages.add(stage);
      }
    }
  }
  if (stages.size && (rule.promptOnly || rule.markdownOnly)) {
    stages.clear();
    if (rule.promptOnly) stages.add("prompt");
    if (rule.markdownOnly) stages.add("display");
  }
  return (["input", "prompt", "output", "display"] as RegexStage[])
    .filter((stage) => stages.has(stage));
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function resolveMacros(text: string, characterName: string): {
  resolved: string;
  unknownMacros: string[];
} {
  const unknown = new Set<string>();
  const resolved = text.replace(/\{\{([^{}]{1,64})\}\}/g, (match, token: string) => {
    const name = token.trim().toLowerCase();
    if (name === "char") return characterName;
    if (name === "user") return "User";
    if (name === "match") return match;
    unknown.add(match);
    return match;
  });
  return { resolved, unknownMacros: [...unknown] };
}

export function hasUnknownMacros(text: string): boolean {
  return /\{\{(?!\s*(char|user)\s*\}\})[^{}]*\}\}/i.test(text);
}


// worker 内的执行体：接收表达式与输入，输出替换结果。
// 使用 data: URL 模块，避免依赖构建产物路径；terminate() 保证可中断。
const REGEX_WORKER_SOURCE = `
  import { parentPort } from "node:worker_threads";
  const createEngine = ${createTavernRegexEngine.toString()};
  parentPort.on("message", (message) => {
    const { rule, input, characterName } = message;
    try {
      const engine = createEngine(text => String(text).replace(/{{\\s*(char|user)\\s*}}/gi, (_match, key) => key.toLowerCase() === 'char' ? characterName : 'User'));
      if (!rule.substituteRegex && !engine.RegexProvider.instance.get(rule.findRegex)) throw new Error('Invalid regular expression');
      parentPort.postMessage({ ok: true, output: engine.runRegexScript(rule, input) });
    } catch (error) {
      parentPort.postMessage({ ok: false, error: String(error && error.message || error) });
    }
  });
`;

interface WorkerResult {
  ok: boolean;
  output?: string;
  error?: string;
}

function runRuleInWorker(request: {
  rule: CharacterRegexRule;
  input: string;
  characterName: string;
}, timeoutMs: number): Promise<WorkerResult> {
  return new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(new URL("data:text/javascript," + encodeURIComponent(REGEX_WORKER_SOURCE)));
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        void worker.terminate();
        resolve({ ok: false, error: `timeout:${timeoutMs}` });
      }
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ ok: false, error: "worker-exited" });
      }
    };
    worker.on("message", (message: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.off("exit", onExit);
      void worker.terminate();
      resolve(message as WorkerResult);
    });
    worker.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve({ ok: false, error: String(error.message || error) });
    });
    worker.on("exit", onExit);
    worker.postMessage(request);
  });
}

export interface RegexStageReport {
  stage: RegexStage;
  input: string;
  output: string;
  rules: RegexRuleResult[];
}

export interface RegexRunReport {
  stages: RegexStageReport[];
  finalOutput: string;
  durationMs: number;
}

/** 规则测试器用：在给定文本上跑完整四阶段流水线（FR-REGEX-007，不修改聊天）。 */
export async function testRegexRules(
  rules: CharacterRegexRule[],
  characterName: string,
  input: string,
): Promise<RegexRunReport> {
  const start = Date.now();
  const stages: RegexStageReport[] = [];
  let current = input;
  for (const stage of ["input", "prompt", "output", "display"] as RegexStage[]) {
    const stageInput = current;
    const stageOutput = await runStage(rules, characterName, stage, current);
    current = stageOutput.output;
    stages.push({ stage, input: stageInput, output: stageOutput.output, rules: stageOutput.rules });
  }
  return { stages, finalOutput: current, durationMs: Date.now() - start };
}

/** 对单阶段执行所有已启用规则；返回该阶段的最终文本与逐规则诊断。 */
export async function runStage(
  rules: CharacterRegexRule[],
  characterName: string,
  stage: RegexStage,
  input: string,
): Promise<{ output: string; rules: RegexRuleResult[] }> {
  const results: RegexRuleResult[] = [];
  let current = input;
  const stageStart = Date.now();

  // 与实际执行一样，保留规则数组顺序。
  const ordered = [...rules]
    .filter((rule) => stagesForRule(rule).includes(stage));

  for (const rule of ordered) {
    // 阶段总预算耗尽后，剩余规则跳过（FR-REGEX-005：单阶段 1000 ms）。
    if (Date.now() - stageStart >= REGEX_STAGE_BUDGET_MS) {
      results.push({
        name: rule.scriptName,
        stage,
        status: "skipped",
        output: current,
        durationMs: 0,
        diagnostics: ["阶段总预算（1000 ms）已耗尽，规则被跳过。"],
      });
      continue;
    }
    const result = await runSingleRule(rule, characterName, stage, current);
    current = result.output;
    results.push(result);
  }
  return { output: current, rules: results };
}

async function runSingleRule(
  rule: CharacterRegexRule,
  characterName: string,
  stage: RegexStage,
  input: string,
): Promise<RegexRuleResult> {
  const base = { name: rule.scriptName, stage, output: input, durationMs: 0, diagnostics: [] as string[] };
  if (rule.disabled) {
    return { ...base, status: "skipped" };
  }
  const diagnostics: string[] = [];

  if (utf8Length(rule.findRegex) > REGEX_EXPRESSION_MAX_BYTES) {
    return { ...base, status: "failed", diagnostics: ["查找表达式超过 4 KiB 上限，规则被跳过。"] };
  }
  if (utf8Length(input) > REGEX_INPUT_MAX_BYTES) {
    return { ...base, status: "failed", diagnostics: ["输入文本超过 1 MiB 上限，规则被跳过。"] };
  }

  // 宏在执行前解析；未知宏保持原文并产生非阻断警告（FR-REGEX-004）。
  const { unknownMacros } = resolveMacros(rule.replaceString, characterName);
  if (unknownMacros.length > 0) {
    diagnostics.push(`未知宏保持原文：${unknownMacros.join("、")}`);
  }

  const start = Date.now();
  const workerResult = await runRuleInWorker(
    { rule, input, characterName },
    REGEX_RULE_TIMEOUT_MS,
  );
  const durationMs = Date.now() - start;

  if (!workerResult.ok) {
    diagnostics.push(
      workerResult.error?.startsWith("timeout:")
        ? "规则执行超过 250 ms，已终止并保留原输入。"
        : `规则执行失败：${workerResult.error ?? "未知错误"}`,
    );
    return { ...base, status: "failed", durationMs, diagnostics };
  }
  const output = workerResult.output ?? input;
  if (utf8Length(output) > REGEX_OUTPUT_MAX_BYTES) {
    return { ...base, status: "failed", durationMs, diagnostics: [...diagnostics, "输出超过 2 MiB 上限，规则结果被丢弃。"] };
  }
  const applied = output !== input;
  return {
    ...base,
    status: applied ? "applied" : "no_match",
    output,
    durationMs,
    diagnostics,
  };
}

export { KNOWN_MACROS };
