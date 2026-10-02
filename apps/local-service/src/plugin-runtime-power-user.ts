export const powerUserRuntimeSource = String.raw`
import {extension_settings,loadExtensionSettings,registerSettingsParticipant} from '/plugin-runtime/settings.js';
import {substituteParams} from '/plugin-runtime/macros.js';

export const persona_description_positions = Object.freeze({IN_PROMPT:0,AFTER_CHAR:1,TOP_AN:2,BOTTOM_AN:3,AT_DEPTH:4,NONE:9});
const storageKey = '__mycompanion_power_user';
export const power_user = {
  personas:{},default_persona:null,persona_descriptions:{},persona_description:'',
  persona_description_position:persona_description_positions.IN_PROMPT,
  persona_description_depth:2,persona_description_role:0,persona_description_lorebook:'',
  streaming_fps:30,chat_truncation:0,prefer_character_prompt:true,prefer_character_jailbreak:true,
  instruct:{enabled:false},custom_stopping_strings:'',custom_stopping_strings_macro:false,
};
let ready;
const ephemeralStoppingStrings = [];
export async function loadPowerUser() {
  return ready ??= (async () => {
    await loadExtensionSettings();
    const stored = extension_settings[storageKey];
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      Object.assign(power_user, structuredClone(stored));
    }
  })().catch(error => { ready = undefined; throw error; });
}
registerSettingsParticipant('power-user', () => {
  extension_settings[storageKey] = structuredClone(power_user);
  return async () => {};
});
export function addEphemeralStoppingString(value) {
  const text = String(value);
  if (text && !ephemeralStoppingStrings.includes(text)) ephemeralStoppingStrings.push(text);
}
export function getEphemeralStoppingStrings() { return [...ephemeralStoppingStrings]; }
export function flushEphemeralStoppingStrings() { ephemeralStoppingStrings.splice(0); }
export function getCustomStoppingStrings(limit) {
  let permanent = [];
  try {
    const parsed = JSON.parse(power_user.custom_stopping_strings || '[]');
    if (Array.isArray(parsed)) permanent = parsed.filter(value => typeof value === 'string' && value.length > 0);
  } catch (error) { console.warn('Invalid custom stopping strings', error); }
  if (power_user.custom_stopping_strings_macro) permanent = permanent.map(value => substituteParams(value));
  const strings = [...permanent, ...ephemeralStoppingStrings];
  return Number(limit) > 0 ? strings.slice(0, Number(limit)) : strings;
}
`;
