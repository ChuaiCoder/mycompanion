import {
  providerConnectionResponseSchema,
  providerSettingsSchema,
  type ProviderConnectionResponse,
  type ProviderSettings,
  type UpdateProviderSettings,
} from "@mycompanion/shared";

import { readApiPayload } from "./core";

export async function getProviderSettings(signal?: AbortSignal): Promise<ProviderSettings> {
  const response = await fetch("/api/settings/provider", {
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  return providerSettingsSchema.parse(await readApiPayload(response));
}

export async function saveProviderSettings(
  settings: UpdateProviderSettings,
): Promise<ProviderSettings> {
  const response = await fetch("/api/settings/provider", {
    method: "PUT",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  return providerSettingsSchema.parse(await readApiPayload(response));
}

export async function testProvider(settings?: UpdateProviderSettings): Promise<ProviderConnectionResponse> {
  const response = await fetch("/api/settings/provider/test", {
    method: "POST",
    headers: { Accept: "application/json", ...(settings ? { "Content-Type": "application/json" } : {}) },
    ...(settings ? { body: JSON.stringify(settings) } : {}),
  });
  return providerConnectionResponseSchema.parse(await readApiPayload(response));
}
