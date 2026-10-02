// Independently authored state bridge for the application's real character rows.
export const characterRuntimeSource = String.raw`
import { getContext, applyHostContext } from '/plugin-runtime/compat-runtime.js';
import { mergeJsonChanges } from '/plugin-runtime/chat-merge.js';
const clone = value => JSON.parse(JSON.stringify(value));
const baseline = new Map(), requested = new Map(), applied = new Map(), removed = new Map();
let callbacks, sequence = 0, listRevision = 0, summaryKey, loading;
const keyFor = avatar => avatar.toLowerCase();
const newerThan = (avatar, revision) => Math.max(requested.get(keyFor(avatar)) ?? 0, applied.get(keyFor(avatar)) ?? 0) > revision;
export function connectCharacterState(value) { callbacks = value; }
async function request(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error('角色请求失败（HTTP ' + response.status + '）：' + await response.text());
  return response.json();
}
function replaceRecord(target, source) {
  for (const key of Object.keys(target)) if (!Object.hasOwn(source, key)) delete target[key];
  for (const [key, value] of Object.entries(source)) Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}
function accept(remote) {
  removed.delete(keyFor(remote.avatar));
  const target = getContext().characters.find(item => item.avatar === remote.avatar);
  const current = target && baseline.has(remote.avatar) ? mergeJsonChanges(baseline.get(remote.avatar), clone(target), remote) : remote;
  baseline.set(remote.avatar, clone(remote));
  if (target) { replaceRecord(target, current); return target; }
  return current;
}
async function changed() {
  const context = getContext(), selected = context.characters.find(item => item.id === context.characterUuid);
  await applyHostContext(selected ? { name2: selected.name } : {});
  await callbacks?.refresh();
  window.dispatchEvent(new CustomEvent('mycompanion:characters'));
}
export async function getCharacters() {
  const revision = ++sequence; listRevision = revision;
  const remote = await request('/api/characters/all', {});
  if (revision !== listRevision) return;
  const current = getContext().characters;
  const next = remote.filter(item => (removed.get(keyFor(item.avatar)) ?? 0) <= revision).map(item => {
    if (newerThan(item.avatar, revision)) return current.find(existing => existing.avatar === item.avatar) ?? item;
    applied.set(keyFor(item.avatar), revision); return accept(item);
  });
  // Do not remove a newer character that arrived through a concurrent single read.
  for (const item of current) if (!next.some(row => row.avatar === item.avatar) && newerThan(item.avatar, revision)) next.push(item);
  current.splice(0, current.length, ...next);
  for (const avatar of baseline.keys()) if (!current.some(item => item.avatar === avatar)) baseline.delete(avatar);
  await changed();
}
export async function getOneCharacter(avatar) {
  const revision = ++sequence, key = keyFor(avatar); requested.set(key, revision);
  const remote = await request('/api/characters/get', { avatar_url: avatar });
  if (newerThan(avatar, revision)) return;
  applied.set(key, revision);
  const context = getContext(), existing = context.characters.some(item => item.avatar === remote.avatar), next = accept(remote);
  if (!existing) context.characters.push(next);
  await changed();
}
export function forgetCharacter(avatar) {
  const revision = ++sequence, key = keyFor(avatar), current = getContext().characters;
  requested.set(key, revision); applied.set(key, revision); removed.set(key, revision); baseline.delete(avatar);
  const index = current.findIndex(item => keyFor(item.avatar) === key);
  if (index >= 0) current.splice(index, 1);
}
export function syncCharacterSummaries(summaries) {
  const key = JSON.stringify(summaries.map(item => [item.id, item.updatedAt]));
  if (key === summaryKey) return loading;
  summaryKey = key;
  const current = loading = getCharacters().catch(error => { if (summaryKey === key) summaryKey = undefined; throw error; });
  return current;
}
export async function loadCharacterState() { if (loading) await loading; else await getCharacters(); }
export async function unshallowCharacter(index) {
  const character = getContext().characters[index];
  if (!character) throw new Error('角色不存在：' + index);
  if (!character.data) await getOneCharacter(character.avatar);
}
export function getThumbnailUrl(type, file) { return '/thumbnail?type=' + encodeURIComponent(type) + '&file=' + encodeURIComponent(file); }
export async function getPastCharacterChats(index) {
  const character = getContext().characters[index];
  if (!character) return [];
  return request('/api/characters/chats', { avatar_url: character.avatar });
}
export async function printCharacters() { await callbacks?.refresh(); }
`;
