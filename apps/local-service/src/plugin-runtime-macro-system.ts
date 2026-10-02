// Public SillyTavern macro entry point backed by the actual shared engine and
// live browser environment. All import paths resolve to the same singletons.
export const macroSystemSource = String.raw`
import {MacroEngine,MacroLexer,MacroParser,MacroCstWalker,MacroCategory,MacroValueType} from '/plugin-runtime/vendor/macro-engine.js';
import {MacroRegistry} from '/scripts/macros/engine/MacroRegistry.js';
import {MacroEnvBuilder} from '/scripts/macros/engine/MacroEnvBuilder.js';
export {MacroCategory,MacroValueType,initRegisterMacros} from '/plugin-runtime/vendor/macro-engine.js';
export const macros={engine:MacroEngine,registry:MacroRegistry,envBuilder:MacroEnvBuilder,
  lexer:MacroLexer,parser:MacroParser,cstWalker:MacroCstWalker,category:MacroCategory,valueType:MacroValueType,
  register:MacroRegistry.registerMacro.bind(MacroRegistry),registerAlias:MacroRegistry.registerMacroAlias.bind(MacroRegistry)};
`;
