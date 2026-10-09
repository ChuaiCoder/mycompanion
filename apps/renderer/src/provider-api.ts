import { providerProfilesSchema, providerProfileSchema, providerConnectionResponseSchema,
  type ProviderProfiles, type ProviderProfile, type SaveProviderProfile, type ProviderTaskAssignments, type UpdateProviderSettings } from "@mycompanion/shared";
import { readApiPayload } from "./api";

async function request(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { method, headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), ...(signal ? { signal } : {}) });
  return readApiPayload(response);
}
export const getProviderProfiles = async (signal?: AbortSignal): Promise<ProviderProfiles> => providerProfilesSchema.parse(await request("/api/settings/providers", "GET", undefined, signal));
export const saveProviderProfile = async (id: string | null, value: SaveProviderProfile): Promise<ProviderProfile> => providerProfileSchema.parse(await request(id ? `/api/settings/providers/${encodeURIComponent(id)}` : "/api/settings/providers", id ? "PUT" : "POST", value));
export const deleteProviderProfile = async (id: string): Promise<ProviderProfiles> => providerProfilesSchema.parse(await request(`/api/settings/providers/${encodeURIComponent(id)}`, "DELETE"));
export const assignProviderTasks = async (value: Partial<ProviderTaskAssignments>): Promise<ProviderProfiles> => providerProfilesSchema.parse(await request("/api/settings/provider-tasks", "PATCH", value));
export const testProviderProfile = async (id: string, value: UpdateProviderSettings, task: "chat" | "embedding") => providerConnectionResponseSchema.parse(await request(`/api/settings/providers/${encodeURIComponent(id)}/test`, "POST", { ...value, task }));
