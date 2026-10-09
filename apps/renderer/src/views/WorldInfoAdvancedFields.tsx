import { useTranslation } from "react-i18next";
import "../i18n";

interface Props { entry: Record<string, unknown>; onChange(patch: Record<string, unknown>): void }
export function WorldInfoAdvancedFields({ entry, onChange }: Props) {
  const { t } = useTranslation();
  const number = (key: string, label: string, fallback: number, max = 1000, inherit = false, placeholder?: string) => <label>{t(label)}<input data-world-info-field={key} type="number" min={0} max={max} value={entry[key] == null ? inherit ? "" : fallback : Number(entry[key])} placeholder={inherit ? t(placeholder ?? "沿用全局") : undefined} onChange={event => onChange({ [key]: event.target.value === "" && inherit ? null : event.target.valueAsNumber || 0 })} /></label>;
  const check = (key: string, label: string) => <label key={key}><input data-world-info-field={key} type="checkbox" checked={Boolean(entry[key])} onChange={event => onChange({ [key]: event.target.checked })} />{t(label)}</label>;
  const inherited = (key: string, label: string) => <label>{t(label)}<select data-world-info-field={key} value={entry[key] == null ? "inherit" : entry[key] ? "yes" : "no"} onChange={event => onChange({ [key]: event.target.value === "inherit" ? null : event.target.value === "yes" })}><option value="inherit">{t("沿用全局")}</option><option value="yes">{t("是")}</option><option value="no">{t("否")}</option></select></label>;
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const triggers = strings(entry.triggers), knownTriggers = ["normal", "continue", "impersonate", "swipe", "regenerate", "quiet"];
  const filter = entry.characterFilter && typeof entry.characterFilter === "object" && !Array.isArray(entry.characterFilter) ? entry.characterFilter as Record<string, unknown> : {};
  const position = Number(entry.position ?? 0);
  return <details className="world-info-advanced"><summary>{t("高级匹配与插入")}</summary>
    <div className="world-info-settings">
      <label>{t("辅助关键词（每行一个）")}<textarea data-world-info-field="keysecondary" value={strings(entry.keysecondary).join("\n")} onChange={event => onChange({ keysecondary: event.target.value.split("\n").filter(Boolean) })} /></label>
      {check("selective", "检查辅助关键词")}
      <label>{t("辅助关键词条件")}<select data-world-info-field="selectiveLogic" value={Number(entry.selectiveLogic ?? 0)} onChange={event => onChange({ selectiveLogic: Number(event.target.value) })}><option value={0}>{t("任一匹配")}</option><option value={3}>{t("全部匹配")}</option><option value={2}>{t("全部不匹配")}</option><option value={1}>{t("至少一个不匹配")}</option></select></label>
      {number("order", "插入顺序", 100, 100000)}
      <label>{t("插入位置")}<select data-world-info-field="position" value={position} onChange={event => onChange({ position: Number(event.target.value) })}><option value={0}>{t("角色设定之前")}</option><option value={1}>{t("角色设定之后")}</option><option value={2}>{t("作者注释之前")}</option><option value={3}>{t("作者注释之后")}</option><option value={4}>{t("对话中指定深度")}</option><option value={5}>{t("示例对话之前")}</option><option value={6}>{t("示例对话之后")}</option><option value={7}>{t("命名插入口")}</option>{![0, 1, 2, 3, 4, 5, 6, 7].includes(position) ? <option value={position}>{t("保留卡片位置 {{position}}", { position })}</option> : null}</select></label>
      {position === 7 ? <label>{t("插入口名称")}<input data-world-info-field="outletName" value={String(entry.outletName ?? "")} onChange={event => onChange({ outletName: event.target.value })} /><small>{t("在提示词中用 {{placeholder}} 引用此处的内容。", { placeholder: "{{outlet::名称}}" })}</small></label> : null}
      {number("depth", "距最新消息的深度", 4)}
      <label>{t("插入消息身份")}<select data-world-info-field="role" value={Number(entry.role ?? 0)} onChange={event => onChange({ role: Number(event.target.value) })}><option value={0}>{t("系统")}</option><option value={1}>{t("用户")}</option><option value={2}>{t("角色")}</option></select></label>
      {number("scanDepth", "扫描最近消息数（留空沿用全局）", 2, 1000, true)}
      {inherited("caseSensitive", "区分大小写")}{inherited("matchWholeWords", "整词匹配")}
      {check("useProbability", "按概率触发")}{number("probability", "触发概率（%）", 100, 100)}
      {check("ignoreBudget", "忽略世界书预算")}{check("excludeRecursion", "仅在首轮扫描匹配")}{check("preventRecursion", "内容不触发递归扫描")}
      {check("vectorized", "参与向量匹配（需在向量匹配设置中启用）")}
      {number("delayUntilRecursion", "从第几轮递归开始（0 为首轮）", 0)}
      <label>{t("互斥组（多个组用逗号分隔）")}<input data-world-info-field="group" value={String(entry.group ?? "")} onChange={event => onChange({ group: event.target.value })} /></label>
      {check("groupOverride", "组内优先使用此条目")}{number("groupWeight", "组内随机权重", 100, 10000)}{inherited("useGroupScoring", "按关键词匹配数量选择组内条目")}
      {number("sticky", "持续触发消息数（留空停用）", 0, 100000, true, "停用")}{number("cooldown", "触发后冷却消息数（留空停用）", 0, 100000, true, "停用")}{number("delay", "至少经过多少消息后触发（留空停用）", 0, 100000, true, "停用")}
      <label>{t("快速回复自动化 ID")}<input data-world-info-field="automationId" value={String(entry.automationId ?? "")} onChange={event => onChange({ automationId: event.target.value })} /><small>{t("条目激活时执行已配置的同 ID 快速回复。")}</small></label>
      <label>{t("触发类型（未选择时适用所有类型）")}<select data-world-info-field="triggers" multiple value={triggers} onChange={event => onChange({ triggers: [...event.target.selectedOptions].map(option => option.value) })}>
        {[ ["normal", "正常对话"], ["continue", "继续回复"], ["impersonate", "代写用户"], ["swipe", "新候选回复"], ["regenerate", "重新生成"], ["quiet", "后台生成"] ].map(([value, label]) => <option key={value} value={value}>{t(label!)}</option>)}
        {triggers.filter(value => !knownTriggers.includes(value)).map(value => <option key={value} value={value}>{t("保留类型：{{value}}", { value })}</option>)}
      </select></label>
      <label>{t("角色筛选（每行一个角色文件名，不含 .png）")}<textarea data-world-info-field="characterFilter.names" value={strings(filter.names).join("\n")} onChange={event => onChange({ characterFilter: { ...filter, names: event.target.value.split("\n").filter(Boolean) } })} /></label>
      <label><input data-world-info-field="characterFilter.isExclude" type="checkbox" checked={Boolean(filter.isExclude)} onChange={event => onChange({ characterFilter: { ...filter, isExclude: event.target.checked } })} />{t("排除这些角色（未选中时仅匹配这些角色）")}</label>
      {[ ["matchPersonaDescription", "匹配用户人设"], ["matchCharacterDescription", "匹配角色设定"], ["matchCharacterPersonality", "匹配角色性格"], ["matchCharacterDepthPrompt", "匹配角色深度提示"], ["matchScenario", "匹配场景"], ["matchCreatorNotes", "匹配作者备注"] ].map(([key, label]) => check(key!, label!))}
    </div>
  </details>;
}
