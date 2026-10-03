import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { compatibilityRuntimeSource } from "./plugin-runtime-host.js";

const opened: ReturnType<typeof buildApp>[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map(app => app.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9rS3lGQAAAABJRU5ErkJggg==", "base64");
function form(id: string, bytes = png): Buffer {
  return Buffer.concat([
    Buffer.from(`--avatar-boundary\r\nContent-Disposition: form-data; name="avatar"; filename="${id}"\r\nContent-Type: image/png\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--avatar-boundary\r\nContent-Disposition: form-data; name="overwrite_name"\r\n\r\n${id}\r\n--avatar-boundary--\r\n`),
  ]);
}

it("persists uploaded persona avatars and serves them through the Tavern path after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mc-persona-")); directories.push(directory);
  const databasePath = join(directory, "profile.sqlite");
  let app = buildApp({ databasePath }); opened.push(app);
  const upload = await app.inject({ method: "POST", url: "/api/avatars/upload", headers: { "content-type": "multipart/form-data; boundary=avatar-boundary" }, payload: form("Reader.png") });
  expect(upload.statusCode, upload.body).toBe(200);
  expect(upload.json()).toEqual({ path: "Reader.png" });
  expect((await app.inject({ method: "POST", url: "/api/avatars/get" })).json()).toEqual(["Reader.png"]);
  const picture = await app.inject({ method: "GET", url: "/User%20Avatars/Reader.png" });
  expect(picture.statusCode, picture.body).toBe(200);
  expect(picture.headers["content-type"]).toContain("image/png");
  expect(picture.rawPayload.equals(png)).toBe(true);
  await app.close(); opened.splice(opened.indexOf(app), 1);
  app = buildApp({ databasePath }); opened.push(app);
  expect((await app.inject({ method: "POST", url: "/api/avatars/get" })).json()).toEqual(["Reader.png"]);
  expect((await app.inject({ method: "POST", url: "/api/avatars/delete", payload: { avatar: "Reader.png" } })).json()).toEqual({ result: "ok" });
  expect((await app.inject({ method: "GET", url: "/User%20Avatars/Reader.png" })).statusCode).toBe(404);
});

it("lets the served getRequestHeaders contract preserve the real FormData boundary for persona creation and replacement", async () => {
  const served = compatibilityRuntimeSource.replace(/^import .*;\r?\n/gm, "")
    .replace(/^export \{.*\}(?: from .*?)?;\r?\n/gm, "").replace(/^export /gm, "");
  const { getRequestHeaders } = runInNewContext(served + "\n({getRequestHeaders})", {
    extension_settings:{},bindChatContext:()=>{},variableRuntime:{},MacrosParser:{},
    saveSettings:()=>{},saveSettingsDebounced:()=>{},saveChatConditional:()=>{},saveMetadata:()=>{},saveMetadataDebounced:()=>{},
    substituteParams:(value:string)=>value,substituteParamsExtended:(value:string)=>value,
    onExtensionSettingsSaved:()=>()=>{},window:new EventTarget(),console,
  });
  const app = buildApp(); opened.push(app);
  const origin = await app.listen({host:"127.0.0.1",port:0});
  const upload = async (bytes:Buffer) => {
    const body = new FormData();
    body.append("avatar", new Blob([new Uint8Array(bytes)], {type:"image/png"}), "Actual-Reader.png");
    body.append("overwrite_name", "Actual-Reader.png");
    return fetch(origin + "/api/avatars/upload", {method:"POST",headers:getRequestHeaders({omitContentType:true}),body});
  };
  const created = await upload(png);
  expect(created.status, await created.clone().text()).toBe(200);
  expect(await created.json()).toEqual({path:"Actual-Reader.png"});
  expect(Buffer.from(await (await fetch(origin + "/User%20Avatars/Actual-Reader.png")).arrayBuffer())).toEqual(png);
  const replacement = Buffer.concat([png,Buffer.from("REPLACED")]);
  const replaced = await upload(replacement);
  expect(replaced.status,await replaced.text()).toBe(200);
  expect(Buffer.from(await (await fetch(origin + "/User%20Avatars/Actual-Reader.png")).arrayBuffer())).toEqual(replacement);
  const deleted = await fetch(origin + "/api/avatars/delete", {
    method:"POST",headers:getRequestHeaders(),body:JSON.stringify({avatar:"Actual-Reader.png"}),
  });
  expect(deleted.status,await deleted.text()).toBe(200);
  expect((await fetch(origin + "/User%20Avatars/Actual-Reader.png")).status).toBe(404);
});

it("rejects invalid avatar names and non-image bytes without storing them", async () => {
  const app = buildApp(); opened.push(app);
  const headers = { "content-type": "multipart/form-data; boundary=avatar-boundary" };
  expect((await app.inject({ method: "POST", url: "/api/avatars/upload", headers, payload: form("bad.png", Buffer.from("script")) })).statusCode).toBe(400);
  expect((await app.inject({ method: "POST", url: "/api/avatars/upload", headers, payload: form("..png") })).statusCode).toBe(400);
  expect((await app.inject({ method: "POST", url: "/api/avatars/get" })).json()).toEqual([]);
});

it("includes persona avatar bytes in backup and restores them with the matching settings", async () => {
  const source = buildApp(); opened.push(source);
  const headers = { "content-type": "multipart/form-data; boundary=avatar-boundary" };
  expect((await source.inject({ method: "POST", url: "/api/avatars/upload", headers, payload: form("Archivist.png") })).statusCode).toBe(200);
  const settings = { __mycompanion_power_user: { __selected_persona: "Archivist.png", personas: { "Archivist.png": "Archivist" } } };
  expect((await source.inject({ method: "PUT", url: "/api/extensions/settings", payload: { extensionSettings: settings } })).statusCode).toBe(200);
  const backup = (await source.inject({ method: "GET", url: "/api/backup" })).json();
  expect(backup.userAvatars).toEqual([{ avatarId: "Archivist.png", bytesBase64: png.toString("base64") }]);
  const destination = buildApp(); opened.push(destination);
  const restored = await destination.inject({ method: "POST", url: "/api/backup/restore", payload: { backup, strategy: "overwrite" } });
  expect(restored.statusCode, restored.body).toBe(200);
  expect(restored.json().applied.userAvatars).toBe(1);
  expect((await destination.inject({ method: "GET", url: "/User%20Avatars/Archivist.png" })).rawPayload.equals(png)).toBe(true);
  expect((await destination.inject({ method: "GET", url: "/api/extensions/settings" })).json().extensionSettings).toEqual(settings);
});
