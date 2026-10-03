export type GraphAtom = null | string | boolean | number | { ref: number } | { scalar: string; value?: string };
export interface WorldInfoGraph { root: GraphAtom; nodes: Array<{ id: number; kind: string; values: unknown }> }
/** JSON transport retaining shared entry/array/Map/Set references and cycles. */
export function encodeWorldInfoGraph(root: unknown, objects: object[] = []): WorldInfoGraph {
  const ids = new WeakMap<object, number>(objects.map((value, index) => [value, index]));
  const nodes: WorldInfoGraph["nodes"] = [], visited = new Set<number>();
  const atom = (value: unknown): GraphAtom => {
    if (value === undefined) return { scalar: "undefined" };
    if (typeof value === "bigint") return { scalar: "bigint", value: String(value) };
    if (typeof value === "number" && !Number.isFinite(value)) return { scalar: "number", value: String(value) };
    if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value !== "object") throw new TypeError("World Info event values must be transportable data");
    let id = ids.get(value);
    if (id === undefined) { id = objects.length; ids.set(value, id); objects.push(value); }
    if (!visited.has(id)) {
      visited.add(id);
      const node = { id, kind: "object", values: undefined as unknown }; nodes.push(node);
      const tag = Object.prototype.toString.call(value);
      if (tag === "[object Map]") { node.kind = "map"; node.values = [...(value as Map<unknown, unknown>)].map(([key, item]) => [atom(key), atom(item)]); }
      else if (tag === "[object Set]") { node.kind = "set"; node.values = [...(value as Set<unknown>)].map(atom); }
      else if (Array.isArray(value)) { node.kind = "array"; node.values = value.map(atom); }
      else node.values = Object.entries(value).map(([key, item]) => [key, atom(item)]);
    }
    return { ref: id };
  };
  return { root: atom(root), nodes };
}
export function decodeWorldInfoGraph(graph: WorldInfoGraph, objects: object[] = []): any {
  for (const node of graph.nodes) {
    if (!Number.isInteger(node.id) || node.id < 0) throw new TypeError("Invalid World Info graph identity");
    const existing = objects[node.id], tag = Object.prototype.toString.call(existing);
    const compatible = node.kind === "map" ? tag === "[object Map]" : node.kind === "set" ? tag === "[object Set]"
      : node.kind === "array" ? Array.isArray(existing) : existing !== null && typeof existing === "object" && tag === "[object Object]";
    if (!compatible) objects[node.id] = node.kind === "map" ? new Map() : node.kind === "set" ? new Set() : node.kind === "array" ? [] : {};
  }
  const atom = (value: GraphAtom): any => {
    if (value === null || typeof value !== "object") return value;
    if ("ref" in value) { if (!objects[value.ref]) throw new TypeError("Missing World Info graph identity"); return objects[value.ref]; }
    if (value.scalar === "undefined") return undefined;
    if (value.scalar === "bigint") return BigInt(value.value!);
    if (value.scalar === "number") return Number(value.value);
    throw new TypeError("Invalid World Info graph scalar");
  };
  for (const node of graph.nodes) {
    const target: any = objects[node.id], values: any = node.values;
    if (node.kind === "map") { target.clear(); for (const [key, value] of values) target.set(atom(key), atom(value)); }
    else if (node.kind === "set") { target.clear(); for (const value of values) target.add(atom(value)); }
    else if (node.kind === "array") { target.splice(0, target.length, ...values.map(atom)); }
    else {
      for (const key of Object.keys(target)) delete target[key];
      for (const [key, value] of values) Object.defineProperty(target, key, { value: atom(value), enumerable: true, writable: true, configurable: true });
    }
  }
  return atom(graph.root);
}
export const worldInfoGraphBrowserSource = `export ${encodeWorldInfoGraph.toString()}\nexport ${decodeWorldInfoGraph.toString()}\n`;
