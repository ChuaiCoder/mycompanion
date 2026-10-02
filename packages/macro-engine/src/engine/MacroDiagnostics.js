// Host-independent diagnostics. Keep errors observable without importing UI,
// account settings, popups or executable code from an upstream application.
export function createMacroRuntimeError({ message, ...context }) {
  return Object.assign(new Error(message), { name: 'MacroRuntimeError', isMacroRuntimeError: true, ...context });
}
const report = (level, context) => console[level]('[Macro engine]', context.message ?? context.phase, context.error ?? context.errors ?? '');
export const logMacroGeneralError = context => report('error', context);
export const logMacroInternalError = context => report('error', context);
export const logMacroRegisterError = context => report('error', context);
export const logMacroRegisterWarning = context => report('warn', context);
export const logMacroRuntimeWarning = context => report('warn', context);
export const logMacroSyntaxWarning = context => report('warn', context);
