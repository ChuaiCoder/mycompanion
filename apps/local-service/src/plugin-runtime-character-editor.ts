export const characterEditorSource = String.raw`
import { getContext, subscribeHostContext, eventSource, event_types } from '/plugin-runtime/compat-runtime.js';
import { getOneCharacter, getCharacters, getPastCharacterChats, forgetCharacter, loadCharacterState } from '/plugin-runtime/characters.js';
import { mergeJsonChanges } from '/plugin-runtime/chat-merge.js';
import { flushChatSaves, saveChatConditional } from '/plugin-runtime/chat.js';
import { clearChat, printMessages } from '/plugin-runtime/message-rendering.js';
import { world_names } from '/plugin-runtime/world-info.js';
import { lodash, toastr } from '/plugin-runtime/libraries.js';
import { extension_settings, loadExtensionSettings, saveSettingsDebounced } from '/plugin-runtime/settings.js';
import { Popup, POPUP_TYPE } from '/plugin-runtime/popup.js';
let form, editorAvatar, rendered, callbacks, selection = Promise.resolve();
const drafts = new Map(), queues = new Map(), pending = new Map(), failed = new Map();
const draftRevisions = new Map(), draftWrites = new Set(), hydratedDrafts = new Set();
const avatarPreparations = new Set(), avatarRevisions = new Map();
let draftSettingsReady = false;
function draftStorage() { return (extension_settings.__mycompanion_editor_drafts ??= {}).characters ??= {}; }
function fileData(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); }); }
function setAvatarFile(target, file) {
  const transfer = new DataTransfer(); if (file instanceof File) transfer.items.add(file);
  target.elements.namedItem('avatar').files = transfer.files;
}
function canvasFile(canvas, name) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    if (!blob) reject(new Error('头像无法转换为 PNG，请重新选择图片。'));
    else if (blob.size > 20 * 1024 * 1024) reject(new Error('转换后的头像超过 20 MiB，请裁剪或选择较小的图片。'));
    else resolve(new File([blob], name.replace(/\.[^.]*$/, '') + '.png', { type: 'image/png' }));
  }, 'image/png'));
}
async function portraitImage(file, work) {
  if (file.size > 20 * 1024 * 1024) throw new Error('头像超过 20 MiB，请选择较小的图片。');
  const url = URL.createObjectURL(file), image = new Image();
  try {
    image.src = url; await image.decode();
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > 8192 || image.naturalHeight > 8192 || image.naturalWidth * image.naturalHeight > 40000000)
      throw new Error('头像尺寸超过 8192 像素或 4000 万总像素，请选择较小的图片。');
    return await work(image);
  } catch (error) { throw new Error(error instanceof Error && error.message.includes('头像') ? error.message : '无法读取这张头像，请选择有效的 PNG、JPEG 或 WebP。'); }
  finally { URL.revokeObjectURL(url); }
}
async function normalizePortrait(file) {
  return portraitImage(file, async image => {
    const bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    if ([137,80,78,71,13,10,26,10].every((value,index) => bytes[index] === value)) return file;
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    canvas.getContext('2d').drawImage(image, 0, 0); return canvasFile(canvas, file.name);
  });
}
function prepareAvatar(file) {
  const target = form, avatar = editorAvatar, base = rendered, captured = values();
  if (!target || !avatar || !base || !file) return Promise.resolve();
  const revision = (avatarRevisions.get(avatar) ?? 0) + 1; avatarRevisions.set(avatar, revision);
  setAvatarFile(target, drafts.get(avatar)?.value.avatar); status('正在读取头像…');
  const operation = (async () => {
    try {
      const converted = await normalizePortrait(file), data = await fileData(converted);
      if (avatarRevisions.get(avatar) !== revision) return;
      if (form === target && editorAvatar === avatar) {
        setAvatarFile(target, converted); target.querySelector('#avatar_load_preview').src = 'data:image/png;base64,' + data; markEdited();
      } else {
        const draft = drafts.get(avatar) ?? { base, value: captured }; draft.value.avatar = converted;
        drafts.set(avatar, draft); await persistDraft(avatar, draft);
      }
    } catch (error) {
      // A superseded file or a different role owns its current error/status.
      // Ignore an old decoder failure just as we ignore its late success.
      if (avatarRevisions.get(avatar) !== revision || form !== target || editorAvatar !== avatar) return;
      throw error;
    }
  })();
  avatarPreparations.add(operation); void operation.finally(() => avatarPreparations.delete(operation)).catch(() => {});
  return operation;
}
async function cropAvatar() {
  const target = form, avatar = editorAvatar, revision = avatarRevisions.get(avatar) ?? 0;
  if (!target || !avatar) return;
  try {
    await Promise.all([...avatarPreparations]);
    if (form !== target || editorAvatar !== avatar || (avatarRevisions.get(avatar) ?? 0) !== revision) return;
    const selectedFile = target.elements.namedItem('avatar').files[0];
    const response = selectedFile ? null : await fetch('/characters/' + encodeURIComponent(avatar));
    if (response && !response.ok) throw new Error('头像读取失败，请重新选择图片。');
    const blob = response ? await response.blob() : null;
    const file = selectedFile ?? new File([blob], 'portrait.png', { type: blob.type });
    const data = await portraitImage(file, () => fileData(file)); let cropped;
    if (form !== target || editorAvatar !== avatar || (avatarRevisions.get(avatar) ?? 0) !== revision) return;
    const popup = new Popup('选择头像裁剪区域', POPUP_TYPE.CROP, '', { cropImage: 'data:image/' + (file.type.includes('jpeg') ? 'jpeg' : file.type.includes('webp') ? 'webp' : 'png') + ';base64,' + data,
      okButton: '应用裁剪', cancelButton: '取消', onClosing: async dialog => {
        if (dialog.result >= 1) cropped = await canvasFile(dialog.cropper.getCroppedCanvas(), file.name); return true;
      } });
    await popup.show();
    if (cropped && form === target && editorAvatar === avatar && (avatarRevisions.get(avatar) ?? 0) === revision) await prepareAvatar(cropped);
  } catch (error) {
    if (form !== target || editorAvatar !== avatar || (avatarRevisions.get(avatar) ?? 0) !== revision) return;
    throw error;
  }
}
function persistDraft(avatar, draft) {
  const revision = (draftRevisions.get(avatar) ?? 0) + 1; draftRevisions.set(avatar, revision);
  const operation = (async () => {
    await loadExtensionSettings();
    const { avatar: file, ...value } = draft.value;
    const upload = file instanceof File ? { bytes: await fileData(file), name: file.name, type: file.type, lastModified: file.lastModified } : undefined;
    if (draftRevisions.get(avatar) !== revision) return;
    Object.defineProperty(draftStorage(), avatar, { value: { base: draft.base, value, ...(upload ? { upload } : {}) }, writable: true, enumerable: true, configurable: true });
    saveSettingsDebounced();
  })();
  draftWrites.add(operation);
  operation.catch(reportError).finally(() => draftWrites.delete(operation));
  return operation;
}
function removeStoredDraft(avatar) {
  draftRevisions.set(avatar, (draftRevisions.get(avatar) ?? 0) + 1);
  if (Object.hasOwn(draftStorage(), avatar)) { delete draftStorage()[avatar]; saveSettingsDebounced(); }
}
function hydrateDraft(avatar) {
  if (!draftSettingsReady) return;
  if (hydratedDrafts.has(avatar)) return;
  hydratedDrafts.add(avatar);
  const store = draftStorage(), stored = Object.hasOwn(store, avatar) ? store[avatar] : null;
  if (!stored?.base || !stored?.value) return;
  const value = { ...stored.value };
  if (stored.upload) { const upload = stored.upload; value.avatar = new File([Uint8Array.from(atob(upload.bytes), char => char.charCodeAt(0))], upload.name, { type: upload.type, lastModified: upload.lastModified }); }
  drafts.set(avatar, { base: stored.base, value });
}
function checkpointDraft() {
  if (!draftSettingsReady || !form || !editorAvatar || !rendered) return;
  if (dirty()) { const draft = { base: rendered, value: values() }; drafts.set(editorAvatar, draft); return persistDraft(editorAvatar, draft); }
  drafts.delete(editorAvatar); removeStoredDraft(editorAvatar);
}
const equal = (a, b) => a instanceof Blob || b instanceof Blob ? a === b : lodash.isEqual(a, b);
export function connectCharacterEditorHost(value) { callbacks = value; }
const selected = () => getContext().characters[getContext().characterId];
function project(character) {
  const data = character.data;
  const depth = data.extensions.depth_prompt;
  return { avatar_url: character.avatar, json_data: character.json_data, ch_name: data.name,
    depth_prompt_prompt: depth?.prompt ?? '', depth_prompt_depth: String(depth?.depth ?? 4),
    depth_prompt_role: typeof depth?.role === 'number' ? ['system', 'user', 'assistant'][depth.role] ?? 'system' : depth?.role ?? 'system',
    description: data.description, personality: data.personality, scenario: data.scenario, first_mes: data.first_mes,
    mes_example: data.mes_example, system_prompt: data.system_prompt, post_history_instructions: data.post_history_instructions,
    creator_notes: data.creator_notes, creator: data.creator, character_version: data.character_version,
    tags: data.tags.join(', '), alternate_greetings: [...data.alternate_greetings], world: data.extensions.world || '',
    chat: character.chat, create_date: character.create_date };
}
function values() {
  const data = new FormData(form), result = Object.fromEntries(data);
  result.alternate_greetings = data.getAll('alternate_greetings');
  if (!result.avatar?.size) delete result.avatar;
  return result;
}
function mergeFields(base, next, incoming) {
  const result = { ...incoming };
  for (const [key, value] of Object.entries(next)) if (!equal(value, base[key])) {
    if (key === 'json_data') {
      try { result[key] = JSON.stringify(mergeJsonChanges(JSON.parse(base[key]), JSON.parse(value), JSON.parse(incoming[key]))); }
      catch { result[key] = value; }
    } else result[key] = value;
  }
  return result;
}
function status(message, error = '') {
  if (!form) return;
  form.querySelector('[data-character-status]').textContent = message;
  form.querySelector('[data-character-error]').textContent = error;
}
function reportError(error) {
  status('保存失败', error.message); callbacks?.error(error);
}
function dirty() { return rendered && !equal(values(), rendered); }
function syncWorldSelector() {
  if (!form) return;
  const selector = form.querySelector('.character_world_info_selector'), world = form.elements.namedItem('world').value;
  const signature = JSON.stringify([world_names, world]);
  if (selector.dataset.signature === signature) return;
  selector.replaceChildren(new Option('无外部绑定（保留卡内世界书）', ''));
  world_names.forEach((name, index) => selector.add(new Option(name, String(index))));
  if (world && !world_names.includes(world)) selector.add(new Option(world + '（未找到）', 'missing'));
  selector.value = world ? world_names.includes(world) ? String(world_names.indexOf(world)) : 'missing' : '';
  selector.dataset.signature = signature;
}
function greetings(items) {
  const target = form.querySelector('#alternate-greetings-list');
  const current = [...target.querySelectorAll('textarea')].map(input => input.value);
  if (equal(current, items)) return;
  target.replaceChildren();
  for (const [index, text] of items.entries()) {
    const label = document.createElement('label'); label.textContent = '开场白 ' + (index + 2);
    const input = document.createElement('textarea'); input.name = 'alternate_greetings'; input.value = text; input.rows = 3;
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '移除此开场白';
    remove.onclick = () => { label.remove(); markEdited(true); };
    label.append(input, remove); target.append(label);
  }
}
function fill(record) {
  for (const [name, value] of Object.entries(record)) {
    if (name === 'alternate_greetings' || name === 'avatar') continue;
    const input = form.elements.namedItem(name);
    if (input && input.value !== value) input.value = value;
  }
  greetings(record.alternate_greetings); syncWorldSelector();
  if (record.avatar instanceof File) { const files = new DataTransfer(); files.items.add(record.avatar); form.elements.namedItem('avatar').files = files.files; }
}
function markEdited(greetingsChanged = false, depthChanged = false) {
  const current = selected();
  if (!current || current.avatar !== editorAvatar) return;
  const jsonInput = form.elements.namedItem('json_data');
  if (greetingsChanged) {
    try {
      const document = JSON.parse(jsonInput.value);
      document.data.alternate_greetings = [...form.querySelectorAll('[name="alternate_greetings"]')].map(input => input.value);
      jsonInput.value = JSON.stringify(document);
      current.data.alternate_greetings = document.data.alternate_greetings;
    } catch { /* Keep invalid input visible; saving must reject it. */ }
  }
  if (depthChanged) {
    try {
      const document = JSON.parse(jsonInput.value), extensions = document.data.extensions ??= {};
      extensions.depth_prompt = { ...extensions.depth_prompt, prompt: form.elements.namedItem('depth_prompt_prompt').value,
        depth: Number(form.elements.namedItem('depth_prompt_depth').value), role: form.elements.namedItem('depth_prompt_role').value };
      jsonInput.value = JSON.stringify(document);
    } catch { /* Keep invalid input visible; saving must reject it. */ }
  }
  status(dirty() ? '未保存' : '已保存');
  void checkpointDraft();
}
export function syncCharacterEditor() {
  if (!form) return;
  const character = selected();
  if (editorAvatar && editorAvatar !== character?.avatar && rendered) void checkpointDraft();
  form.querySelector('fieldset').disabled = !character?.data;
  if (!character?.data) { editorAvatar = undefined; rendered = undefined; status(character ? '正在加载角色…' : '请选择角色'); return; }
  const incoming = project(character);
  hydrateDraft(character.avatar);
  const sameCharacter = editorAvatar === character.avatar;
  const button = form.querySelector('.open_alternate_greetings');
  button.dataset.chid = String(getContext().characterId);
  globalThis.jQuery?.(button).data('chid', String(getContext().characterId));
  if (sameCharacter && equal(incoming, rendered)) return;
  const draft = sameCharacter && rendered ? { base: rendered, value: values() } : drafts.get(character.avatar);
  const next = draft ? mergeFields(draft.base, draft.value, incoming) : incoming;
  editorAvatar = character.avatar; rendered = incoming;
  if (!sameCharacter) { form.elements.namedItem('avatar').value = ''; }
  fill(next);
  const image = form.querySelector('#avatar_load_preview');
  image.src = '/characters/' + encodeURIComponent(character.avatar) + '?v=' + encodeURIComponent(character.updatedAt ?? '');
  if (next.avatar instanceof File) {
    const target = form, file = next.avatar;
    void fileData(file).then(data => {
      if (form === target && editorAvatar === character.avatar && target.elements.namedItem('avatar').files[0] === file)
        image.src = 'data:image/png;base64,' + data;
    }).catch(reportError);
  }
  status(dirty() ? '未保存' : '已保存');
  void checkpointDraft();
}
export function attachCharacterEditor(element) {
  form = element; syncCharacterEditor();
  void loadExtensionSettings().then(() => {
    draftSettingsReady = true;
    if (form !== element) return;
    if (dirty()) void checkpointDraft();
    else { rendered = undefined; syncCharacterEditor(); }
  }).catch(reportError);
  const stop = subscribeHostContext(syncCharacterEditor);
  const worldChanged = () => syncWorldSelector();
  const changed = event => {
    if (event.target.name === 'avatar') { void prepareAvatar(event.target.files[0]).catch(reportError); return; }
    if (event.target.matches('.character_world_info_selector')) {
      const value = event.target.value;
      if (value !== 'missing') form.elements.namedItem('world').value = value === '' ? '' : world_names[Number(value)] ?? '';
    }
    markEdited(event.target.name === 'alternate_greetings', event.target.name?.startsWith('depth_prompt_'));
  };
  const submit = event => { event.preventDefault(); void saveCharacter().catch(reportError); };
  $(element).on('input.mc-character change.mc-character', changed).on('submit.mc-character', submit);
  window.addEventListener('mycompanion:characters', syncCharacterEditor);
  window.addEventListener('mycompanion:world-info', worldChanged);
  element.querySelector('[data-add-greeting]').onclick = () => { greetings([...values().alternate_greetings, '']); markEdited(true); };
  element.querySelector('[data-crop-avatar]').onclick = () => { void cropAvatar().catch(reportError); };
  return () => {
    stop(); $(element).off('.mc-character');
    window.removeEventListener('mycompanion:characters', syncCharacterEditor);
    window.removeEventListener('mycompanion:world-info', worldChanged);
    if (form === element) { form = undefined; editorAvatar = undefined; rendered = undefined; }
  };
}
function capture() {
  if (!form || !editorAvatar) return null;
  const fields = values(), body = new FormData();
  const character = getContext().characters.find(item => item.avatar === editorAvatar);
  // Tavern's save button reads greetings from the shared character object.
  fields.alternate_greetings = [...character.data.alternate_greetings];
  // Validate before queueing; arrays can be empty and remain represented in JSON.
  const document = JSON.parse(fields.json_data);
  document.data.alternate_greetings = fields.alternate_greetings;
  fields.json_data = JSON.stringify(document);
  for (const [name, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const item of value) body.append(name, item);
    else body.append(name, value);
  }
  return { avatar: editorAvatar, body, file: fields.avatar };
}
function enqueue(snapshot) {
  if (!snapshot) return Promise.resolve();
  const { avatar, body } = snapshot;
  const write = (queues.get(avatar) ?? Promise.resolve()).catch(() => {}).then(async () => {
    if (editorAvatar === avatar) status('保存中…');
    const response = await fetch('/api/characters/edit', { method: 'POST', body });
    if (!response.ok) throw new Error('角色保存失败（HTTP ' + response.status + '）：' + await response.text());
    if (snapshot.file) {
      if (editorAvatar === avatar && form?.elements.namedItem('avatar').files[0] === snapshot.file) form.elements.namedItem('avatar').value = '';
      if (drafts.get(avatar)?.value.avatar === snapshot.file) delete drafts.get(avatar).value.avatar;
    }
    await getOneCharacter(avatar);
    failed.delete(avatar);
  }).catch(error => {
    failed.set(avatar, { snapshot, write }); throw error;
  });
  queues.set(avatar, write);
  // Listeners may await another save; never run their callbacks inside the queue.
  const notification = write.then(async () => {
    const index = getContext().characters.findIndex(character => character.avatar === avatar);
    if (index < 0) return;
    await eventSource.emit(event_types.CHARACTER_EDITED, { detail: { id: index, character: getContext().characters[index] } });
    if (queues.get(avatar) === write) await rebuildUnusedGreeting(avatar, write);
  });
  return notification;
}
async function rebuildUnusedGreeting(avatar, write) {
  const context = getContext();
  const eligible = () => selected()?.avatar === avatar && !context.groupId && !context.isGenerating && !context.chatMetadata.tainted
    && (context.chat.length === 0 || (context.chat.length === 1 && !context.chat[0].is_user && !context.chat[0].is_system));
  if (!context.conversationId || !eligible()) return;
  const story = context.conversationId, branch = context.branchId, original = JSON.stringify(context.chat);
  const current = () => context.conversationId === story && context.branchId === branch && selected()?.avatar === avatar && queues.get(avatar) === write;
  const response = await fetch('/api/conversations/' + encodeURIComponent(story) + '/greeting');
  if (!response.ok) throw new Error('开场白读取失败（HTTP ' + response.status + '）');
  const result = await response.json();
  if (!current() || !eligible() || JSON.stringify(context.chat) !== original || result.tainted || result.branchId !== branch || result.characterId !== selected()?.id || !result.message.mes) return;
  context.chat.splice(0, context.chat.length, result.message);
  await eventSource.emit(event_types.MESSAGE_RECEIVED, 0, 'first_message');
  if (!current()) return;
  await clearChat();
  if (!current()) return;
  await printMessages();
  if (!current()) return;
  await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, 0, 'first_message');
  if (current()) await saveChatConditional();
}
export async function saveCharacter() {
  await Promise.all([...avatarPreparations]);
  const snapshot = capture();
  if (snapshot && pending.has(snapshot.avatar)) { clearTimeout(pending.get(snapshot.avatar).timer); pending.delete(snapshot.avatar); }
  return enqueue(snapshot);
}
export function saveCharacterDebounced() {
  const snapshot = capture(); if (!snapshot) return;
  const { avatar } = snapshot;
  if (pending.has(avatar)) clearTimeout(pending.get(avatar).timer);
  const timer = setTimeout(() => { pending.delete(avatar); void enqueue(snapshot).catch(reportError); }, 1000);
  pending.set(avatar, { snapshot, timer });
}
export async function flushCharacterSaves({ retryFailed = false } = {}) {
  await Promise.all([...avatarPreparations]);
  await loadExtensionSettings();
  draftSettingsReady = true;
  // A prior failure on another role must not permanently prevent returning to it.
  if (retryFailed) for (const { snapshot, write } of failed.values()) {
    if (queues.get(snapshot.avatar) === write) void enqueue(snapshot).catch(reportError);
  }
  for (;;) {
    for (const [avatar, item] of pending) { clearTimeout(item.timer); pending.delete(avatar); void enqueue(item.snapshot).catch(reportError); }
    const writes = [...queues.entries()];
    await Promise.all(writes.map(([, write]) => write));
    if (!pending.size && writes.length === queues.size && writes.every(([avatar, write]) => queues.get(avatar) === write)) {
      await checkpointDraft();
      await Promise.all([...drafts].map(([avatar, draft]) => persistDraft(avatar, draft)));
      await Promise.all([...draftWrites]);
      return;
    }
  }
}
saveCharacterDebounced.flush = flushCharacterSaves;
saveCharacterDebounced.cancel = () => { for (const item of pending.values()) clearTimeout(item.timer); pending.clear(); };
export function selectCharacterById(index, { switchMenu = true } = {}) {
  const character = getContext().characters[index];
  if (!character) return Promise.resolve();
  const id = character.id;
  const operation = selection.catch(() => {}).then(async () => {
    if (getContext().isGenerating) return;
    await flushCharacterSaves({ retryFailed: true }); await flushChatSaves();
    if (getContext().isGenerating) return;
    if (!callbacks?.select) throw new Error('角色界面尚未连接');
    await callbacks.select(id, switchMenu); syncCharacterEditor();
  });
  selection = operation; return operation;
}
export function deleteCharacter(characterKey, { deleteChats = true } = {}) {
  const keys = [...new Set(Array.isArray(characterKey) ? characterKey : [characterKey])];
  const operation = selection.catch(() => {}).then(async () => {
    if (getContext().isGenerating) return [];
    await loadCharacterState();
    await flushCharacterSaves({ retryFailed: true }); await flushChatSaves();
    if (getContext().isGenerating) return [];
    const original = [...getContext().characters], deleted = [];
    try {
      for (const key of keys) {
        const index = getContext().characters.findIndex(character => character.avatar === key);
        if (index < 0) { toastr.warning('角色不存在：' + key); continue; }
        const character = getContext().characters[index];
        const chats = deleteChats ? await getPastCharacterChats(index) : [];
        const response = await fetch('/api/characters/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ avatar_url: key, delete_chats: deleteChats }) });
        if (!response.ok) { toastr.error('角色删除失败（HTTP ' + response.status + '）：' + await response.text()); continue; }
        forgetCharacter(key);
        drafts.delete(key); queues.delete(key); failed.delete(key); removeStoredDraft(key);
        if (pending.has(key)) { clearTimeout(pending.get(key).timer); pending.delete(key); }
        deleted.push({ id: original.indexOf(character), character, chats });
      }
    } finally {
      if (deleted.length) {
        await callbacks.clear(); await getCharacters(); syncCharacterEditor();
      }
    }
    return deleted;
  });
  selection = operation;
  // Deletion listeners may select another role; do not run them in the selection queue.
  return operation.then(async deleted => {
    for (const { id, character, chats } of deleted) {
      for (const chat of chats) await eventSource.emit(event_types.CHAT_DELETED, chat.file_name.replace(/\.jsonl$/, ''));
      await eventSource.emit(event_types.CHARACTER_DELETED, { id, character });
    }
    return deleted.length > 0;
  });
}
`;
