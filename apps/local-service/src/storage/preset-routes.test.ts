import { afterEach, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { PRESET_STORAGE_KEY } from "./preset-routes.js";
const apps: ReturnType<typeof buildApp>[] = [];
function fixture() {
  const app = buildApp(); apps.push(app);
  const post = (path: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/presets/" + path, payload: { apiId: "openai", ...payload } });
  const list = async () => (await app.inject({ method: "GET", url: "/api/presets/openai" })).json().entries;
  return { app, post, list };
}
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
it("persists, replaces and deletes preset data including unknown prompt and extension fields", async () => {
  const { post, list } = fixture();
  const preset = { temperature: 0.3, prompts: [{ identifier: "custom", content: "text", future: 17 }], extensions: { regex_scripts: [{ scriptName: "rule" }] }, unknown: { nested: true } };
  expect((await post("save", { name: " 测试预设 ", preset })).json()).toEqual({ name: "测试预设" });
  expect(await list()).toEqual([{ name: "测试预设", preset }]);
  await post("save", { name: "测试预设", preset: { ...preset, temperature: 1.1 } });
  expect(await list()).toHaveLength(1);
  expect((await list())[0].preset.temperature).toBe(1.1);
  expect((await post("delete", { name: "测试预设" })).statusCode).toBe(200);
  expect(await list()).toEqual([]);
  expect((await post("delete", { name: "测试预设" })).statusCode).toBe(404);
});
it("an older general settings snapshot cannot overwrite presets and preset writes retain extension data", async () => {
  const { app, post, list } = fixture();
  await post("save", { name: "retained", preset: { temperature: 1 } });
  await app.inject({ method: "PUT", url: "/api/extensions/settings", payload: { extensionSettings: { [PRESET_STORAGE_KEY]: [], custom: { counter: 8 } } } });
  expect(await list()).toHaveLength(1);
  await post("save", { name: "second", preset: { temperature: 0.4 } });
  expect((await app.inject({ method: "GET", url: "/api/extensions/settings" })).json().extensionSettings.custom).toEqual({ counter: 8 });
});
it.each([{patches:[]}, {patches:[{base:{},next:{}}]}])("unchanged settings patches preserve all preset files: %j", async ({patches}) => {
  const {app,post,list}=fixture();
  const preset={extensions:{tavern_helper:{variables:{owner:"A"},scripts:[{id:"persisted"}]}}};
  await post("save",{name:"retained",preset});
  const response=await app.inject({method:"PUT",url:"/api/extensions/settings",payload:{extensionSettings:{},patches}});
  expect(response.statusCode,response.body).toBe(200);
  expect(await list()).toEqual([{name:"retained",preset}]);
});
it("rename rejects collisions without deleting either preset and saves a new snapshot atomically", async () => {
  const { post, list } = fixture();
  await post("save", { name: "first", preset: { temperature: 1 } });
  await post("save", { name: "second", preset: { temperature: 0 } });
  expect((await post("rename", { name: "first", newName: "SECOND", preset: {} })).statusCode).toBe(409);
  expect((await list()).map((entry: {name: string}) => entry.name)).toEqual(["first", "second"]);
  expect((await post("rename", { name: "first", newName: "renamed", preset: { temperature: 0.7 } })).statusCode).toBe(200);
  expect((await list())[0]).toEqual({ name: "renamed", preset: { temperature: 0.7 } });
});
it("validates documents and reports unbundled defaults without inventing upstream presets", async () => {
  const { post, list } = fixture();
  for (const body of [{ name: "   ", preset: {} }, { name: "x", preset: [] }, { name: "x", preset: null }, { name: "x", preset: {}, apiId: "novel" }]) expect((await post("save", body)).statusCode).toBe(400);
  expect(await list()).toEqual([]);
  expect((await post("restore", { name: "Default" })).json()).toEqual({ isDefault: false, preset: {} });
  await post("save", { name: "__proto__", preset: { temperature: 0.5 } });
  expect((await list())[0].name).toBe("__proto__");
});
it("presets round trip through the existing full backup and restore domain", async () => {
  const { app, post } = fixture(); const destination = fixture();
  await post("save", { name: "backup", preset: { prompts: [{ identifier: "hello" }] } });
  const exported = await app.inject({ method: "GET", url: "/api/backup" });
  expect(exported.statusCode, exported.body).toBe(200);
  const backup = exported.json();
  const restored = await destination.app.inject({ method: "POST", url: "/api/backup/restore", payload: { backup, strategy: "overwrite" } });
  expect(restored.statusCode, restored.body).toBe(200);
  expect(await destination.list()).toEqual([{ name: "backup", preset: { prompts: [{ identifier: "hello" }] } }]);
});
