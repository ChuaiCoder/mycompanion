import type { FastifyInstance } from "fastify";
import type { RuntimeRepository } from "../persistence/runtime-repository.js";

// Part of the existing extension-settings backup domain, but written through
// preset routes so an older browser settings snapshot cannot erase new presets.
export const PRESET_STORAGE_KEY = "__mycompanion_presets";
type Entry = { name: string; preset: Record<string, unknown> };
export function registerPresetRoutes(app: FastifyInstance, runtime: RuntimeRepository): void {
  const read = (): Entry[] => {
    const value = runtime.getExtensionSettings()[PRESET_STORAGE_KEY];
    return Array.isArray(value) ? value : [];
  };
  const write = (entries: Entry[]): void => runtime.saveExtensionSettings({ ...runtime.getExtensionSettings(), [PRESET_STORAGE_KEY]: entries });
  const properties = { apiId: { type: "string", const: "openai" }, name: { type: "string", minLength: 1, pattern: "^[^\\u0000]+$" } };
  const body = { type: "object", required: ["apiId", "name"], properties };
  app.get("/api/presets/openai", async (_request, reply) => reply.header("Cache-Control", "no-store").send({ entries: read() }));
  app.post<{ Body: { apiId: string; name: string; preset: Record<string, unknown> } }>("/api/presets/save", {
    bodyLimit: 500 * 1024 * 1024,
    schema: { body: { ...body, required: [...body.required, "preset"], properties: { ...properties, preset: { type: "object", additionalProperties: true } } } },
  }, async (request, reply) => {
    const name = request.body.name.trim();
    if (!name) return reply.status(400).send({ error: "Preset name is empty" });
    const entries = read(), entry = { name, preset: request.body.preset }, index = entries.findIndex(item => item.name === name);
    if (index < 0) entries.push(entry); else entries[index] = entry;
    write(entries);
    return { name };
  });
  app.post<{ Body: { apiId: string; name: string } }>("/api/presets/delete", { schema: { body } }, async (request, reply) => {
    const entries = read(), index = entries.findIndex(item => item.name === request.body.name);
    if (index < 0) return reply.status(404).send({ error: "Preset not found" });
    entries.splice(index, 1); write(entries); return { ok: true };
  });
  app.post<{ Body: { apiId: string; name: string; newName: string; preset: Record<string, unknown> } }>("/api/presets/rename", {
    bodyLimit: 500 * 1024 * 1024,
    schema: { body: { ...body, required: [...body.required, "newName", "preset"], properties: { ...properties, newName: properties.name, preset: { type: "object", additionalProperties: true } } } },
  }, async (request, reply) => {
    const name = request.body.newName.trim(), entries = read(), index = entries.findIndex(item => item.name === request.body.name);
    if (!name) return reply.status(400).send({ error: "Preset name is empty" });
    if (index < 0) return reply.status(404).send({ error: "Preset not found" });
    if (entries.some(item => item.name.localeCompare(name, undefined, { sensitivity: "base" }) === 0)) return reply.status(409).send({ error: "Preset name already exists" });
    entries[index] = { name, preset: request.body.preset }; write(entries); return { name };
  });
  // No upstream preset pack is bundled. This is Tavern's non-default response.
  app.post("/api/presets/restore", { schema: { body } }, async () => ({ isDefault: false, preset: {} }));
}
