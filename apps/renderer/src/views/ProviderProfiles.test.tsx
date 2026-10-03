import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import type { ProviderProfiles as ProfilesState } from "@mycompanion/shared";
import { ProviderProfiles } from "./ProviderProfiles";
import * as api from "../provider-api";
import "../i18n";
vi.mock("../provider-api", () => ({ getProviderProfiles: vi.fn(), saveProviderProfile: vi.fn(), deleteProviderProfile: vi.fn(), assignProviderTasks: vi.fn(), testProviderProfile: vi.fn() }));
const settings = { kind: "openai-compatible" as const, baseUrl: "http://profiles.test/v1", model: "chat-model", temperature: 0.8, maxTokens: 128, contextLimitTokens: 4096, hasApiKey: true };
const state: ProfilesState = { profiles: [{ id: "a", name: "First", settings }, { id: "b", name: "Vectors", settings: { ...settings, model: "embedding-model" } }], tasks: { chat: "a", summary: null, extraction: null, embedding: null } };
afterEach(() => { cleanup(); vi.resetAllMocks(); });
async function open() {
  vi.mocked(api.getProviderProfiles).mockResolvedValue(state);
  render(<StrictMode><ProviderProfiles /></StrictMode>);
  await screen.findByLabelText("聊天使用");
  fireEvent.click(screen.getByText("更多连接与任务模型"));
  await screen.findByLabelText("连接名称");
}

it("StrictMode loads the independent editor and clears keys when switching or adding another connection", async () => {
  await open(); expect((screen.getByLabelText("连接名称") as HTMLInputElement).value).toBe("First");
  fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "transient-first-key" } });
  fireEvent.change(screen.getByLabelText("编辑连接"), { target: { value: "b" } });
  expect((screen.getByLabelText("API Key") as HTMLInputElement).value).toBe("");
  expect((screen.getByLabelText("模型名称") as HTMLInputElement).value).toBe("embedding-model");
  fireEvent.click(screen.getByRole("button", { name: "新增连接" }));
  expect((screen.getByLabelText("API Key") as HTMLInputElement).value).toBe("");
  expect((screen.getByLabelText("连接名称") as HTMLInputElement).value).toBe("");
});

it("assigns an embedding task without selecting it for chat and tests its dedicated embedding protocol", async () => {
  await open();
  vi.mocked(api.assignProviderTasks).mockResolvedValue({ ...state, tasks: { ...state.tasks, embedding: "b" } });
  fireEvent.change(screen.getByLabelText("语义检索 (Embedding)"), { target: { value: "b" } });
  await waitFor(() => expect(api.assignProviderTasks).toHaveBeenCalledWith({ embedding: "b" }));
  await waitFor(() => expect((screen.getByLabelText("语义检索 (Embedding)") as HTMLSelectElement).value).toBe("b"));
  expect((screen.getByLabelText("聊天使用") as HTMLSelectElement).value).toBe("a");
  fireEvent.change(screen.getByLabelText("编辑连接"), { target: { value: "b" } });
  vi.mocked(api.testProviderProfile).mockResolvedValue({ ok: true, message: "Vectors accepted", models: [], capability: "embedding" });
  fireEvent.click(screen.getByRole("button", { name: "测试 Embedding" }));
  await waitFor(() => expect(api.testProviderProfile).toHaveBeenCalledWith("b", expect.objectContaining({ model: "embedding-model" }), "embedding"));
  expect(await screen.findByRole("status")).toHaveTextContent("Vectors accepted");
});

it("saving a new named connection passes only its explicit key and clears the transient field after success", async () => {
  await open(); fireEvent.click(screen.getByRole("button", { name: "新增连接" }));
  fireEvent.change(screen.getByLabelText("连接名称"), { target: { value: "Third" } });
  fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "new-explicit-key" } });
  const profile = { id: "c", name: "Third", settings };
  vi.mocked(api.saveProviderProfile).mockResolvedValue(profile);
  vi.mocked(api.getProviderProfiles).mockResolvedValue({ ...state, profiles: [...state.profiles, profile] });
  fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
  await waitFor(() => expect(api.saveProviderProfile).toHaveBeenCalledWith(null, expect.objectContaining({ name: "Third", settings: expect.objectContaining({ apiKey: "new-explicit-key", hasApiKey: false }) })));
  await waitFor(() => expect((screen.getByLabelText("API Key") as HTMLInputElement).value).toBe(""));
});
