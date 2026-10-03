import type { ExtensionPrompt, LorebookReport } from "@mycompanion/shared";

const OUTLET_PREFIX = "customWIOutlet_";
interface Activation { resultIndex: number; entry: Record<string, unknown> }
const activations = new WeakMap<LorebookReport, Activation[]>();

/** Preserve the upstream activation Map's order independently of diagnostics. */
export function attachWorldInfoActivations(report: LorebookReport, entries: Activation[]): void { activations.set(report, entries); }
export function transferWorldInfoActivations(from: LorebookReport, to: LorebookReport): void {
  const entries = activations.get(from); if (entries) activations.set(to, entries);
}
/** The activation event receives scanned entries, before presentation regex. */
export function getWorldInfoActivatedEntries(report: LorebookReport): Record<string, unknown>[] {
  return structuredClone((activations.get(report) ?? []).map(item => item.entry));
}
export function getWorldInfoOutletEntries(report: LorebookReport): Record<string, string[]> {
  const byIndex = new Map(report.results.map(entry => [entry.index, entry]));
  const entries = activations.has(report)
    ? activations.get(report)!.map(entry => byIndex.get(entry.resultIndex)!).filter(Boolean)
    : report.results.filter(entry => entry.status === "injected");
  const outlets: Record<string, string[]> = {};
  // ST pushes outlets in descending order; stable ties follow activation order.
  for (const entry of [...entries].sort((a, b) => (b.insertionOrder ?? 0) - (a.insertionOrder ?? 0))) {
    if (entry.position !== 7 || !entry.outletName || !entry.content) continue;
    if (!Object.hasOwn(outlets, entry.outletName)) Object.defineProperty(outlets, entry.outletName,
      { value: [], enumerable: true, writable: true, configurable: true });
    outlets[entry.outletName]!.push(entry.content);
  }
  return outlets;
}
export function getWorldInfoOutlets(report: LorebookReport): Record<string, string> {
  return Object.fromEntries(Object.entries(getWorldInfoOutletEntries(report)).map(([key, values]) => [key, values.join("\n")]));
}
export function worldInfoOutletsFromPrompts(prompts: ExtensionPrompt[]): Record<string, string> {
  return Object.fromEntries(prompts.filter(prompt => prompt.key.startsWith(OUTLET_PREFIX))
    .map(prompt => [prompt.key.slice(OUTLET_PREFIX.length), prompt.value]));
}
