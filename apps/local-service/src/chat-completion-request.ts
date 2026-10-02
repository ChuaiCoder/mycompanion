import { parse as parseYaml } from "yaml";
import type { ProviderSettings } from "@mycompanion/shared";
import { ModelRequestError } from "./model-request-error.js";

function yamlValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return parseYaml(value); } catch { return undefined; }
}
function yamlObject(value: unknown): Record<string, unknown> {
  const parsed = yamlValue(value);
  return Object.fromEntries((Array.isArray(parsed) ? parsed : [parsed]).flatMap(item => item && typeof item === "object" && !Array.isArray(item) ? Object.entries(item) : []));
}

// Shared by native chat and the public Tavern completion endpoint.
export function normalizeChatCompletionRequest(input: Record<string, unknown>, settings: ProviderSettings, savedApiKey?: string) {
  const source = input.chat_completion_source ?? "custom";
  if (source !== "custom" && source !== "openai") throw new ModelRequestError(`尚未实现该提供商的原生传输协议：${String(source)}`, 400);
  const override = source === "custom" && input.custom_url ? input.custom_url : input.reverse_proxy;
  const baseUrl = typeof override === "string" && override ? override : settings.baseUrl;
  // A custom target must not inherit the saved provider's credentials.
  const sameOrigin = new URL(baseUrl).origin === new URL(settings.baseUrl).origin;
  const apiKey = typeof input.proxy_password === "string" ? input.proxy_password : sameOrigin ? savedApiKey : undefined;
  const body: Record<string, unknown> = { model: settings.model, messages: input.messages, stream: false };
  for (const field of ["model", "stream", "temperature", "max_tokens", "max_completion_tokens", "presence_penalty", "frequency_penalty", "top_p", "top_k", "stop", "logit_bias", "seed", "n", "tools", "tool_choice", "parallel_tool_calls", "reasoning_effort", "verbosity", "response_format", "logprobs", "top_logprobs"]) {
    if (Object.hasOwn(input, field)) body[field] = input[field];
  }
  if (typeof body.logprobs === "number" && body.logprobs > 0) { body.top_logprobs = body.logprobs; body.logprobs = true; }
  if (source === "custom") Object.defineProperties(body, Object.getOwnPropertyDescriptors(yamlObject(input.custom_include_body)));
  const schema = input.json_schema as Record<string, unknown> | undefined;
  if (schema && !body.response_format) body.response_format = { type: "json_schema", json_schema: { name: schema.name, schema: schema.value, strict: schema.strict ?? true } };
  if (source === "custom") {
    const excluded = yamlValue(input.custom_exclude_body);
    for (const key of Array.isArray(excluded) ? excluded : typeof excluded === "string" ? [excluded] : excluded && typeof excluded === "object" ? Object.keys(excluded) : []) delete body[String(key)];
  }
  const extraHeaders = source === "custom" ? Object.fromEntries(Object.entries(yamlObject(input.custom_include_headers)).map(([key, value]) => [key, String(value)])) : {};
  return { baseUrl, apiKey, body, extraHeaders };
}
