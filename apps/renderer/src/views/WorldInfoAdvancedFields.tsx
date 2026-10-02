interface Props { entry: Record<string, unknown>; onChange(patch: Record<string, unknown>): void }
export function WorldInfoAdvancedFields({ entry, onChange }: Props) {
  const number = (key: string, label: string, fallback: number, max = 1000, inherit = false) => <label>{label}<input type="number" min={0} max={max} value={entry[key] == null ? inherit ? "" : fallback : Number(entry[key])} placeholder={inherit ? "沿用全局" : undefined} onChange={event => onChange({ [key]: event.target.value === "" && inherit ? null : event.target.valueAsNumber || 0 })} /></label>;
  const check = (key: string, label: string) => <label key={key}><input type="checkbox" checked={Boolean(entry[key])} onChange={event => onChange({ [key]: event.target.checked })} />{label}</label>;
  const inherited = (key: string, label: string) => <label>{label}<select value={entry[key] == null ? "inherit" : entry[key] ? "yes" : "no"} onChange={event => onChange({ [key]: event.target.value === "inherit" ? null : event.target.value === "yes" })}><option value="inherit">沿用全局</option><option value="yes">是</option><option value="no">否</option></select></label>;
  const position = Number(entry.position ?? 0);
  return <details className="world-info-advanced"><summary>高级匹配与插入</summary>
    <div className="world-info-settings">
      <label>辅助关键词（每行一个）<textarea value={Array.isArray(entry.keysecondary) ? entry.keysecondary.join("\n") : ""} onChange={event => onChange({ keysecondary: event.target.value.split("\n").filter(Boolean) })} /></label>
      {check("selective", "检查辅助关键词")}
      <label>辅助关键词条件<select value={Number(entry.selectiveLogic ?? 0)} onChange={event => onChange({ selectiveLogic: Number(event.target.value) })}><option value={0}>任一匹配</option><option value={3}>全部匹配</option><option value={2}>全部不匹配</option><option value={1}>至少一个不匹配</option></select></label>
      {number("order", "插入顺序", 100, 100000)}
      <label>插入位置<select value={position} onChange={event => onChange({ position: Number(event.target.value) })}><option value={0}>角色设定之前</option><option value={1}>角色设定之后</option><option value={2}>作者注释之前</option><option value={3}>作者注释之后</option><option value={4}>对话中指定深度</option><option value={5}>示例对话之前</option><option value={6}>示例对话之后</option>{![0, 1, 2, 3, 4, 5, 6].includes(position) ? <option value={position}>保留卡片位置 {position}</option> : null}</select></label>
      {number("depth", "距最新消息的深度", 4)}
      <label>插入消息身份<select value={Number(entry.role ?? 0)} onChange={event => onChange({ role: Number(event.target.value) })}><option value={0}>系统</option><option value={1}>用户</option><option value={2}>角色</option></select></label>
      {number("scanDepth", "扫描最近消息数（留空沿用全局）", 2, 1000, true)}
      {inherited("caseSensitive", "区分大小写")}{inherited("matchWholeWords", "整词匹配")}
      {check("useProbability", "按概率触发")}{number("probability", "触发概率（%）", 100, 100)}
      {check("ignoreBudget", "忽略世界书预算")}{check("excludeRecursion", "仅在首轮扫描匹配")}{check("preventRecursion", "内容不触发递归扫描")}
      {number("delayUntilRecursion", "从第几轮递归开始（0 为首轮）", 0)}
      {[ ["matchPersonaDescription", "匹配用户人设"], ["matchCharacterDescription", "匹配角色设定"], ["matchCharacterPersonality", "匹配角色性格"], ["matchCharacterDepthPrompt", "匹配角色深度提示"], ["matchScenario", "匹配场景"], ["matchCreatorNotes", "匹配作者备注"] ].map(([key, label]) => check(key!, label!))}
    </div>
  </details>;
}
