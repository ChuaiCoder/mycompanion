import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PresetSettings } from "./PresetSettings";

const settingsRoot = vi.hoisted(() => ({ root: { __mycompanion_preferences: {} as Record<string, unknown> }, save: vi.fn() }));
vi.mock("../extension-settings", () => ({
  loadSharedExtensionSettings: async () => settingsRoot.root,
  saveSharedExtensionSettings: settingsRoot.save,
  saveSharedExtensionSettingsDebounced: vi.fn(),
  flushSharedExtensionSettings: vi.fn(),
  onSharedExtensionSettingsSaved: vi.fn(),
  reloadApplication: vi.fn(),
}));

const provider = { kind: "openai-compatible", baseUrl: "https://api.test/v1", model: "gpt-4o",
  hasApiKey: true, temperature: 0.8, maxTokens: 1024, contextLimitTokens: 32768 };
const entries = [
  { name: "Creative", preset: { temperature: 1.4, maxTokens: 2048, contextLimitTokens: 65536 } },
  { name: "Tavern import", preset: { temperature: 0.5, openai_max_tokens: 512, openai_max_context: 8192 } },
];
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); settingsRoot.root.__mycompanion_preferences = {}; });

function stubFetch(saved: typeof provider = provider) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === "/api/presets/openai") return response({ entries });
    if (url === "/api/settings/provider" && !init?.method) return response(provider);
    if (url === "/api/settings/provider" && init?.method === "PUT") return response(saved);
    if (url === "/api/presets/save") return response({ name: JSON.parse(String(init?.body)).name });
    return response({}, 404);
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, calls };
}

it("applies a selected preset's generation fields to the saved provider connection", async () => {
  const { calls } = stubFetch();
  const saved = vi.fn();
  window.addEventListener("mycompanion:provider-saved", saved);
  try {
    render(<PresetSettings />);
    await screen.findByRole("option", { name: "Creative" });
    fireEvent.change(screen.getByRole("combobox", { name: "当前预设" }), { target: { value: "Tavern import" } });
    await waitFor(() => expect(calls.some(({ url, init }) => url === "/api/settings/provider" && init?.method === "PUT")).toBe(true));
    const put = calls.find(({ url, init }) => url === "/api/settings/provider" && init?.method === "PUT")!;
    expect(JSON.parse(String(put.init!.body))).toMatchObject({
      kind: "openai-compatible", baseUrl: "https://api.test/v1", model: "gpt-4o",
      temperature: 0.5, maxTokens: 512, contextLimitTokens: 8192, clearApiKey: false,
    });
    await screen.findByText("已应用预设“Tavern import”。");
    expect(saved).toHaveBeenCalledOnce();
  } finally {
    window.removeEventListener("mycompanion:provider-saved", saved);
  }
});

it("saves the current provider snapshot under a prompted name and binds connection fields only when checked", async () => {
  const { calls } = stubFetch();
  const prompt = vi.spyOn(window, "prompt").mockReturnValue("My preset");
  render(<PresetSettings />);
  await screen.findByRole("option", { name: "Creative" });
  fireEvent.click(screen.getByRole("button", { name: "另存为" }));
  await waitFor(() => expect(calls.some(({ url }) => url === "/api/presets/save")).toBe(true));
  const save = calls.find(({ url }) => url === "/api/presets/save")!;
  expect(JSON.parse(String(save.init!.body))).toEqual({ apiId: "openai", name: "My preset", preset: {
    kind: "openai-compatible", baseUrl: "https://api.test/v1", model: "gpt-4o",
    temperature: 0.8, maxTokens: 1024, contextLimitTokens: 32768,
  } });
  await screen.findByRole("option", { name: "My preset" });

  // 勾选绑定后，预设里的连接字段才会随选择应用。
  fireEvent.click(screen.getByRole("checkbox"));
  await waitFor(() => expect(settingsRoot.save).toHaveBeenCalled());
  expect(settingsRoot.root.__mycompanion_preferences.bind_preset_to_connection).toBe(true);
  prompt.mockRestore();
});
