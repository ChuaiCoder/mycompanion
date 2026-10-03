import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { MAX_CONTEXT_TOKENS, type ProviderProfile, type ProviderProfiles as ProfilesState, type ProviderSettings, type ProviderTaskAssignments, type UpdateProviderSettings } from "@mycompanion/shared";
import { getProviderProfiles, saveProviderProfile, deleteProviderProfile, assignProviderTasks, testProviderProfile } from "../provider-api";
import { providerCopy } from "../provider-translations";

/** Profiles edit independently from the beginner's selected-chat form. */
export function ProviderProfiles({ disabled = false }: { disabled?: boolean }) {
  const { i18n } = useTranslation(), copy = providerCopy(i18n.language);
  const [state, setState] = useState<ProfilesState | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProviderSettings | null>(null), [name, setName] = useState("");
  const [key, setKey] = useState(""), [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const revision = useRef(0), loadRevision = useRef(0);
  const initialized = useRef(false);
  function edit(profile: ProviderProfile) { revision.current++; setEditingId(profile.id); setDraft(profile.settings); setName(profile.name); setKey(""); setClearKey(false); setError(""); setNotice(""); }
  function publish(next: ProfilesState) {
    const selected = next.profiles.find(profile => profile.id === next.tasks.chat);
    if (selected) window.dispatchEvent(new CustomEvent("mycompanion:provider-saved", { detail: selected.settings }));
  }
  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    const reload = async () => {
      const token = ++loadRevision.current;
      try {
        const next = await getProviderProfiles(controller.signal);
        if (disposed || token !== loadRevision.current) return;
        setState(next);
        // Only the first load initializes the editor; saved-chat events must
        // not erase an unrelated connection's unsaved draft or transient key.
        if (!initialized.current) { initialized.current = true; edit(next.profiles.find(profile => profile.id === next.tasks.chat)!); }
      } catch (cause) { if (!disposed && token === loadRevision.current) setError(cause instanceof Error ? cause.message : copy.failed); }
    };
    void reload();
    window.addEventListener("mycompanion:provider-saved", reload);
    return () => { disposed = true; controller.abort(); revision.current++; window.removeEventListener("mycompanion:provider-saved", reload); };
  }, []);
  const inactive = busy || disabled;
  async function assign(task: keyof ProviderTaskAssignments, id: string | null) {
    setBusy(true); setError(""); setNotice("");
    try { const next = await assignProviderTasks({ [task]: id }); setState(next); if (task === "chat") publish(next); setNotice(copy.assigned); }
    catch (cause) { setError(cause instanceof Error ? cause.message : copy.failed); }
    finally { setBusy(false); }
  }
  const snapshot = (): UpdateProviderSettings => ({ ...draft!, clearApiKey: clearKey, ...(key && !clearKey ? { apiKey: key } : {}) });
  async function save(event: FormEvent) {
    event.preventDefault(); if (!draft) return;
    const id = editingId, token = revision.current, values = { name, settings: snapshot() };
    setBusy(true); setError(""); setNotice("");
    try {
      const profile = await saveProviderProfile(id, values), next = await getProviderProfiles();
      setState(next);
      if (token === revision.current) { edit(profile); setNotice(copy.saved); }
      if (next.tasks.chat === profile.id) publish(next);
    } catch (cause) { if (token === revision.current) setError(cause instanceof Error ? cause.message : copy.failed); }
    finally { setBusy(false); }
  }
  async function test(task: "chat" | "embedding") {
    if (!editingId || !draft) return;
    const token = revision.current;
    setBusy(true); setError(""); setNotice("");
    try { const result = await testProviderProfile(editingId, snapshot(), task); if (token !== revision.current) return; if (result.ok) setNotice(result.message); else setError(`${result.message} ${result.issue?.suggestion ?? ""}`); }
    catch (cause) { if (token === revision.current) setError(cause instanceof Error ? cause.message : copy.failed); }
    finally { setBusy(false); }
  }
  function field(patch: Partial<ProviderSettings>) { revision.current++; setNotice(""); setDraft(current => current ? { ...current, ...patch } : current); }
  if (!state) return <p>{error || copy.loading}</p>;
  return <section className="settings-card" aria-label={copy.connections}>
    <label>{copy.current}<select aria-label={copy.current} disabled={inactive} value={state.tasks.chat} onChange={event => void assign("chat", event.target.value)}>
      {state.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.settings.model}</option>)}
    </select></label>
    <details><summary>{copy.advanced}</summary><p>{copy.intro}</p>
      {error ? <p role="alert">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
      <div className="settings-form">
        <label>{copy.edit}<select aria-label={copy.edit} disabled={inactive} value={editingId ?? ""} onChange={event => { const profile = state.profiles.find(item => item.id === event.target.value); if (profile) edit(profile); }}>
          <option value="" disabled>{copy.new}</option>{state.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.settings.model}</option>)}
        </select></label>
        <button type="button" className="button button--quiet" disabled={inactive} onClick={() => { revision.current++; setEditingId(null); setName(""); setDraft({ ...state.profiles.find(profile => profile.id === state.tasks.chat)!.settings, hasApiKey: false }); setKey(""); setClearKey(false); setNotice(""); }}>{copy.new}</button>
        {draft ? <form className="settings-form" onSubmit={event => void save(event)}>
          <label>{copy.name}<input aria-label={copy.name} required maxLength={100} value={name} disabled={inactive} onChange={event => { revision.current++; setName(event.target.value); }} /></label>
          <label>{copy.source}<select aria-label={copy.source} disabled={inactive} value={draft.kind} onChange={event => field({ kind: event.target.value as ProviderSettings["kind"] })}><option value="openai-compatible">{copy.online}</option><option value="ollama">{copy.local}</option><option value="anthropic">{copy.anthropic}</option><option value="gemini">{copy.gemini}</option></select></label>
          <label>{copy.address}<input aria-label={copy.address} required type="url" disabled={inactive} value={draft.baseUrl} onChange={event => field({ baseUrl: event.target.value })} /></label>
          <label>{copy.model}<input aria-label={copy.model} required disabled={inactive} value={draft.model} onChange={event => field({ model: event.target.value })} /></label>
          <label>{copy.key}<input aria-label={copy.key} type="password" autoComplete="off" disabled={inactive || clearKey} value={key} placeholder={draft.hasApiKey ? copy.existingKey : copy.optionalKey} onChange={event => { revision.current++; setKey(event.target.value); }} /></label>
          <label><input type="checkbox" checked={clearKey} disabled={inactive} onChange={event => { revision.current++; setClearKey(event.target.checked); if (event.target.checked) setKey(""); }} />{copy.clearKey}</label>
          <div className="settings-form__row">
            <label>{copy.temperature}<input type="number" min={0} max={2} step={0.1} disabled={inactive} value={draft.temperature} onChange={event => field({ temperature: Number(event.target.value) })} /></label>
            <label>{copy.response}<input type="number" min={1} max={131072} disabled={inactive} value={draft.maxTokens} onChange={event => field({ maxTokens: Number(event.target.value) })} /></label>
            <label>{copy.context}<input type="number" min={1} max={MAX_CONTEXT_TOKENS} disabled={inactive} value={draft.contextLimitTokens} onChange={event => field({ contextLimitTokens: Number(event.target.value) })} /></label>
          </div>
          <div className="settings-actions"><button className="button button--primary" type="submit" disabled={inactive}>{copy.save}</button>
            {editingId ? <><button type="button" className="button button--quiet" disabled={inactive} onClick={() => void test("chat")}>{copy.testChat}</button><button type="button" className="button button--quiet" disabled={inactive} onClick={() => void test("embedding")}>{copy.testEmbedding}</button>
              <button type="button" className="button button--quiet" disabled={inactive || state.profiles.length === 1} onClick={() => void (async () => {
                setBusy(true); setError(""); try { const next = await deleteProviderProfile(editingId); setState(next); edit(next.profiles.find(profile => profile.id === next.tasks.chat)!); publish(next); setNotice(copy.deleted); }
                catch (cause) { setError(cause instanceof Error ? cause.message : copy.failed); } finally { setBusy(false); }
              })()}>{copy.remove}</button></> : null}</div>
          {editingId ? <small>{copy.removing}</small> : null}
        </form> : null}
        <h3>{copy.tasks}</h3>
        {(["summary", "extraction", "embedding"] as const).map(task => <label key={task}>{copy[task]}<select aria-label={copy[task]} disabled={inactive} value={state.tasks[task] ?? ""} onChange={event => void assign(task, event.target.value || null)}>
          <option value="">{task === "embedding" ? copy.keyword : copy.sameChat}</option>{state.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.settings.model}</option>)}
        </select></label>)}
        <small>{copy.embeddingHelp}</small>
      </div>
    </details>
  </section>;
}
