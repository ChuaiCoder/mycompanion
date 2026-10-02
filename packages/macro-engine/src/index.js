import { MacroEngine } from './engine/MacroEngine.js';
import { MacroRegistry, MacroCategory, MacroValueType } from './engine/MacroRegistry.js';
import { registerCoreMacros } from './definitions/core-macros.js';
import { registerCharacterMacros } from './definitions/character-macros.js';
import { getStringHash } from './string-hash.js';
export { MacroEngine, MacroRegistry, MacroCategory, MacroValueType };
export { MacroLexer } from './engine/MacroLexer.js';
export { MacroParser } from './engine/MacroParser.js';
export { MacroCstWalker } from './engine/MacroCstWalker.js';
export { MacroEnvironmentBuilder, env_provider_order } from './engine/MacroEnvBuilder.js';
export { createVariableStores, createLegacyVariableMacroRules } from './variable-stores.js';
export * from './engine/MacroFlags.js';

export function initRegisterMacros() {
registerCoreMacros();
registerCharacterMacros();
// State is read from the invocation's environment, never from a shared chat.
// Browser and service use this same bundle and bind their own data/functions.
for (const name of ['user', 'char', 'group', 'groupNotMuted', 'notChar']) {
  MacroRegistry.registerMacro(name, { category: MacroCategory.NAMES,
    ...(name === 'group' ? { aliases: [{ alias: 'charIfNotGroup', visible: false }] } : {}),
    handler: ({ env }) => env.names[name] ?? '' });
}
for (const name of ['model', 'input', 'maxPrompt', 'maxContext', 'maxResponse',
  'lastMessage', 'lastMessageId', 'lastUserMessage', 'lastCharMessage', 'firstIncludedMessageId',
  'firstDisplayedMessageId', 'lastSwipeId', 'currentSwipeId', 'allChatRange',
  'time', 'date', 'weekday', 'isotime', 'isodate']) {
  MacroRegistry.registerMacro(name, { category: MacroCategory.STATE,
    ...(['maxPrompt','maxContext','maxResponse'].includes(name) ? { aliases: [{ alias: name + 'Tokens' }] } : {}),
    handler: ({ env }) => {
      const read = env.extra[name];
      if (read === undefined) throw new Error('Macro context is missing: ' + name);
      return typeof read === 'function' ? read() : read;
    } });
}
MacroRegistry.registerMacro('original', { handler: ({ env }) => env.functions.original?.() ?? '' });
for (const [name, global] of [['getvar', false], ['getglobalvar', true]]) {
  MacroRegistry.registerMacro(name, { category: MacroCategory.VARIABLE, unnamedArgs: 1,
    handler: ({ unnamedArgs: [key], env }) => env.extra.readVariable(key, global) });
}
for (const global of [false, true]) {
  for (const [prefix, operation, count, empty] of [['set','set',2,true],['add','add',2,true],['inc','inc',1,false],['dec','dec',1,false]]) {
    MacroRegistry.registerMacro(prefix + (global ? 'globalvar' : 'var'), { category: MacroCategory.VARIABLE, unnamedArgs: count,
      handler: ({ unnamedArgs, env }) => {
        const store = env.extra.variables[global ? 'global' : 'local'];
        if (typeof store?.[operation] !== 'function') throw new Error('Variable writes are not bound in this macro context');
        const value = store[operation](...unnamedArgs);
        return empty ? '' : value;
      } });
  }
}

}
initRegisterMacros();

/** Creates only the environment structure; does not evaluate any input twice. */
export function createMacroEnvironment(content, values = {}) {
  return { content, contentHash: values.contentHash ?? getStringHash(content),
    names: { user: 'User', char: '', group: '', groupNotMuted: '', notChar: '', ...values.names },
    character: values.character ?? {}, system: values.system ?? {},
    functions: { postProcess: value => value, ...values.functions },
    dynamicMacros: Object.fromEntries(Object.entries(values.dynamicMacros ?? {}).map(([key, value]) => [key.toLowerCase(), value])),
    extra: values.extra ?? {} };
}
