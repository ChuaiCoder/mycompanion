import type { WorldInfoDocument } from "@mycompanion/shared";
import { loadExtensionHost } from "./ExtensionHost";

export interface WorldInfoRuntime {
  world_names: string[];
  newWorldInfoEntryTemplate: Record<string, unknown>;
  loadWorldInfo(name: string): Promise<WorldInfoDocument | null>;
  saveWorldInfo(name: string, data: WorldInfoDocument, immediately: boolean): Promise<void>;
  createNewWorldInfo(name: string): Promise<boolean>;
  deleteWorldInfo(name: string): Promise<boolean>;
  updateWorldInfoList(): Promise<void>;
  selectWorldInfoEditor(name: string): void;
  syncWorldInfoControls(): void;
}
export async function loadWorldInfoRuntime(): Promise<WorldInfoRuntime> {
  await loadExtensionHost();
  const path = "/plugin-runtime/world-info.js";
  const module = await import(/* @vite-ignore */ path);
  const contractPath = "/scripts/world-info.js";
  const contract = await import(/* @vite-ignore */ contractPath);
  return { ...module, newWorldInfoEntryTemplate: contract.newWorldInfoEntryTemplate } as WorldInfoRuntime;
}
