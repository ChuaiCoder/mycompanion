import { useEffect, useRef, useState } from "react";
import type { CharacterDetail } from "@mycompanion/shared";
import { ApiRequestError, fetchCharacterCard, updateCharacter } from "../api";
import { CharacterAvatar } from "../components";
import { listWorldInfoNames } from "../world-info-api";

interface CharacterForm {
  ch_name: string; description: string; personality: string; scenario: string; first_mes: string;
  alternateGreetings: string[]; world: string; depthPrompt: string; depthDepth: number; depthRole: number;
  mes_example: string; system_prompt: string; post_history_instructions: string;
  creator_notes: string; creator: string; character_version: string; tags: string;
}

const emptyForm: CharacterForm = {
  ch_name: "", description: "", personality: "", scenario: "", first_mes: "",
  alternateGreetings: [], world: "", depthPrompt: "", depthDepth: 4, depthRole: 0,
  mes_example: "", system_prompt: "", post_history_instructions: "",
  creator_notes: "", creator: "", character_version: "", tags: "",
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";

function formFromCard(card: Record<string, unknown>): CharacterForm {
  const data = record(card.data), extensions = record(data.extensions), depth = record(extensions.depth_prompt);
  return {
    ch_name: text(data.name), description: text(data.description), personality: text(data.personality),
    scenario: text(data.scenario), first_mes: text(data.first_mes),
    alternateGreetings: Array.isArray(data.alternate_greetings) ? data.alternate_greetings.map(text) : [],
    world: text(extensions.world),
    depthPrompt: text(depth.prompt), depthDepth: typeof depth.depth === "number" ? depth.depth : 4,
    depthRole: typeof depth.role === "number" ? depth.role : 0,
    mes_example: text(data.mes_example), system_prompt: text(data.system_prompt),
    post_history_instructions: text(data.post_history_instructions),
    creator_notes: text(data.creator_notes), creator: text(data.creator),
    character_version: text(data.character_version),
    tags: Array.isArray(data.tags) ? data.tags.map(text).filter(Boolean).join(", ") : "",
  };
}

function applyForm(card: Record<string, unknown>, form: CharacterForm): Record<string, unknown> {
  const next = structuredClone(card), data = record(next.data);
  data.name = form.ch_name.trim(); data.description = form.description; data.personality = form.personality;
  data.scenario = form.scenario; data.first_mes = form.first_mes;
  data.alternate_greetings = form.alternateGreetings;
  data.mes_example = form.mes_example; data.system_prompt = form.system_prompt;
  data.post_history_instructions = form.post_history_instructions;
  data.creator_notes = form.creator_notes; data.creator = form.creator;
  data.character_version = form.character_version;
  data.tags = form.tags.split(",").map(tag => tag.trim()).filter(Boolean);
  const extensions = record(data.extensions);
  if (form.world) extensions.world = form.world; else delete extensions.world;
  extensions.depth_prompt = { ...depth_promptOrEmpty(extensions), prompt: form.depthPrompt, depth: form.depthDepth, role: form.depthRole };
  data.extensions = extensions;
  // Keep legacy top-level fields consistent when the card included them.
  for (const key of ["name", "description", "personality", "scenario", "first_mes", "mes_example", "tags"]) {
    if (Object.hasOwn(next, key)) next[key] = data[key];
  }
  if (Object.hasOwn(next, "creatorcomment")) next.creatorcomment = data.creator_notes;
  return next;
}
const depth_promptOrEmpty = (extensions: Record<string, unknown>): Record<string, unknown> => record(extensions.depth_prompt);

// 原生角色编辑（FR-CHAT 角色卡）：读取完整角色卡后按表单字段更新，未编辑的
// 扩展字段与未知字段随卡往返保留；avatar 文件名不变。头像替换/裁剪暂无原生端点。
export function CharacterPanel({ open, online, character, onSaved, onClose }: {
  open: boolean; online: boolean; character: CharacterDetail | null;
  onSaved(updated: CharacterDetail): void; onClose(): void;
}) {
  const card = useRef<Record<string, unknown> | null>(null);
  const [form, setForm] = useState<CharacterForm>(emptyForm);
  const [worlds, setWorlds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const loadRevision = useRef(0);
  useEffect(() => {
    if (!open || !online || !character) return;
    const revision = ++loadRevision.current;
    setLoading(true); setError(""); setNotice("");
    void (async () => {
      try {
        const [raw, names] = await Promise.all([fetchCharacterCard(character.id), listWorldInfoNames().catch(() => [] as string[])]);
        if (revision !== loadRevision.current) return;
        card.current = raw;
        setForm(formFromCard(raw));
        setWorlds(names);
      } catch (cause) {
        if (revision === loadRevision.current) setError(cause instanceof Error ? cause.message : "角色卡读取失败。");
      } finally { if (revision === loadRevision.current) setLoading(false); }
    })();
  }, [open, online, character?.id]);
  const patch = (value: Partial<CharacterForm>) => { setForm(current => ({ ...current, ...value })); setNotice(""); };
  async function save(): Promise<void> {
    if (!character || !card.current) return;
    if (!form.ch_name.trim()) { setError("角色名称不能为空。"); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const next = applyForm(card.current, form);
      const updated = await updateCharacter(character.id, next);
      card.current = next;
      onSaved(updated);
      setNotice("角色已保存。");
    } catch (cause) {
      setError(cause instanceof ApiRequestError
        ? [cause.message, ...cause.details].join("；")
        : cause instanceof Error ? cause.message : "保存角色失败。");
    } finally { setBusy(false); }
  }
  const disabled = !online || loading || busy || !character;
  return <aside className="character-editor-dock" hidden={!open} aria-label="编辑角色">
    <header><h2>编辑角色</h2><button type="button" className="button button--quiet button--small" onClick={onClose}>关闭</button></header>
    {!character ? <p>请先在角色库选择角色。</p> : <>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <p data-character-status aria-live="polite">{loading ? "正在读取角色卡…" : character.name}</p>
        <fieldset disabled={disabled}>
          <CharacterAvatar character={character} large />
          <label>名称<input name="ch_name" required value={form.ch_name} onChange={event => patch({ ch_name: event.target.value })} /></label>
          <label>人物设定<textarea name="description" rows={6} value={form.description} onChange={event => patch({ description: event.target.value })} /></label>
          <label>性格<textarea name="personality" rows={3} value={form.personality} onChange={event => patch({ personality: event.target.value })} /></label>
          <label>场景<textarea name="scenario" rows={3} value={form.scenario} onChange={event => patch({ scenario: event.target.value })} /></label>
          <label>默认开场白<textarea name="first_mes" rows={5} value={form.first_mes} onChange={event => patch({ first_mes: event.target.value })} /></label>
          <details><summary className="open_alternate_greetings">备用开场白</summary>
            <div id="alternate-greetings-list">
              {form.alternateGreetings.map((greeting, index) => <label key={index}>备用开场白 {index + 1}
                <textarea rows={3} value={greeting} onChange={event => patch({ alternateGreetings: form.alternateGreetings.map((item, itemIndex) => itemIndex === index ? event.target.value : item) })} />
                <button type="button" className="button button--quiet button--small" onClick={() => patch({ alternateGreetings: form.alternateGreetings.filter((_item, itemIndex) => itemIndex !== index) })}>移除</button>
              </label>)}
            </div>
            <button type="button" className="button button--quiet button--small" data-add-greeting onClick={() => patch({ alternateGreetings: [...form.alternateGreetings, ""] })}>添加开场白</button>
          </details>
          <label>主世界书<select className="character_world_info_selector" aria-label="主世界书" value={form.world} onChange={event => patch({ world: event.target.value })}>
            <option value="">（无）</option>
            {worlds.map(name => <option key={name} value={name}>{name}</option>)}
            {form.world && !worlds.includes(form.world) ? <option value={form.world}>{form.world}（未找到）</option> : null}
          </select></label>
          <details><summary>更多设定</summary>
            <label>角色深度提示<textarea name="depth_prompt_prompt" rows={4} value={form.depthPrompt} onChange={event => patch({ depthPrompt: event.target.value })} /></label>
            <label>提示插入深度<input name="depth_prompt_depth" type="number" min={0} max={1000} value={form.depthDepth} onChange={event => { if (Number.isFinite(event.target.valueAsNumber)) patch({ depthDepth: event.target.valueAsNumber }); }} /></label>
            <label>提示消息身份<select name="depth_prompt_role" value={form.depthRole} onChange={event => patch({ depthRole: Number(event.target.value) })}><option value={0}>系统</option><option value={1}>用户</option><option value={2}>角色</option></select></label>
            <label>示例对话<textarea name="mes_example" rows={4} value={form.mes_example} onChange={event => patch({ mes_example: event.target.value })} /></label>
            <label>系统提示词<textarea name="system_prompt" rows={4} value={form.system_prompt} onChange={event => patch({ system_prompt: event.target.value })} /></label>
            <label>历史后置提示词<textarea name="post_history_instructions" rows={3} value={form.post_history_instructions} onChange={event => patch({ post_history_instructions: event.target.value })} /></label>
            <label>作者备注<textarea name="creator_notes" rows={3} value={form.creator_notes} onChange={event => patch({ creator_notes: event.target.value })} /></label>
            <label>作者<input name="creator" value={form.creator} onChange={event => patch({ creator: event.target.value })} /></label>
            <label>版本<input name="character_version" value={form.character_version} onChange={event => patch({ character_version: event.target.value })} /></label>
            <label>标签（逗号分隔）<input name="tags" value={form.tags} onChange={event => patch({ tags: event.target.value })} /></label>
          </details>
          <button id="create_button" className="button button--primary" type="submit" disabled={disabled}>{busy ? "正在保存…" : "保存角色"}</button>
        </fieldset>
      </form>
    </>}
  </aside>;
}
