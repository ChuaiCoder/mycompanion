import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

const lorebookEntryPreview = {
  index: 0,
  name: "Workshop",
  keys: ["workshop"],
  secondaryKeys: [],
  contentPreview: "The workshop is inside an observatory.",
  sourceEnabled: true,
  constant: false,
  selective: false,
  useRegex: false,
  insertionOrder: 100,
  runtimeState: "stored_inactive",
};

const regexScriptPreview = {
  index: 0,
  name: "Compass cleanup",
  findRegexPreview: "/northward/gi",
  replaceStringPreview: "north",
  placements: ["user_input", "ai_output"],
  sourceDisabled: false,
  markdownOnly: false,
  promptOnly: false,
  runOnEdit: true,
  minDepth: null,
  maxDepth: null,
  runtimeState: "stored_disabled",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("shows the beginner onboarding path", async () => {
    // 侧栏状态点现在是模型连通性：它必须由模型探测的结果决定。
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "/api/settings/provider/test") {
          return new Response(
            JSON.stringify({ ok: true, message: "连接成功，读取到 1 个模型。", models: ["fixture"] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            status: "ok",
            service: "mycompanion-local-service",
            version: "0.1.0",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );

    render(<App />);

    // 默认落地是对话页；新手引导位于角色库视图。
    fireEvent.click(screen.getByRole("button", { name: "角色库" }));

    expect(
      screen.getByRole("heading", {
        name: "导入喜欢的角色，直接开始故事。",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("只需要三步")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("模型已连接")).toBeInTheDocument();
    });
  });

  it("reports an unavailable API without hiding the onboarding content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "角色库" }));

    await waitFor(() => {
      // 模型探测也失败 → 状态点必须是"未连接"，不能像以前那样因为本地健康接口
      // 成功而显示绿灯。
      expect(screen.getByText("模型未连接")).toBeInTheDocument();
    });
    expect(screen.getByText("只需要三步")).toBeInTheDocument();
  });

  it("supports desktop sidebar collapse and the import shortcut", () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const { container } = render(<App />);

    const collapse = screen.getByRole("button", { name: "收起侧边栏" });
    fireEvent.click(collapse);
    expect(screen.getByRole("button", { name: "展开侧边栏" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(container.firstElementChild).toHaveClass(
      "desktop-shell--sidebar-collapsed",
    );

    const input = screen.getByLabelText("选择角色卡文件");
    const click = vi.spyOn(input, "click").mockImplementation(() => undefined);
    fireEvent.keyDown(window, { key: "i", ctrlKey: true });
    expect(click).toHaveBeenCalledOnce();
  });

  it("shows a locally validated JSON character card preview", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                format: "ccv2-json",
                specVersion: "2.0",
                name: "Aster",
                descriptionPreview: "A cartographer.",
                firstMessagePreview: "Welcome to the workshop.",
                creator: "MyCompanion",
                characterVersion: "1.0",
                tags: ["original"],
                alternateGreetingsCount: 1,
                groupOnlyGreetingsCount: 0,
                lorebookEntryCount: 1,
                regexScriptCount: 1,
                lorebookEntries: [lorebookEntryPreview],
                regexScripts: [regexScriptPreview],
                assetCount: 0,
                extensionKeys: ["regex_scripts"],
                unknownFieldPaths: [],
                warningCodes: ["extensions_present", "regex_scripts_stored_disabled"],
              }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            ),
          );
        }

        return Promise.resolve(
          new Response(
            JSON.stringify({
              status: "ok",
              service: "mycompanion-local-service",
              version: "0.1.0",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      }),
    );

    render(<App />);
    const input = screen.getByLabelText("选择角色卡文件");
    const file = new File([JSON.stringify({ spec: "chara_card_v2" })], "aster.json", {
      type: "application/json",
    });

    fireEvent.change(input, { target: { files: [file] } });

    const previewHeading = await screen.findByRole("heading", { name: "Aster" });
    const previewSection = previewHeading.closest("section");
    expect(previewSection).not.toBeNull();
    expect(within(previewSection!).getByText("A cartographer.")).toBeInTheDocument();
    expect(within(previewSection!).getByText("世界书条目")).toBeInTheDocument();
    expect(screen.getByText("尚未保存")).toBeInTheDocument();
    expect(within(previewSection!).getByText("1 条 · 导入后全部禁用")).toBeInTheDocument();
    expect(
      within(previewSection!).getByText(
        "角色卡包含扩展数据，请在确认导入前检查。",
      ),
    ).toBeInTheDocument();
  });

  it("confirms an import and adds the saved character to the library", async () => {
    const fetchMock = vi.fn().mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        if (url === "/api/health") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                status: "ok",
                service: "mycompanion-local-service",
                version: "0.1.0",
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          );
        }
        if (url === "/api/characters" && !init?.method) {
          return Promise.resolve(
            new Response(JSON.stringify({ items: [], total: 0 }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        if (url.endsWith("/preview")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                format: "ccv2-json",
                specVersion: "2.0",
                name: "Aster",
                descriptionPreview: "A cartographer.",
                firstMessagePreview: "Welcome.",
                creator: "MyCompanion",
                characterVersion: "1.0",
                tags: ["original"],
                alternateGreetingsCount: 0,
                groupOnlyGreetingsCount: 0,
                lorebookEntryCount: 1,
                regexScriptCount: 1,
                lorebookEntries: [lorebookEntryPreview],
                regexScripts: [regexScriptPreview],
                assetCount: 0,
                extensionKeys: ["regex_scripts"],
                unknownFieldPaths: [],
                warningCodes: ["extensions_present"],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          );
        }
        if (url.endsWith("/commit")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: "00000000-0000-4000-8000-000000000001",
                name: "Aster",
                description: "A cartographer.",
                personality: "Curious.",
                scenario: "A workshop.",
                firstMessage: "Welcome.",
                alternateGreetings: [],
                alternateGreetingsCount: 0,
                exampleDialogue: "",
                systemPrompt: "Stay in character.",
                postHistoryInstructions: "",
                creatorNotes: "Original fixture.",
                tags: ["original"],
                creator: "MyCompanion",
                characterVersion: "1.0",
                sourceFormat: "ccv2-json",
                sourceVersion: "2.0",
                rawExtensions: { regex_scripts: [] },
                unknownFieldPaths: [],
                regexEnabled: [],
                lorebookEnabled: [],
                lorebookEntryCount: 1,
                regexScriptCount: 1,
                lorebookEntries: [lorebookEntryPreview],
                regexScripts: [regexScriptPreview],
                deletedAt: null,
                createdAt: "2026-09-17T00:00:00.000Z",
                updatedAt: "2026-09-17T00:00:00.000Z",
              }),
              { status: 201, headers: { "Content-Type": "application/json" } },
            ),
          );
        }
        return Promise.reject(new Error(`Unexpected request: ${url}`));
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    const file = new File(
      [JSON.stringify({ spec: "chara_card_v2" })],
      "aster.json",
      { type: "application/json" },
    );
    fireEvent.change(screen.getByLabelText("选择角色卡文件"), {
      target: { files: [file] },
    });

    fireEvent.click(await screen.findByRole("button", { name: "确认导入" }));

    expect(
      await screen.findByText("“Aster”已保存，可以从角色列表继续使用。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Aster" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "导出 JSON" })).toHaveAttribute(
      "href",
      "/api/characters/00000000-0000-4000-8000-000000000001/export?format=json",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/characters/import/commit",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
