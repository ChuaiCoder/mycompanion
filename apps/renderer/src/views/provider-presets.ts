import type { ProviderKind } from "@mycompanion/shared";

/**
 * 模型来源预设。
 *
 * 关键设计：`kind` 仍然只是**协议**（openai-compatible / ollama / anthropic / gemini），
 * 服务商是这层纯数据。这样加一家新服务商不需要改 schema、不需要迁移、不动备份兼容。
 * 地址与模型名只收录官方文档确认过的，避免让用户踩坑。
 */
export interface ProviderPreset {
  id: string;
  /** 中文界面用的名字。 */
  label: string;
  /** 英文界面用的名字。 */
  labelEn: string;
  kind: ProviderKind;
  baseUrl: string;
  /** 官方默认模型；空串表示需要用户自己获取/填写（例如聚合平台、模型广场）。 */
  model: string;
  /** 该服务是否必须有 API Key。 */
  needsKey: boolean;
  /**
   * 端点由服务商唯一确定（云端 API），界面不必让用户填地址与协议。
   * 本机 Ollama 与"自定义"为 false：本地地址可能是 localhost / 127.0.0.1 / 自定义端口，
   * 用户必须能改。
   */
  fixedEndpoint: boolean;
  /** 是否需要展示"地址可编辑"以外的额外说明。 */
  note?: string;
  noteEn?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "deepseek", label: "DeepSeek", labelEn: "DeepSeek", kind: "openai-compatible",
    baseUrl: "https://api.deepseek.com", model: "deepseek-flash", needsKey: true, fixedEndpoint: true,
    note: "DeepSeek 官方 API。也提供 Anthropic 兼容地址，可在「自定义」里使用。",
    noteEn: "DeepSeek's API. An Anthropic-compatible endpoint is also available via Custom.",
  },
  {
    id: "openai", label: "OpenAI", labelEn: "OpenAI", kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", needsKey: true, fixedEndpoint: true,
  },
  {
    id: "anthropic", label: "Anthropic（Claude）", labelEn: "Anthropic (Claude)", kind: "anthropic",
    baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-6", needsKey: true, fixedEndpoint: true,
  },
  {
    id: "gemini", label: "Google Gemini", labelEn: "Google Gemini", kind: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.5-flash", needsKey: true, fixedEndpoint: true,
  },
  {
    id: "ollama", label: "本机 Ollama", labelEn: "Local Ollama", kind: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1", model: "llama3.2", needsKey: false, fixedEndpoint: false,
    note: "先启动 Ollama 并下载模型；本地运行不需要密钥。地址可能是 localhost 或自定义端口，可自行修改。",
    noteEn: "Start Ollama and pull a model first; no key is needed locally. The address may be localhost or a custom port — edit it if needed.",
  },
  {
    id: "custom-openai", label: "自定义（OpenAI 兼容）", labelEn: "Custom (OpenAI compatible)", kind: "openai-compatible",
    baseUrl: "", model: "", needsKey: true, fixedEndpoint: false,
    note: "任何兼容 OpenAI 接口的服务：填服务商给你的地址（通常以 /v1 结尾）。",
    noteEn: "Any OpenAI-compatible service: paste the address your provider gave you (usually ends in /v1).",
  },
  {
    id: "custom-anthropic", label: "自定义（Anthropic 兼容）", labelEn: "Custom (Anthropic compatible)", kind: "anthropic",
    baseUrl: "", model: "", needsKey: true, fixedEndpoint: false,
    note: "兼容 Anthropic Messages 接口的服务，例如 DeepSeek、Kimi、智谱的 Anthropic 兼容地址。",
    noteEn: "Services speaking the Anthropic Messages API, e.g. the Anthropic-compatible endpoints from DeepSeek, Kimi or Zhipu.",
  },
];

/** 端点唯一确定的服务商才隐藏地址与协议；本机与自定义必须可编辑。 */
export function isFixedEndpoint(preset: ProviderPreset): boolean {
  return preset.fixedEndpoint;
}

/** 只取主机名用于展示，例如 https://api.deepseek.com → api.deepseek.com */
export function endpointHost(baseUrl: string): string {
  try { return new URL(baseUrl).host; } catch { return baseUrl; }
}

/** 按当前设置反推用户选的是哪个预设（用于下拉框回显）；找不到就按协议归类为自定义。 */
export function findPreset(provider: { kind: ProviderKind; baseUrl: string }): ProviderPreset {
  const exact = PROVIDER_PRESETS.find(preset => preset.baseUrl && preset.baseUrl === provider.baseUrl);
  if (exact) return exact;
  if (provider.kind === "ollama") return PROVIDER_PRESETS.find(preset => preset.id === "ollama")!;
  if (provider.kind === "anthropic") return PROVIDER_PRESETS.find(preset => preset.id === "custom-anthropic")!;
  return PROVIDER_PRESETS.find(preset => preset.id === "custom-openai")!;
}

export function presetLabel(preset: ProviderPreset, language: string): string {
  return language.startsWith("en") ? preset.labelEn : preset.label;
}
