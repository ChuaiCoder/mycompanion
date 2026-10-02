import { buildAuthorNotePrompt } from "./author-note-core.js";

export const authorNoteCoreSource = `export const buildAuthorNotePrompt = ${buildAuthorNotePrompt.toString()};`;

export const authorNoteRuntimeSource = String.raw`
import { getContext } from '/plugin-runtime/compat-runtime.js';
import { extension_settings } from '/plugin-runtime/settings.js';
import { buildAuthorNotePrompt } from '/plugin-runtime/author-note-core.js';

export const NOTE_MODULE_NAME = '2_floating_prompt';
export const metadata_keys = { prompt: 'note_prompt', interval: 'note_interval', depth: 'note_depth', position: 'note_position', role: 'note_role' };
export let shouldWIAddPrompt = false;

export function syncAuthorNote(extraUserTurns = 0) {
  // Tavern's built-in Author's Note extension creates this namespace before
  // third-party generation code reads allowWIScan.
  if (!extension_settings.note || typeof extension_settings.note !== 'object') extension_settings.note = {};
  if (typeof extension_settings.note.allowWIScan !== 'boolean') extension_settings.note.allowWIScan = false;
  const context = getContext();
  const count = context.chat.filter(message => message.is_user).length + extraUserTurns;
  const result = buildAuthorNotePrompt(context.chatMetadata, extension_settings, count);
  shouldWIAddPrompt = result.active;
  return result;
}
`;
