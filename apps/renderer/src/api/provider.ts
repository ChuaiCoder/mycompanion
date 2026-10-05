import {
  providerConnectionResponseSchema,
  providerModelsResponseSchema,
  providerSettingsSchema,
  type ProviderConnectionResponse,
  type ProviderModelsResponse,
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

/**
 * 「测试获取模型」：按协议拉取该服务商真实可用的模型名。
 * 带 draft 时用草稿设置与草稿密钥（还没保存也能先试）；不带时用已保存的设置与密钥。
 */
export async function listProviderModels(
  draft?: UpdateProviderSettings,
  signal?: AbortSignal,
): Promise<ProviderModelsResponse> {
  const response = await fetch("/api/settings/provider/models", {
    method: "POST",
    headers: { Accept: "application/json", ...(draft ? { "Content-Type": "application/json" } : {}) },
    ...(draft ? { body: JSON.stringify(draft) } : {}),
    ...(signal ? { signal } : {}),
  });
  return providerModelsResponseSchema.parse(await readApiPayload(response));
}

/**
 * 连接测试：不带参数时由后端用**已保存**的模型设置去要一次模型列表（GET /models），
 * 这是判断"模型连得上吗"的轻量方式——不会真的发一次对话、不消耗 token。
 */
export async function testProvider(
  settings?: UpdateProviderSettings,
  signal?: AbortSignal,
): Promise<ProviderConnectionResponse> {
  const response = await fetch("/api/settings/provider/test", {
    method: "POST",
    headers: { Accept: "application/json", ...(settings ? { "Content-Type": "application/json" } : {}) },
    ...(settings ? { body: JSON.stringify(settings) } : {}),
    ...(signal ? { signal } : {}),
  });
  return providerConnectionResponseSchema.parse(await readApiPayload(response));
}
