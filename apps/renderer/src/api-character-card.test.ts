import { afterEach, expect, it, vi } from "vitest";
import { previewCharacterCard, commitCharacterCard, characterExportUrl, checkCharacterExport } from "./api";

afterEach(() => vi.unstubAllGlobals());
const preview = { name: "Asset card", format: "ccv3-charx", specVersion: "3.0", descriptionPreview: "", firstMessagePreview: "", creator: "", characterVersion: "", tags: [], alternateGreetingsCount: 0, groupOnlyGreetingsCount: 0, lorebookEntryCount: 0, regexScriptCount: 0, lorebookEntries: [], regexScripts: [], assetCount: 1, importedAssetCount: 2, extensionKeys: [], unknownFieldPaths: [], compatibilityDefaultPaths: [], warningCodes: [] };
const detail = { avatar: "asset-card.png", id: "358fdf81-b271-44f6-b0b2-4b83c44a1df4", name: "Asset card", description: "", tags: [], sourceFormat: "ccv3-charx", sourceVersion: "3.0", alternateGreetingsCount: 0, lorebookEntryCount: 0, regexScriptCount: 0, deletedAt: null, createdAt: "2026-10-02T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z", personality: "", scenario: "", firstMessage: "", alternateGreetings: [], exampleDialogue: "", systemPrompt: "", postHistoryInstructions: "", creatorNotes: "", creator: "", characterVersion: "", rawExtensions: {}, unknownFieldPaths: [], lorebookEntries: [], regexScripts: [], regexEnabled: [], lorebookEnabled: [] };
// jsdom lacks Blob.arrayBuffer; supply its native browser contract without parsing ZIP.
const file = (bytes: number[], name: string) => {
  const content = Uint8Array.from(bytes), value = new File([content], name);
  Object.defineProperties(value, { arrayBuffer: { value: async () => content.buffer }, text: { value: async () => new TextDecoder().decode(content) }, slice: { value: (start: number, end: number) => ({ arrayBuffer: async () => content.slice(start, end).buffer }) } });
  return value;
};
const request = (payload: unknown = preview) => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock); return fetchMock;
};

it.each([[[80, 75, 3, 4, 0, 0], "card.charx"], [[255, 216, 255, 224, 9, 10, 80, 75, 3, 4, 0], "card.jpeg"]] as const)("sends actual ZIP bytes and JPEG-prefixed ZIP as CHARX with their original filename", async (bytes, name) => {
  const fetchMock = request(), value = file([...bytes], name), parsed = await previewCharacterCard(value);
  expect(parsed.importedAssetCount).toBe(2); expect(fetchMock).toHaveBeenCalledWith("/api/characters/import/preview", expect.objectContaining({ body: value, headers: expect.objectContaining({ "Content-Type": "application/charx", "X-Character-Filename": encodeURIComponent(name) }) }));
});

it("rejects an ordinary JPEG without uploading it as a role card", async () => {
  const fetchMock = request(); await expect(previewCharacterCard(file([255, 216, 255, 224, 1, 2, 3], "portrait.jpg"))).rejects.toThrow("没有检测到 CHARX 数据"); expect(fetchMock).not.toHaveBeenCalled();
});

it("identifies a real PNG by its signature even when its filename is JPEG", async () => {
  const fetchMock = request({ ...preview, format: "ccv3-png" }), value = file([137, 80, 78, 71, 13, 10, 26, 10, 80, 75, 3, 4], "renamed.jpg");
  await previewCharacterCard(value); expect(fetchMock).toHaveBeenCalledWith("/api/characters/import/preview", expect.objectContaining({ body: value, headers: expect.objectContaining({ "Content-Type": "image/png" }) }));
});

it("keeps CHARX binary content, replacement identity and submission key intact on commit", async () => {
  const fetchMock = request(detail), value = file([80, 75, 3, 4], "source.charx");
  await commitCharacterCard(value, "retry-key", undefined, { mode: "replace", targetId: detail.id, expectedUpdatedAt: detail.updatedAt });
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(new URL(url, "http://localhost").searchParams.get("targetId")).toBe(detail.id); expect(init.body).toBe(value); expect(init.headers).toMatchObject({ "Content-Type": "application/charx", "Idempotency-Key": "retry-key" });
});

it("provides CHARX export and compatibility-check requests", async () => {
  const fetchMock = request({ characterId: detail.id, warnings: [] });
  expect(characterExportUrl(detail.id, "charx")).toBe(`/api/characters/${detail.id}/export?format=charx`); await checkCharacterExport(detail.id, "charx");
  expect(fetchMock).toHaveBeenCalledWith(`/api/characters/${detail.id}/export/check`, expect.objectContaining({ body: JSON.stringify({ format: "charx" }) }));
});

it("keeps a BYAF archive binary and exposes the actual imported scenario count", async () => {
  const fetchMock = request({ ...preview, format: "backyard-byaf", importedScenarioCount: 2 }), value = file([80, 75, 3, 4], "with-stories.byaf");
  const result = await previewCharacterCard(value);
  expect(result.importedScenarioCount).toBe(2);
  expect(fetchMock).toHaveBeenCalledWith("/api/characters/import/preview", expect.objectContaining({ body: value,
    headers: expect.objectContaining({ "Content-Type": "application/byaf", "X-Character-Filename": value.name }) }));
});

it.each(["legacy.yaml", "legacy.YML"])("sends YAML source intact so the backend can validate and convert it (%s)", async name => {
  const source = "name: '旧角色'\ndescription: |\n  保留换行\n  和未知字段\ncustom: retained\n";
  const fetchMock = request({ ...preview, format: "tavern-yaml", specVersion: "2.0", warningCodes: ["legacy_format_converted"] });
  const value = file([...new TextEncoder().encode(source)], name);
  const result = await previewCharacterCard(value);
  expect(result.warningCodes).toContain("legacy_format_converted");
  expect(fetchMock).toHaveBeenCalledWith("/api/characters/import/preview", expect.objectContaining({
    body: JSON.stringify({ filename: name, card: source }), headers: expect.objectContaining({ "Content-Type": "application/json" }),
  }));
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ...detail, sourceFormat: "tavern-yaml" }), { status: 201 }));
  await commitCharacterCard(value, "yaml-retry-key");
  expect(fetchMock).toHaveBeenLastCalledWith("/api/characters/import/commit", expect.objectContaining({ body: JSON.stringify({ filename: name, card: source }) }));
});
