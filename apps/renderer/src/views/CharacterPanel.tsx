import { useEffect, useRef, useState } from "react";
import { loadExtensionHost } from "../ExtensionHost";

// These are the user's actual edit controls; helper FormData uses the same form.
export function CharacterPanel({ open, online, onClose }: { open: boolean; online: boolean; onClose(): void }) {
  const form = useRef<HTMLFormElement>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    if (!online) return;
    setLoadError(null);
    let disposed = false, detach: (() => void) | undefined;
    void loadExtensionHost().then(async () => {
      const path = "/plugin-runtime/character-editor.js";
      const editor = await import(/* @vite-ignore */ path) as { attachCharacterEditor(form: HTMLFormElement): () => void };
      if (!disposed && form.current) detach = editor.attachCharacterEditor(form.current);
    }).catch(error => { if (!disposed) setLoadError(error instanceof Error ? error.message : String(error)); });
    return () => { disposed = true; detach?.(); };
  }, [online]);
  return <aside className="character-editor-dock" hidden={!open} aria-label="编辑角色">
    <header><h2>编辑角色</h2><button type="button" onClick={onClose}>关闭</button></header>
    {loadError && <p role="alert">角色编辑器加载失败：{loadError}</p>}
    <form id="form_create" ref={form}>
      <p data-character-status aria-live="polite">请选择角色</p><p data-character-error role="alert" />
      <fieldset disabled>
        <input type="hidden" name="avatar_url" /><input type="hidden" name="json_data" id="character_json_data" />
        <input type="hidden" name="world" id="character_world" /><input type="hidden" name="chat" /><input type="hidden" name="create_date" />
        <div id="rm_info_avatar" />
        <img id="avatar_load_preview" alt="角色头像" width="64" height="64" />
        <label>替换头像（PNG、JPEG、WebP）<input type="file" name="avatar" id="add_avatar_button" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" /></label>
        <button type="button" data-crop-avatar>裁剪头像</button>
        <label>名称<input name="ch_name" required /></label>
        <label>人物设定<textarea name="description" rows={6} /></label>
        <label>性格<textarea name="personality" rows={3} /></label>
        <label>场景<textarea name="scenario" rows={3} /></label>
        <label>默认开场白<textarea name="first_mes" rows={5} /></label>
        <details><summary className="open_alternate_greetings">备用开场白</summary><div id="alternate-greetings-list" /><button type="button" data-add-greeting>添加开场白</button></details>
        <label>主世界书<select className="character_world_info_selector" /></label>
        <details><summary>更多设定</summary>
          <label>角色深度提示<textarea name="depth_prompt_prompt" id="depth_prompt_prompt" rows={4} /></label>
          <label>提示插入深度<input name="depth_prompt_depth" id="depth_prompt_depth" type="number" min={0} max={1000} /></label>
          <label>提示消息身份<select name="depth_prompt_role" id="depth_prompt_role"><option value="system">系统</option><option value="user">用户</option><option value="assistant">角色</option></select></label>
          <label>示例对话<textarea name="mes_example" rows={4} /></label>
          <label>系统提示词<textarea name="system_prompt" rows={4} /></label>
          <label>历史后置提示词<textarea name="post_history_instructions" rows={3} /></label>
          <label>作者备注<textarea name="creator_notes" rows={3} /></label>
          <label>作者<input name="creator" /></label><label>版本<input name="character_version" /></label>
          <label>标签（逗号分隔）<input name="tags" /></label>
        </details>
        <button id="create_button" type="submit">保存角色</button>
      </fieldset>
    </form>
  </aside>;
}
