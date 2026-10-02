// Independently implemented output cleanup for the legacy script.js contract.
// The original helper calls this with positional arguments during streaming.
export const messageCleanupSource = String.raw`
import { getContext, substituteParams } from '/plugin-runtime/compat-runtime.js';
import { getRegexedString, regex_placement } from '/scripts/extensions/regex/engine.js';
import { power_user, getEphemeralStoppingStrings } from '/scripts/power-user.js';

function stoppingStrings(value) {
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string' && item);
  const stored = power_user.custom_stopping_strings;
  let configured = [];
  if (Array.isArray(stored)) configured = stored;
  else if (typeof stored === 'string' && stored.trim()) {
    try { const parsed = JSON.parse(stored); configured = Array.isArray(parsed) ? parsed : [stored]; }
    catch { configured = [stored]; }
  }
  return [...configured, ...getEphemeralStoppingStrings()].filter(item => typeof item === 'string' && item);
}
const escapeRegex = value => String(value).replace(/[.*+?^{}$()|[\]\\]/g, '\\$&');
function removeStopSuffix(text, stops) {
  for (const stop of stops) {
    for (let length = stop.length; length > 0; length--) {
      if (text.endsWith(stop.slice(0, length))) { text = text.slice(0, -length); break; }
    }
  }
  return text;
}
function asOptions(first, rest) {
  if (first && typeof first === 'object' && !Array.isArray(first)) return first;
  const [isImpersonate=false,isContinue=false,displayIncompleteSentences=false,stoppingStrings=null,
    includeUserPromptBias=true,trimNames=true,trimWrongNames=true] = rest;
  return {getMessage:first,isImpersonate,isContinue,displayIncompleteSentences,stoppingStrings,
    includeUserPromptBias,trimNames,trimWrongNames};
}
export function cleanUpMessage(first, ...rest) {
  const options = asOptions(first, rest);
  let text = typeof options.getMessage === 'string' ? options.getMessage : '';
  if (!text) return '';
  const impersonate = Boolean(options.isImpersonate);
  if (options.includeUserPromptBias !== false && power_user.user_prompt_bias && !impersonate && !options.isContinue)
    text = substituteParams(String(power_user.user_prompt_bias)) + text;
  text = removeStopSuffix(text, stoppingStrings(options.stoppingStrings));
  text = getRegexedString(text, impersonate ? regex_placement.USER_INPUT : regex_placement.AI_OUTPUT);
  if (power_user.collapse_newlines) text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/[^\S\r\n]+$/gm, '');
  const {name1='User',name2=''} = getContext();
  const wrongName = impersonate ? (power_user.allow_name2_display === false ? name2 : '')
    : (power_user.allow_name1_display === false ? name1 : '');
  if (options.trimWrongNames !== false && wrongName) {
    if (text.startsWith(wrongName + ':')) text = '';
    else {
      const boundary = text.indexOf('\n' + wrongName + ':');
      if (boundary >= 0) text = text.slice(0, boundary);
    }
  }
  const endMarker = text.indexOf('<|endoftext|>');
  if (endMarker >= 0) text = text.slice(0, endMarker);
  const instruct = power_user.instruct;
  if (instruct?.enabled) for (const stop of [instruct.stop_sequence,instruct.input_sequence]) {
    if (typeof stop !== 'string' || !stop) continue;
    const index = text.indexOf(stop); if (index >= 0) text = text.slice(0, index);
  }
  if (name2 && power_user.allow_name2_display === false)
    text = text.replace(new RegExp('(^|\\n)' + escapeRegex(name2) + ':\\s*', 'g'), '$1');
  const ownName = impersonate ? name1 : name2;
  const hideOwnName = impersonate ? power_user.allow_name1_display === false : power_user.allow_name2_display === false;
  if (options.trimNames !== false && hideOwnName && ownName && text.startsWith(ownName + ':'))
    text = text.slice(ownName.length + 1).trimStart();
  if (power_user.trim_sentences && !options.displayIncompleteSentences) {
    const end = Math.max(text.lastIndexOf('.'), text.lastIndexOf('!'), text.lastIndexOf('?'),
      text.lastIndexOf('。'), text.lastIndexOf('！'), text.lastIndexOf('？'));
    if (end >= 0) text = text.slice(0, end + 1);
  }
  if (impersonate || power_user.trim_spaces) text = text.trim();
  return text;
}
`;
