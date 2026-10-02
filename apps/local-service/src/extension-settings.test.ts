import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { backupChecksum } from "./backup.js";

describe("persistent extension settings", () => {
  it("merges queued browser patches without replacing concurrent native globals",async()=>{
    const app=buildApp();
    try{
      const base={variables:{global:{counter:0}},untouched:true};
      await app.inject({method:"PUT",url:"/api/extensions/settings",payload:{extensionSettings:{...base,variables:{global:{counter:1}}}}});
      const next={...base,theme:"dark"};
      const result=await app.inject({method:"PUT",url:"/api/extensions/settings",payload:{extensionSettings:next,patches:[{base,next}]}});
      expect(result.statusCode,result.body).toBe(200);
      expect((await app.inject({method:"GET",url:"/api/extensions/settings"})).json().extensionSettings).toEqual({variables:{global:{counter:1}},untouched:true,theme:"dark"});
    }finally{await app.close();}
  });
  it("preserves arbitrary nested settings across a full database reopen", async () => {
    const databasePath = join(tmpdir(), `mycompanion-extension-settings-${randomUUID()}.sqlite`);
    let app = buildApp({ databasePath });
    try {
      const settings = { variables: { global: { name: "玩家", flags: [true, false, null] } }, tavern_helper: { script: "export const answer = 42", nested: { enabled: false } }, future_field: { unknown: [1, "2", {}] } };
      expect((await app.inject({ method: "GET", url: "/api/extensions/settings" })).json()).toEqual({ extensionSettings: { variables: { global: {} } } });
      expect((await app.inject({ method: "PUT", url: "/api/extensions/settings", payload: { extensionSettings: settings } })).statusCode).toBe(200);
      await app.close();
      app = buildApp({ databasePath });
      const response = await app.inject({ method: "GET", url: "/api/extensions/settings" });
      expect(response.json()).toEqual({ extensionSettings: settings });
      expect(response.headers["cache-control"]).toBe("no-store");
      for (const invalid of [null, [], "bad"]) {
        expect((await app.inject({ method: "PUT", url: "/api/extensions/settings", payload: { extensionSettings: invalid } })).statusCode).toBe(400);
      }
      expect((await app.inject({ method: "GET", url: "/api/extensions/settings" })).json()).toEqual({ extensionSettings: settings });
    } finally {
      await app.close();
      for (const suffix of ["", "-shm", "-wal"]) rmSync(databasePath + suffix, { force: true });
    }
  });

  it("backs up settings, restores into empty profiles and honors skip/overwrite", async () => {
    const source = buildApp(), target = buildApp();
    try {
      const settings = { fixture: { scripts: ["hello"], disabled: false } };
      await source.inject({ method: "PUT", url: "/api/extensions/settings", payload: { extensionSettings: settings } });
      const backup = (await source.inject({ method: "GET", url: "/api/backup" })).json();
      expect(backup.extensionSettings).toEqual(settings);
      const restore = (strategy: string) => target.inject({ method: "POST", url: "/api/backup/restore", payload: { backup, strategy } });
      const preview = (strategy: string) => target.inject({ method: "POST", url: "/api/backup/restore/preview", payload: { backup, strategy } });
      const read = async () => (await target.inject({ method: "GET", url: "/api/extensions/settings" })).json().extensionSettings;
      expect((await preview("skip")).json().sections.extensionSettings.new).toBe(1);
      expect((await restore("skip")).json().applied.extensionSettings).toBe(1);
      expect(await read()).toEqual(settings);
      await target.inject({ method: "PUT", url: "/api/extensions/settings", payload: { extensionSettings: { current: true } } });
      expect((await preview("skip")).json().sections.extensionSettings.skip).toBe(1);
      expect((await restore("skip")).json().skipped.extensionSettings).toBe(1);
      expect(await read()).toEqual({ current: true });
      expect((await preview("overwrite")).json().sections.extensionSettings.overwrite).toBe(1);
      expect((await restore("overwrite")).json().applied.extensionSettings).toBe(1);
      expect(await read()).toEqual(settings);
    } finally { await source.close(); await target.close(); }
  });

  it("keeps legacy backup checksums valid and never resets settings when the field is absent", async () => {
    const app = buildApp();
    try {
      const backup = (await app.inject({ method: "GET", url: "/api/backup" })).json();
      delete backup.extensionSettings;
      backup.manifest.checksum = backupChecksum(backup);
      await app.inject({ method: "PUT", url: "/api/extensions/settings", payload: { extensionSettings: { keep: true } } });
      expect((await app.inject({ method: "POST", url: "/api/backup/restore", payload: { backup, strategy: "overwrite" } })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/extensions/settings" })).json().extensionSettings).toEqual({ keep: true });
      backup.extensionSettings = { tampered: true };
      expect((await app.inject({ method: "POST", url: "/api/backup/restore", payload: { backup, strategy: "overwrite" } })).statusCode).toBe(422);
    } finally { await app.close(); }
  });
});
