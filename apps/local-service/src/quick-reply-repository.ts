import type { RuntimeRepository } from "./runtime-repository.js";

/** Existing SQLite settings/backup transactions own these user-authored facts. */
export const QUICK_REPLY_PRESETS_KEY="__mycompanion_quick_reply_presets";
export function quickReplyPresets(runtime:RuntimeRepository):Record<string,unknown>[] {
  const value=runtime.getExtensionSettings()[QUICK_REPLY_PRESETS_KEY];
  return Array.isArray(value)?value.filter((item):item is Record<string,unknown>=>item!==null&&typeof item==="object"&&!Array.isArray(item)&&typeof item.name==="string"):[];
}
export function saveQuickReplyPreset(runtime:RuntimeRepository,preset:Record<string,unknown>):void {
  const settings=runtime.getExtensionSettings(),presets=quickReplyPresets(runtime),index=presets.findIndex(item=>item.name===preset.name);
  if(index<0)presets.push(preset);else presets[index]=preset;
  settings[QUICK_REPLY_PRESETS_KEY]=presets;runtime.saveExtensionSettings(settings);
}
export function deleteQuickReplyPreset(runtime:RuntimeRepository,name:string):void {
  const settings=runtime.getExtensionSettings();settings[QUICK_REPLY_PRESETS_KEY]=quickReplyPresets(runtime).filter(item=>item.name!==name);runtime.saveExtensionSettings(settings);
}
