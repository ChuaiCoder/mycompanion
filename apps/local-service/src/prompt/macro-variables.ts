// Project-owned variable operations shared by browser persistence and native request drafts.
// Vendored from packages/macro-engine/src/variable-stores.js and src/boolean.js
// (AGPL-3.0-only) so the native prompt path no longer imports the macro-engine package.

export interface VariableStore {
  get(name: string, args?: {key?: string; index?: string | number}): unknown;
  set(name: string, value: unknown, args?: {index?: string | number; as?: string}): unknown;
  add(name: string, value: unknown): unknown;
  inc(name: string): unknown;
  dec(name: string): unknown;
  has(name: string): boolean;
  delete(name: string): string;
}

// Tavern's boolean vocabulary, shared by argument validation and conditions.
const isTrueBoolean = (value: unknown): boolean => ["true", "on", "yes", "1"].includes(String(value).toLowerCase());

export function createVariableStores(
  readLocal: () => Record<string, unknown>,
  readGlobal: () => Record<string, unknown>,
  onChange: (global: boolean) => void = () => {},
): {local: VariableStore; global: VariableStore} {
  const put = (object: Record<PropertyKey, unknown>, key: PropertyKey, value: unknown) =>
    Object.defineProperty(object, key, {value, enumerable: true, writable: true, configurable: true});
  const own = (object: Record<PropertyKey, unknown>, key: PropertyKey): unknown =>
    Object.hasOwn(object, key) ? object[key] : undefined;
  const store = (global: boolean) => global ? readGlobal() : readLocal();
  const save = (global: boolean) => onChange(global);
  function convert(value: unknown, type: unknown): unknown {
    switch (typeof type === "string" ? type.trim().toLowerCase() : "") {
      case "string": case "str": return String(value);
      case "null": return null;
      case "undefined": case "none": return undefined;
      case "number": return Number(value);
      case "int": return parseInt(value as string, 10);
      case "float": return parseFloat(value as string);
      case "bool": case "boolean": return isTrueBoolean(value);
      case "array": case "list": try { const parsed = JSON.parse(value as string); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
      case "object": case "dict": case "dictionary": try { const parsed = JSON.parse(value as string); return typeof parsed === "object" ? parsed : {}; } catch { return {}; }
      default: return value;
    }
  }
  function get(global: boolean, name: string, args: {key?: string; index?: string | number} = {}): unknown {
    let value: unknown = own(store(global), args.key ?? name);
    if (args.index !== undefined) {
      try {
        value = JSON.parse(value as string); const numeric = Number(args.index);
        value = own(value as Record<PropertyKey, unknown>, Number.isNaN(numeric) ? args.index : numeric);
        if (typeof value === "object") value = JSON.stringify(value);
      } catch { /* Tavern leaves malformed JSON unchanged. */ }
    }
    return (value as {trim?: () => string} | null | undefined)?.trim?.() === "" || Number.isNaN(Number(value)) ? (value || "") : Number(value);
  }
  function set(global: boolean, name: string, value: unknown, args: {index?: string | number; as?: string} = {}): unknown {
    if (!name) throw new Error("Variable name cannot be empty or undefined.");
    const target = store(global);
    if (args.index === undefined) put(target, name, value);
    else {
      try {
        const numeric = Number(args.index), isKey = Number.isNaN(numeric);
        const container = JSON.parse((own(target, name) as string) ?? "null") ?? (isKey ? {} : []);
        put(container, isKey ? args.index! : numeric, convert(value, args.as));
        put(target, name, JSON.stringify(container));
      } catch { /* Invalid existing containers are retained, as in Tavern. */ }
    }
    save(global); return value;
  }
  function add(global: boolean, name: string, value: unknown): unknown {
    const current = get(global, name) || 0;
    try {
      const list: unknown[] = JSON.parse(current as string);
      if (Array.isArray(list)) { list.push(value); set(global, name, JSON.stringify(list)); return list; }
    } catch { /* Non-list values fall through to numeric/string addition. */ }
    const next = Number.isNaN(Number(value)) || Number.isNaN(Number(current)) ? String(current || "") + value : Number(current) + Number(value);
    if (typeof next === "number" && Number.isNaN(next)) return "";
    set(global, name, next); return next;
  }
  const exists = (global: boolean, name: string): boolean => own(store(global), name) !== undefined;
  function remove(global: boolean, name: string): string {
    if (exists(global, name)) { delete store(global)[name]; save(global); }
    return "";
  }
  const getLocalVariable = (name: string, args?: {key?: string; index?: string | number}) => get(false, name, args);
  const getGlobalVariable = (name: string, args?: {key?: string; index?: string | number}) => get(true, name, args);
  const setLocalVariable = (name: string, value: unknown, args?: {index?: string | number; as?: string}) => set(false, name, value, args);
  const setGlobalVariable = (name: string, value: unknown, args?: {index?: string | number; as?: string}) => set(true, name, value, args);
  const addLocalVariable = (name: string, value: unknown) => add(false, name, value);
  const addGlobalVariable = (name: string, value: unknown) => add(true, name, value);
  const incrementLocalVariable = (name: string) => add(false, name, 1);
  const incrementGlobalVariable = (name: string) => add(true, name, 1);
  const decrementLocalVariable = (name: string) => add(false, name, -1);
  const decrementGlobalVariable = (name: string) => add(true, name, -1);
  const existsLocalVariable = (name: string) => exists(false, name);
  const existsGlobalVariable = (name: string) => exists(true, name);
  const deleteLocalVariable = (name: string) => remove(false, name);
  const deleteGlobalVariable = (name: string) => remove(true, name);
  const variableStores = {
    local: {get: getLocalVariable, set: setLocalVariable, add: addLocalVariable, inc: incrementLocalVariable, dec: decrementLocalVariable, has: existsLocalVariable, delete: deleteLocalVariable},
    global: {get: getGlobalVariable, set: setGlobalVariable, add: addGlobalVariable, inc: incrementGlobalVariable, dec: decrementGlobalVariable, has: existsGlobalVariable, delete: deleteGlobalVariable},
  };

  return variableStores;
}

// Project-owned legacy replacement order, shared by the browser and native drafts.
export function createLegacyVariableMacroRules(
  stores: {local: VariableStore; global: VariableStore},
): Array<{regex: RegExp; replace: (match: string, ...args: string[]) => unknown}> {
  return [false, true].flatMap(global => {
    const {get, set, add} = stores[global ? "global" : "local"];
    const suffix = global ? "globalvar" : "var";
    return [
      {regex: new RegExp("{{set" + suffix + "::([^:]+)::([^}]*)}}", "gi"), replace: (_: string, name: string, value: string) => { set(name.trim(), value); return ""; }},
      {regex: new RegExp("{{add" + suffix + "::([^:]+)::([^}]+)}}", "gi"), replace: (_: string, name: string, value: string) => { add(name.trim(), value); return ""; }},
      {regex: new RegExp("{{inc" + suffix + "::([^}]+)}}", "gi"), replace: (_: string, name: string) => add(name.trim(), 1)},
      {regex: new RegExp("{{dec" + suffix + "::([^}]+)}}", "gi"), replace: (_: string, name: string) => add(name.trim(), -1)},
      {regex: new RegExp("{{get" + suffix + "::([^}]+)}}", "gi"), replace: (_: string, name: string) => get(name.trim())},
    ];
  });
}
