export interface MacroCharacterFormatting {
  /** Chat Completion hosts leave this false; text completion hosts supply the live mode. */
  isInstruct: boolean;
  parseMesExamples(raw: string, isInstruct: boolean): string[];
  formatInstructModeExamples(examples: string[], user: string, character: string): string[];
}
export interface MacroEnvironment {
  content: string;
  contentHash: number;
  names: Record<string, string>;
  character: Record<string, unknown>;
  system: Record<string, unknown>;
  functions: { postProcess(value: string): string; original?: () => string };
  dynamicMacros: Record<string, unknown>;
  extra: Record<string, unknown> & Partial<MacroCharacterFormatting>;
}
export interface MacroExecutionContext {
  name: string;
  args: string[];
  unnamedArgs: string[];
  list: string[] | null;
  namedArgs: null;
  env: MacroEnvironment;
  flags: Record<string, boolean>;
  isScoped: boolean;
  raw: string;
  rawOriginal: string;
  resolve(text: string, options?: { offsetDelta?: number }): string;
  normalize(value: unknown): string;
  trimContent(text: string, options?: { trimIndent?: boolean }): string;
  warn(message: string, error?: unknown): void;
}
export interface MacroOptions {
  handler(context: MacroExecutionContext): unknown;
  unnamedArgs?: number | Array<{ name: string; optional?: boolean; defaultValue?: string; type?: string | string[]; description?: string }>;
  aliases?: Array<{ alias: string; visible?: boolean }>;
  list?: boolean | { min?: number; max?: number };
  strictArgs?: boolean;
  delayArgResolution?: boolean;
  category?: string;
  description?: string;
  returns?: string;
  returnType?: string | string[];
}
export const MacroRegistry: {
  registerMacro(name: string, options: MacroOptions): Record<string, unknown> | null;
  unregisterMacro(name: string): boolean;
  registerMacroAlias(target: string, alias: string, options?: { visible?: boolean }): boolean;
  getMacro(name: string): Record<string, unknown> | undefined;
  getPrimaryMacro(name: string): Record<string, unknown> | undefined;
  hasMacro(name: string): boolean;
  getAllMacros(options?: { excludeAliases?: boolean; excludeHiddenAliases?: boolean }): Array<Record<string, unknown>>;
  executeMacro(call: Record<string, unknown>, options?: { defOverride?: Record<string, unknown> }): string;
};
export const MacroEngine: { evaluate(text: string, env: MacroEnvironment, options?: { contextOffset?: number }): string };
export const MacroCategory: Record<string, string>;
export const MacroValueType: Record<string, string>;
export function createMacroEnvironment(content: string, values?: Partial<MacroEnvironment>): MacroEnvironment;
export interface MacroRawContext {
  content: string;
  name1Override?: string | null;
  name2Override?: string | null;
  groupOverride?: string | null;
  original?: string | null;
  replaceCharacterCard?: boolean;
  dynamicMacros?: Record<string, unknown>;
  postProcessFn?: (value: string) => string;
}
export class MacroEnvironmentBuilder {
  constructor(readHost: () => {
    name1?: string; name2?: string;
    characters?: Array<{ name: string; avatar: string }>;
    selected_group?: string | null;
    groups?: Array<{ id: string; members: string[]; disabled_members?: string[] }>;
    getCharacterCardFieldsLazy(): Record<string, unknown>;
    getGeneratingModel(): string;
  });
  registerProvider(provider: (env: MacroEnvironment, context: MacroRawContext) => void, order?: number): void;
  buildFromRawEnv(context: MacroRawContext): MacroEnvironment;
}
export const env_provider_order: { EARLIEST: 0; EARLY: 10; NORMAL: 50; LATE: 90; LATEST: 100 };
export function initRegisterMacros(): void;
export interface VariableStore {
  get(name: string, args?: {key?: string; index?: string | number}): unknown;
  set(name: string, value: unknown, args?: {index?: string | number; as?: string}): unknown;
  add(name: string, value: unknown): unknown;
  inc(name: string): unknown;
  dec(name: string): unknown;
  has(name: string): boolean;
  delete(name: string): string;
}
export function createVariableStores(readLocal: () => Record<string, unknown>, readGlobal: () => Record<string, unknown>, onChange?: (global: boolean) => void): {local: VariableStore; global: VariableStore};
export function createLegacyVariableMacroRules(stores: {local: VariableStore; global: VariableStore}): Array<{regex:RegExp; replace:(match:string,...args:any[])=>unknown}>;
